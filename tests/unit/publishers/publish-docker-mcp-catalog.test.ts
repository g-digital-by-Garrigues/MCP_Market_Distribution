import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publishDockerMcpCatalog } from '../../../src/publishers/publish-docker-mcp-catalog.js';
import type { ExecFn } from '../../../src/publishers/publish-docker-mcp-catalog.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface FakeExec {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: readonly string[] }>;
}

function fakeExec(
  responses: (call: { cmd: string; args: readonly string[]; idx: number }) => { exitCode: number; stdout?: string; stderr?: string },
): FakeExec {
  const calls: FakeExec['calls'] = [];
  const exec: ExecFn = async (cmd, args) => {
    const idx = calls.length;
    calls.push({ cmd, args });
    const r = responses({ cmd, args, idx });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { exec, calls };
}

const TEMPLATES = {
  'server.yaml.hbs': 'name: {{mcp_name}}\nimage: {{docker_image_name}}:{{version}}\n',
  'tools.json.hbs': '{"tools": []}\n',
  'readme.md.hbs': '# {{mcp_name}}\n',
};

interface RepoRootOverrides {
  /** Omit `tools` from the .distribution.yaml to test the empty-tools gate. */
  omitTools?: boolean;
  /** Omit the env vars in server.json to test the empty-envvars gate. */
  omitEnvVars?: boolean;
  /** Blank out the description on these env vars to test the empty-description gate. */
  blankDescriptionsFor?: string[];
}

async function withRepoRoot(
  body: (repoRoot: string) => Promise<void>,
  overrides: RepoRootOverrides = {},
): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-catalog-test-'));
  const distributionOverrides: Record<string, unknown> = {};
  if (!overrides.omitTools) {
    distributionOverrides.tools = [
      { name: 'do_thing', description: 'Does the thing.' },
      { name: 'undo_thing', description: 'Undoes the thing.' },
    ];
  }
  await writeTestConfig({ repoRoot, distributionOverrides });
  const tplDir = path.join(repoRoot, 'templates', 'store-descriptions', 'docker-mcp-catalog');
  await fs.mkdir(tplDir, { recursive: true });
  for (const [name, content] of Object.entries(TEMPLATES)) {
    await fs.writeFile(path.join(tplDir, name), content);
  }
  const pendingDir = path.join(repoRoot, 'pending-to-publish', 'ead-factory');
  await fs.mkdir(pendingDir, { recursive: true });
  // server.json is the canonical source for env-var descriptions consumed
  // by the docker-mcp-catalog publisher (it used to read .env.example, but
  // that landed garbage descriptions in PR #3511 — see publisher comment).
  const envVarsForServerJson = overrides.omitEnvVars
    ? []
    : [
        {
          name: 'API_BASE_URL',
          description: (overrides.blankDescriptionsFor ?? []).includes('API_BASE_URL')
            ? ''
            : 'Evidence Manager API base URL.',
          isRequired: true,
          isSecret: false,
        },
        {
          name: 'OKTA_CLIENT_SECRET',
          description: (overrides.blankDescriptionsFor ?? []).includes('OKTA_CLIENT_SECRET')
            ? ''
            : 'Okta client secret.',
          isRequired: true,
          isSecret: true,
        },
      ];
  await fs.writeFile(
    path.join(pendingDir, 'server.json'),
    JSON.stringify(
      {
        name: 'io.github.g-digital-by-Garrigues/ead-factory',
        description: 'EAD Factory MCP — Digital Trust services APIs for your agents.',
        version: '1.0.0',
        packages: [{ environmentVariables: envVarsForServerJson }],
      },
      null,
      2,
    ),
  );
  try {
    await body(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe('publishDockerMcpCatalog', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it('idempotency: existing PR with matching title → status="skipped", no fork/branch/PR ops', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 42, title: '[MCP] add ead-factory v1.0.0', url: 'https://github.com/docker/mcp-registry/pull/42' }]),
          };
        }
        return { exitCode: 1, stderr: 'should not be called' };
      });
      const result = await publishDockerMcpCatalog(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' } },
      );
      expect(result.status).toBe('skipped');
      expect(result.target_url).toBe('https://github.com/docker/mcp-registry/pull/42');
      expect(calls).toHaveLength(1); // only gh pr list
    });
  });

  it('missing BOT_PAT → status="failed" before any gh call', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(() => ({ exitCode: 1, stderr: 'unreachable' }));
      const result = await publishDockerMcpCatalog(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: {} },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.action).toContain('Add BOT_PAT');
      expect(calls).toEqual([]);
    });
  });

  it('dry_run with no existing PR → status="succeeded" with placeholder, no fork/clone/push', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ args }) => {
        if (args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        return { exitCode: 1, stderr: 'should not be called' };
      });
      const result = await publishDockerMcpCatalog(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: true, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' } },
      );
      expect(result.status).toBe('succeeded');
      expect(result.dry_run).toBe(true);
      expect(result.target_url).toContain('https://example.invalid/dry-run/docker-mcp-catalog/');
      // Only the search call happened.
      expect(calls).toHaveLength(1);
    });
  });

  it('happy path: search empty → fork → user → clone → commit → push → pr create → status=succeeded', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'fork') return { exitCode: 0 };
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'user') return { exitCode: 0, stdout: 'g-digital-bot\n' };
        if (cmd === 'git' && args[0] === 'clone') return { exitCode: 0 };
        if (cmd === 'git') return { exitCode: 0 };
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/docker/mcp-registry/pull/777\n' };
        }
        return { exitCode: 1, stderr: `unexpected: ${cmd} ${args.join(' ')}` };
      });
      const result = await publishDockerMcpCatalog(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' }, sleep: async () => {} },
      );
      expect(result.status).toBe('succeeded');
      expect(result.target_url).toBe('https://github.com/docker/mcp-registry/pull/777');
      // Verify pr create was invoked with the canonical title.
      const prCreate = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
      expect(prCreate?.args).toContain('--title');
      expect(prCreate?.args).toContain('[MCP] add ead-factory v1.0.0');
    });
  });

  it('gh pr create returns 403 → status=failed with PAT-scope remediation', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        if (cmd === 'gh' && args[0] === 'repo') return { exitCode: 0 };
        if (cmd === 'gh' && args[0] === 'api') return { exitCode: 0, stdout: 'g-digital-bot' };
        if (cmd === 'git') return { exitCode: 0 };
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
          return { exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration' };
        }
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishDockerMcpCatalog(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' }, sleep: async () => {} },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.cause).toContain('Bot PAT lacks public-repo issues permission');
      expect(result.error?.action).toContain('public_repo');
    });
  });

  // Metadata-quality gate (added after PR #3511 against docker/mcp-registry
  // shipped half-baked metadata — empty env-var descriptions and tools=[]).
  // The publisher must refuse to open a catalog PR before fork/clone/push if
  // the submission would look uncurated to a Docker reviewer.

  it('metadata gate: empty tools[] in .distribution.yaml → status=failed before any fork/clone/push', async () => {
    await withRepoRoot(
      async (repoRoot) => {
        const { exec, calls } = fakeExec(({ args }) => {
          if (args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
          return { exitCode: 1, stderr: 'should not be called' };
        });
        const result = await publishDockerMcpCatalog(
          { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
          { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' } },
        );
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('empty tools[]');
        expect(result.error?.action).toContain('.distribution.yaml');
        // Only the idempotency search call should have happened.
        expect(calls.filter((c) => c.cmd === 'gh' && c.args[1] === 'fork')).toHaveLength(0);
        expect(calls.filter((c) => c.cmd === 'git' && c.args[0] === 'clone')).toHaveLength(0);
      },
      { omitTools: true },
    );
  });

  it('metadata gate: any env var with empty description in server.json → status=failed', async () => {
    await withRepoRoot(
      async (repoRoot) => {
        const { exec } = fakeExec(({ args }) => {
          if (args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
          return { exitCode: 1, stderr: 'should not be called' };
        });
        const result = await publishDockerMcpCatalog(
          { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
          { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' } },
        );
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('API_BASE_URL');
        expect(result.error?.action).toContain('server.json');
      },
      { blankDescriptionsFor: ['API_BASE_URL'] },
    );
  });

  it('metadata gate: server.json with no environmentVariables → status=failed', async () => {
    await withRepoRoot(
      async (repoRoot) => {
        const { exec } = fakeExec(({ args }) => {
          if (args[0] === 'pr' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
          return { exitCode: 1, stderr: 'should not be called' };
        });
        const result = await publishDockerMcpCatalog(
          { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r1', dry_run: false, repo_root: repoRoot },
          { exec, logger: silentLogger, env: { BOT_PAT: 'pat_x' } },
        );
        expect(result.status).toBe('failed');
        expect(result.error?.message).toContain('no env vars found');
      },
      { omitEnvVars: true },
    );
  });
});
