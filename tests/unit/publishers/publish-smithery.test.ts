import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishSmithery } from '../../../src/publishers/publish-smithery.js';
import type { SmitheryFetch } from '../../../src/publishers/publish-smithery.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function withRepoRoot(body: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-smithery-test-'));
  await writeTestConfig({ repoRoot });
  try {
    await body(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe('publishSmithery', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('happy path: poll returns matching version on first attempt → succeeded', async () => {
    await withRepoRoot(async (repoRoot) => {
      const fetchSmithery: SmitheryFetch = vi.fn(async () => ({ version: '1.0.0', status: 'ready' }));
      const result = await publishSmithery(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          repo_root: repoRoot,
        },
        { fetchSmithery, logger: silentLogger, env: {}, sleep: async () => {}, pollIntervalMs: 0, pollTimeoutMs: 5_000 },
      );
      expect(result.status).toBe('succeeded');
      expect(result.target_url).toBe('https://smithery.ai/server/io.github.g-digital-by-Garrigues/ead-factory');
      expect(result.metadata?.smithery_status).toBe('ready');
      expect(fetchSmithery).toHaveBeenCalledTimes(1);
    });
  });

  it('polls multiple times until the version matches', async () => {
    await withRepoRoot(async (repoRoot) => {
      let calls = 0;
      const fetchSmithery: SmitheryFetch = vi.fn(async () => {
        calls += 1;
        if (calls < 3) return { version: '0.9.0', status: 'building' };
        return { version: '1.0.0', status: 'ready' };
      });
      const result = await publishSmithery(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          repo_root: repoRoot,
        },
        { fetchSmithery, logger: silentLogger, env: {}, sleep: async () => {}, pollIntervalMs: 0, pollTimeoutMs: 60_000 },
      );
      expect(result.status).toBe('succeeded');
      expect(result.attempts).toBe(3);
    });
  });

  it('dry_run: returns succeeded with placeholder url and never calls the API', async () => {
    await withRepoRoot(async (repoRoot) => {
      const fetchSmithery = vi.fn();
      const result = await publishSmithery(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: true,
          repo_root: repoRoot,
        },
        { fetchSmithery, logger: silentLogger, env: {} },
      );
      expect(result.status).toBe('succeeded');
      expect(result.dry_run).toBe(true);
      expect(result.target_url).toContain('https://example.invalid/dry-run/smithery/');
      expect(fetchSmithery).not.toHaveBeenCalled();
    });
  });

  it('times out → status=failed with manual-verification remediation', async () => {
    await withRepoRoot(async (repoRoot) => {
      const fetchSmithery: SmitheryFetch = vi.fn(async () => ({ version: '0.9.0', status: 'building' }));
      // Use a tiny timeout so the test runs fast.
      const result = await publishSmithery(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          repo_root: repoRoot,
        },
        { fetchSmithery, logger: silentLogger, env: {}, sleep: async () => {}, pollIntervalMs: 0, pollTimeoutMs: 10 },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.action).toContain('dashboard');
      expect(result.error?.action).toContain('smithery.ai/server/');
    });
  });

  it('Smithery API repeatedly errors → status=failed with status-page remediation', async () => {
    await withRepoRoot(async (repoRoot) => {
      const fetchSmithery: SmitheryFetch = vi.fn(async () => {
        throw Object.assign(new Error('upstream 503'), { status: 503 });
      });
      const result = await publishSmithery(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          repo_root: repoRoot,
        },
        { fetchSmithery, logger: silentLogger, env: {}, sleep: async () => {}, pollIntervalMs: 0, pollTimeoutMs: 60_000 },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.cause).toContain('Could not reach smithery.ai');
      expect(result.error?.action).toContain('status.smithery.ai');
    });
  });

  it('unknown mcp_name → status=failed before any API call', async () => {
    await withRepoRoot(async (repoRoot) => {
      const fetchSmithery = vi.fn();
      const result = await publishSmithery(
        {
          mcp_name: 'nonexistent',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          repo_root: repoRoot,
        },
        { fetchSmithery, logger: silentLogger, env: {} },
      );
      expect(result.status).toBe('failed');
      expect(result.error?.action).toContain('.distribution.yaml');
      expect(fetchSmithery).not.toHaveBeenCalled();
    });
  });
});
