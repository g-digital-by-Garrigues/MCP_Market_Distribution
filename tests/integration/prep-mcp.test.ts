import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { prepMcp, PrepMcpError } from '../../src/prep-agent/prep-mcp.js';
import { README_MARKER_INSTALL, README_MARKER_ENV } from '../../src/generators/generate-readme.js';

const MCP_NAME = 'ead-factory';
const VERSION = '1.0.0';

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

  await fs.writeFile(
    path.join(repoRoot, 'mcp-pipeline.yaml'),
    yaml.dump({
      pipeline_version: 1,
      mcp_schema_version: '2025-12-11',
      n8n_node_api_version: '1.0',
      mcps: {
        [MCP_NAME]: {
          reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
          npm_scope: '@g-digital',
          npm_package_name: '@g-digital/mcp-ead-factory',
          docker_image_name: 'gdigital/ead-factory',
          license: 'MIT',
          n8n_adapter_target_name: 'n8n-node-ead-factory',
          credential_help_url: 'https://eadtrust.example.com/onboarding',
          target_overrides: {},
        },
      },
    }),
    'utf8',
  );

  const sourcePkg = {
    name: '@g-digital/mcp-ead-factory',
    version: VERSION,
    description: 'Evidence Manager MCP',
    license: 'MIT',
    mcpName: 'io.github.g-digital-by-Garrigues/ead-factory',
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
});
