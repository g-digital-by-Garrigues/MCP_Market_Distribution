import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publishCline } from '../../../src/publishers/publish-cline.js';
import type { ExecFn } from '../../../src/publishers/file-marketplace-issue.js';
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

const TEMPLATE = `# {{mcp_name}}\n\n![logo]({{logo_url}})\n\nrun {{pipeline_run_id}}\n`;

async function withRepoRoot(body: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-test-'));
  await writeTestConfig({ repoRoot });
  const tplDir = path.join(repoRoot, 'templates', 'store-descriptions');
  await fs.mkdir(tplDir, { recursive: true });
  await fs.writeFile(path.join(tplDir, 'cline-issue.hbs'), TEMPLATE);
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

  // updateBodyOnIdempotencyHit (v1.1 item 1): cline uses a version-less
  // title, so every release after the first hits the same issue. Without
  // refresh, the body would forever show v1.0.0 even when we ship
  // v1.0.4. The opt-in changes "skipped → succeeded + edit body" so
  // reviewers always see the latest version in the single open issue.

  it('updateBodyOnIdempotencyHit: existing issue → render body + gh issue edit + status=succeeded', async () => {
    await withRepoRoot(async (repoRoot) => {
      const existingUrl = 'https://github.com/cline/mcp-marketplace/issues/12';
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 12, title: '[io.github.g-digital-by-Garrigues/ead-factory] ead-factory', url: existingUrl }]),
          };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') return { exitCode: 0 };
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.4', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' } },
      );
      expect(result.status).toBe('succeeded');
      expect(result.target_url).toBe(existingUrl);
      expect(result.target).toBe('cline');

      // gh issue edit was called against issue 12 with --body containing
      // the new version's content.
      const edit = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'edit');
      expect(edit).toBeDefined();
      expect(edit?.args).toContain('12');
      const bodyIdx = edit!.args.indexOf('--body');
      expect(bodyIdx).toBeGreaterThan(-1);
      const body = edit!.args[bodyIdx + 1]!;
      // Body should contain the v1.0.4 version (logo unpkg URL carries it).
      expect(body).toContain('1.0.4');
      expect(body).toContain('@g-digital/mcp-ead-factory');

      // No gh issue create should have happened — we updated, not created.
      const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
      expect(create).toBeUndefined();
    });
  });

  it('updateBodyOnIdempotencyHit + dry_run: returns succeeded WITHOUT calling gh issue edit', async () => {
    await withRepoRoot(async (repoRoot) => {
      const existingUrl = 'https://github.com/cline/mcp-marketplace/issues/12';
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 12, title: '[io.github.g-digital-by-Garrigues/ead-factory] ead-factory', url: existingUrl }]),
          };
        }
        return { exitCode: 1, stderr: 'should not be called in dry_run' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.4', pipeline_run_id: 'r', dry_run: true, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' } },
      );
      expect(result.status).toBe('succeeded');
      expect(result.dry_run).toBe(true);
      // The dry-run branch returns the placeholder URL (not the
      // existing issue URL) so the release report stays consistent
      // with every other target's example.invalid/dry-run/... URL —
      // a reader of the report should never see a real github.com
      // link next to status=succeeded in dry-run and reasonably
      // assume something was posted. Caught in run #26040942667.
      expect(result.target_url).toContain('example.invalid/dry-run/cline');
      expect(result.target_url).not.toBe(existingUrl);
      // Only the idempotency search call should have happened. No edit.
      expect(calls).toHaveLength(1);
      const edit = calls.find((c) => c.args[1] === 'edit');
      expect(edit).toBeUndefined();
    });
  });

  it('updateBodyOnIdempotencyHit: gh issue edit failure → status=failed with remediation', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 12, title: '[io.github.g-digital-by-Garrigues/ead-factory] ead-factory', url: 'https://github.com/cline/mcp-marketplace/issues/12' }]),
          };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'edit') {
          return { exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration' };
        }
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishCline(
        { mcp_name: 'ead-factory', version: '1.0.4', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' } },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.message).toContain('gh issue edit');
      expect(result.error?.cause).toContain('#12');
      expect(result.error?.action).toContain('issues:write');
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
