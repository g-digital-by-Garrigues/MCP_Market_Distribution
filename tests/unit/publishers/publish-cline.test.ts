import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { publishCline } from '../../../src/publishers/publish-cline.js';
import type { ExecFn } from '../../../src/publishers/file-marketplace-issue.js';

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

const TEMPLATE = `# {{mcp_name}}\n\n![logo]({{logo_url}})\n\nrun {{pipeline_run_id}}\n`;

async function withRepoRoot(body: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-test-'));
  const config = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps: {
      'ead-factory': {
        reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
        npm_scope: '@g-digital',
        npm_package_name: '@g-digital/mcp-ead-factory',
        docker_image_name: 'gdigital/ead-factory',
        n8n_adapter_target_name: 'n8n-node-ead-factory',
        license: 'MIT',
        credential_help_url: 'https://example.com',
        target_overrides: {},
        track_a_targets: 'default',
        track_b_targets: ['n8n'],
        logo_path: 'assets/logo.png',
      },
    },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(config));
  const tplDir = path.join(repoRoot, 'templates', 'store-descriptions');
  await fs.mkdir(tplDir, { recursive: true });
  await fs.writeFile(path.join(tplDir, 'cline-issue.hbs'), TEMPLATE);
  await fs.mkdir(path.join(repoRoot, 'pending-to-publish', 'ead-factory'), { recursive: true });
  try {
    await body(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe('publishCline', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it('idempotency: existing open issue with matching title → status=skipped', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 12, title: '[io.github.g-digital-by-Garrigues/ead-factory] ead-factory', url: 'https://github.com/cline/mcp-marketplace/issues/12' }]),
          };
        }
        return { exitCode: 1, stderr: 'should not be called' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' } },
      );
      expect(result.status).toBe('skipped');
      expect(result.target_url).toBe('https://github.com/cline/mcp-marketplace/issues/12');
      expect(result.target).toBe('cline');
      expect(calls).toHaveLength(1);
    });
  });

  it('happy path: no existing issue → gh issue create returns URL → status=succeeded', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/cline/mcp-marketplace/issues/77\n' };
        }
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' }, sleep: async () => {} },
      );
      expect(result.status).toBe('succeeded');
      expect(result.target_url).toBe('https://github.com/cline/mcp-marketplace/issues/77');
      // Verify the issue create call carries the title pattern.
      const create = calls.find((c) => c.args[1] === 'create');
      expect(create?.args).toContain('--title');
      expect(create?.args).toContain('[io.github.g-digital-by-Garrigues/ead-factory] ead-factory');
    });
  });

  it('403 rate limit → status=failed with rate-limit reset remediation', async () => {
    await withRepoRoot(async (repoRoot) => {
      let createAttempts = 0;
      const { exec } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          createAttempts += 1;
          return { exitCode: 1, stderr: 'HTTP 403: API rate limit exceeded for user' };
        }
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' }, sleep: async () => {} },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.cause).toBe('GitHub rate limit on bot account.');
      expect(result.error?.action).toContain('47 minutes');
      // 403 is classified transient here → retried (gets attempts > 1).
      expect(createAttempts).toBeGreaterThan(1);
    });
  });

  it('missing BOT_PAT → status=failed before any gh call', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(() => ({ exitCode: 1, stderr: 'unreachable' }));
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: {} },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.action).toContain('BOT_PAT');
      expect(calls).toEqual([]);
    });
  });

  it('dry_run: search runs (idempotency check) but issue create is skipped', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ args }) => {
        if (args[0] === 'issue' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        return { exitCode: 1, stderr: 'should not be called in dry_run' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: true, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' } },
      );
      expect(result.status).toBe('succeeded');
      expect(result.dry_run).toBe(true);
      expect(result.target_url).toContain('https://example.invalid/dry-run/cline/');
      expect(calls).toHaveLength(1);
    });
  });
});
