import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepMcp, PrepMcpError } from '../../src/prep-agent/prep-mcp.js';
import { fileURLToPath } from 'node:url';
import { README_MARKER_INSTALL, README_MARKER_ENV } from '../../src/generators/generate-readme.js';
import { writeTestConfig } from '../helpers/write-test-config.js';

const MCP_NAME = 'ead-factory';
const VERSION = '1.0.0';
const REVERSE_DNS = 'io.github.g-digital-by-Garrigues/ead-factory';

interface Fixture {
  repoRoot: string;
  mcpFolder: string;
}

async function makeFixture(): Promise<Fixture> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-mcp-'));
  const mcpFolder = path.join(repoRoot, 'pending-to-publish', MCP_NAME);
  await fs.mkdir(mcpFolder, { recursive: true });
  await fs.mkdir(path.join(mcpFolder, '.claude', 'commands'), { recursive: true });

  const run = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`);
    }
  };
  run(['init', '--initial-branch=main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test User']);
  run(['config', 'commit.gpgsign', 'false']);
  run(['config', 'tag.gpgsign', 'false']);

  await writeTestConfig({ repoRoot });

  const sourcePkg = {
    name: '@g-digital/mcp-ead-factory',
    version: VERSION,
    description: 'Evidence Manager MCP',
    license: 'MIT',
    mcpName: REVERSE_DNS,
    repository: { type: 'git', url: 'https://github.com/g-digital-by-Garrigues/ead-factory.git' },
    main: 'index.js',
  };
  await fs.writeFile(path.join(mcpFolder, 'package.json'), JSON.stringify(sourcePkg, null, 2), 'utf8');
  await fs.writeFile(path.join(mcpFolder, 'LICENSE'), 'MIT License\n', 'utf8');
  await fs.writeFile(
    path.join(mcpFolder, '.env.example'),
    '# EADTrust API key\nEADTRUST_API_KEY=\n# HTTP port\nAPP_PORT=3000\n# API base URL\nMCP_API_BASE_URL=\n',
    'utf8',
  );
  // Story 18.5: the emitted source carries a discoverable default for MCP_API_BASE_URL
  // and none for APP_PORT, so one prep-mcp run exercises both branches. Synthetic host
  // only — no product API host belongs in a pipeline fixture (AC6).
  await fs.mkdir(path.join(mcpFolder, 'src', 'tools'), { recursive: true });
  await fs.writeFile(
    path.join(mcpFolder, 'src', 'tools', 'session_login.ts'),
    'const BASE_URL = process.env.MCP_API_BASE_URL ?? "https://api.example.test";\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(mcpFolder, 'README.md'),
    [
      '# Evidence Manager MCP',
      '',
      'Manages legal evidence artifacts.',
      '',
      '## Install',
      '',
      README_MARKER_INSTALL,
      '',
      '## Configuration',
      '',
      README_MARKER_ENV,
      '',
      '## License',
      '',
      'MIT',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(mcpFolder, '.claude', 'commands', 'create-internal-evidence.md'),
    '# create-internal-evidence\n',
    'utf8',
  );

  // Initial commit so HEAD exists for tagging
  spawnSync('git', ['add', '.'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-m', 'initial fixture'], { cwd: repoRoot });

  return { repoRoot, mcpFolder };
}

describe('prepMcp orchestrator (integration)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  });

  it('runs every step in order and writes all artifacts to pending-to-publish/<mcp-name>/', async () => {
    const result = await prepMcp({
      mcpName: MCP_NAME,
      repoRoot: fixture.repoRoot,
    });
    expect(result.mcpName).toBe(MCP_NAME);
    expect(result.version).toBe(VERSION);
    expect(result.tagName).toBe(`v${VERSION}`);
    expect(result.commitSha).not.toBeNull();

    const expectedFiles = [
      'server.json',
      'smithery.yaml',
      'README.md',
      'environmentVariables.json',
      'package.json',
      'install-blocks/claude-desktop.md',
      'install-blocks/vscode.md',
    ];
    for (const rel of expectedFiles) {
      const stat = await fs.stat(path.join(fixture.mcpFolder, rel));
      expect(stat.isFile(), `expected ${rel} to be a file`).toBe(true);
    }

    const writtenPkg = JSON.parse(
      await fs.readFile(path.join(fixture.mcpFolder, 'package.json'), 'utf8'),
    );
    expect(writtenPkg.files).toContain('.claude/commands/**/*.md');

    const serverJson = JSON.parse(
      await fs.readFile(path.join(fixture.mcpFolder, 'server.json'), 'utf8'),
    );
    expect(serverJson.name).toBe('io.github.g-digital-by-Garrigues/ead-factory');
    expect(serverJson.version).toBe(VERSION);

    // Story 18.5 (AC1) — the only test that proves prep-mcp actually scrapes the
    // emitted source and passes the map through: the unit tests cannot see the wiring.
    const claudeDesktopBlock = await fs.readFile(
      path.join(fixture.mcpFolder, 'install-blocks', 'claude-desktop.md'),
      'utf8',
    );
    expect(claudeDesktopBlock).toContain('"MCP_API_BASE_URL": "https://api.example.test"');
    expect(claudeDesktopBlock).toContain('<SET_APP_PORT_HERE>');
    expect(claudeDesktopBlock).not.toMatch(/":\s*""/);
  }, 30_000);

  it('halts at validate-source when a required source element is missing, surfacing a structured error', async () => {
    await fs.rm(path.join(fixture.mcpFolder, '.env.example'));
    let caught: unknown = null;
    try {
      await prepMcp({ mcpName: MCP_NAME, repoRoot: fixture.repoRoot, skipCommit: true, skipTag: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PrepMcpError);
    const e = caught as PrepMcpError;
    expect(e.step).toBe('validate-source');
    expect(e.cause).toContain('.env.example');
    expect(e.action).toMatch(/re-run/);
  });

  it('respects --skip-commit and --skip-tag flags (no commit, no tag created)', async () => {
    const result = await prepMcp({
      mcpName: MCP_NAME,
      repoRoot: fixture.repoRoot,
      skipCommit: true,
      skipTag: true,
    });
    expect(result.commitSha).toBeNull();
    expect(result.tagName).toBeNull();
    const tags = spawnSync('git', ['tag', '-l'], { cwd: fixture.repoRoot })
      .stdout.toString()
      .trim();
    expect(tags).toBe('');
  });

  it('v1.1 layout: commits and tags inside the SOURCE clone, not the pipeline repo', async () => {
    // Under v1.1 each MCP is its own repo, cloned into pending-to-publish/<mcp>.
    // Committing in the pipeline repo would capture only the gitlink pointer and leave
    // every regenerated artifact uncommitted in the clone — the tag would then land on
    // a pipeline commit that publishes nothing, while the source repo that publish.yml
    // clones at v<version> never got the bump. That is what happened during the
    // 2026-07-22 releases and forced --skip-commit plus manual commits.
    const git = (args: string[], cwd: string) =>
      spawnSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    // Turn the MCP folder into its own repo with its own initial commit.
    git(['init', '-q', '-b', 'main'], fixture.mcpFolder);
    git(['config', 'user.email', 'test@example.com'], fixture.mcpFolder);
    git(['config', 'user.name', 'Test'], fixture.mcpFolder);
    git(['add', '.'], fixture.mcpFolder);
    git(['commit', '-q', '-m', 'source repo initial'], fixture.mcpFolder);

    const pipelineHeadBefore = git(['rev-parse', 'HEAD'], fixture.repoRoot).stdout.toString().trim();

    const result = await prepMcp({ mcpName: MCP_NAME, repoRoot: fixture.repoRoot });
    expect(result.commitSha).not.toBeNull();
    expect(result.tagName).toBe(`v${VERSION}`);

    // The commit and the tag are in the source clone…
    expect(git(['rev-parse', 'HEAD'], fixture.mcpFolder).stdout.toString().trim()).toBe(
      result.commitSha,
    );
    expect(git(['tag', '-l'], fixture.mcpFolder).stdout.toString().trim()).toBe(`v${VERSION}`);

    // …and the pipeline repo was left untouched: no new commit, no tag.
    expect(git(['rev-parse', 'HEAD'], fixture.repoRoot).stdout.toString().trim()).toBe(
      pipelineHeadBefore,
    );
    expect(git(['tag', '-l'], fixture.repoRoot).stdout.toString().trim()).toBe('');

    // And the artifacts themselves are committed, not just a pointer.
    const committed = git(
      ['show', '--name-only', '--pretty=format:', 'HEAD'],
      fixture.mcpFolder,
    ).stdout.toString();
    expect(committed).toContain('server.json');
    expect(committed).toContain('smithery.yaml');
  });
});


// Review finding F19 (Epic 18): `prepMcp` wraps the n8n adapter build in a catch-all
// that logs a warning and continues. That is right for a failure to LAUNCH the source
// MCP on a dev box (the MCP artifacts of the bump are already written and valid), and
// wrong for the three hard-fails Epic 18 added — an unmatched auth contract (18.1), a
// miscategorised resource (18.4) and an unparseable release note (18.7) — which are
// the adapter REFUSING a contract it cannot honour. Swallowed, they drop `n8n-node/`
// from the bump with a green exit: the same fail-open shape the epic exists to close.
const PIPELINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MULTI_TOOL_STUB = path.join(PIPELINE_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-multi-tool.mjs');
const RESOURCES_STUB = path.join(PIPELINE_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-resources.mjs');

/** The n8n-http annotations that turn the stub's advertised tools into REST
 *  operations. Without them every tool is a non-REST stub and the build refuses
 *  earlier, for a different reason. */
const MULTI_TOOL_ANNOTATIONS: Record<string, string> = {
  get_widget: '// n8n-http: GET /widgets/{widget_id}',
  list_widgets: '// n8n-http: GET /widgets',
  submit_widget: '// n8n-http: POST /widgets',
};
const RESOURCES_ANNOTATIONS: Record<string, string> = {
  case_file_create: '// n8n-http: POST /case-files',
  evidence_get: '// n8n-http: GET /evidences/{evidenceId}',
  notification_request_status: '// n8n-http: GET /notifications/{notificationRequestId}/status',
  id_verification_video_create: '// n8n-http: POST /id-verifications/video',
  id_verification_list: '// n8n-http: GET /users/{userId}/id-verifications',
  id_verification_contract_url: '// n8n-http: GET /id-verifications/{verificationId}/contract-url',
  signature_participant_create: '// n8n-http: POST /signature-requests/{requestId}/participants',
  signature_request_create: '// n8n-http: POST /signature-requests',
  // The deliberate offender: matches no resource prefix and is not signature-shaped.
  widget_frobnicate: '// n8n-http: POST /widgets/{widget_id}/frobnicate',
};

describe('prepMcp — the n8n adapter\'s hard-fails are not swallowed (F19)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });
  afterEach(async () => {
    await fs.rm(fixture.repoRoot, { recursive: true, force: true });
  });

  /**
   * Make the fixture MCP actually launchable by the adapter's inspector probe.
   *
   * `package.json#bin` may be absolute (`buildN8nNodeSpec` resolves the entry through
   * `resolveMcpEntryRelPath` and only resolves RELATIVE args against the package dir),
   * so the stub stays where its `@modelcontextprotocol/sdk` import resolves instead of
   * being copied into a tmpdir with no node_modules above it.
   */
  async function makeLaunchable(stub: string, annotations: Record<string, string>): Promise<void> {
    const pkgPath = path.join(fixture.mcpFolder, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
    pkg.bin = { 'test-mcp': stub };
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    const toolsDir = path.join(fixture.mcpFolder, 'src', 'tools');
    await fs.mkdir(toolsDir, { recursive: true });
    for (const [tool, header] of Object.entries(annotations)) {
      await fs.writeFile(path.join(toolsDir, `${tool}.ts`), `${header}\nexport {};\n`, 'utf8');
    }
  }

  /** Give the fixture a user-key auth contract so the build gets PAST detectAuthStyle. */
  async function declareUserKey(): Promise<void> {
    await fs.writeFile(
      path.join(fixture.mcpFolder, '.env.example'),
      [
        '# Long-lived user key, exchanged for a session token',
        'MCP_AUTH_USER_KEY=',
        '# API base URL',
        'MCP_API_BASE_URL=',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  const run = () =>
    prepMcp({ mcpName: MCP_NAME, repoRoot: fixture.repoRoot, skipCommit: true, skipTag: true });

  // Story 18.1 / FR61.
  it('FAILS the bump when the emitted contract declares no auth discriminator', async () => {
    // The stock fixture .env.example declares EADTRUST_API_KEY / APP_PORT /
    // MCP_API_BASE_URL — none of the three discriminators detectAuthStyle accepts.
    await makeLaunchable(MULTI_TOOL_STUB, MULTI_TOOL_ANNOTATIONS);
    const err = await run().then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toContain('authentication style');
    // …and the connector tree is NOT silently left out of a green bump.
    await expect(fs.stat(path.join(fixture.mcpFolder, 'n8n-node'))).rejects.toThrow();
  }, 60_000);

  // Story 18.4 / AC5.
  it('FAILS the bump when an operation falls back to the wrong resource', async () => {
    await declareUserKey();
    await makeLaunchable(RESOURCES_STUB, RESOURCES_ANNOTATIONS);
    const err = await run().then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toContain('widget_frobnicate');
  }, 60_000);

  // Story 18.7 / AC5: "the parser throws — never falls back".
  it('FAILS the bump when .github/RELEASE_NOTES.md cannot be parsed', async () => {
    await declareUserKey();
    await makeLaunchable(MULTI_TOOL_STUB, MULTI_TOOL_ANNOTATIONS);
    await fs.mkdir(path.join(fixture.mcpFolder, '.github'), { recursive: true });
    await fs.writeFile(
      path.join(fixture.mcpFolder, '.github', 'RELEASE_NOTES.md'),
      '# v1.0.0\n\n<!-- N8N_UPGRADE -->\nThe span is opened and never closed.\n',
      'utf8',
    );
    const err = await run().then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toContain('N8N_UPGRADE');
  }, 60_000);

  // The reason the catch-all exists, kept: a dev box that cannot START the source MCP
  // (unbuilt dist/, missing deps) still gets its server.json / smithery.yaml / README
  // bump. The stock fixture has no runnable entry point, so this is that case.
  it('still completes the bump when the source MCP cannot be launched', async () => {
    const result = await run();
    expect(result.mcpName).toBe(MCP_NAME);
    await expect(fs.stat(path.join(fixture.mcpFolder, 'server.json'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(fixture.mcpFolder, 'n8n-node'))).rejects.toThrow();
  }, 60_000);
});
