import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepMcp, PrepMcpError } from '../../src/prep-agent/prep-mcp.js';
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
    '# EADTrust API key\nEADTRUST_API_KEY=\n# HTTP port\nAPP_PORT=3000\n',
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
