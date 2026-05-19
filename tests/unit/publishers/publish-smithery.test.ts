import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  publishSmithery,
  type ExecFn,
  type SmitheryFetch,
} from '../../../src/publishers/publish-smithery.js';

// Story 5.11: tests for the rewritten Smithery publisher (MCPB-bundle
// flow). The previous polling-based tests covered the v1.0 repo-auto-
// deploy model that Smithery retired in 2026; replaced wholesale here.

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const NS = 'g-digital-by-Garrigues';
const QUALIFIED = `${NS}/multi-tool`;

function makeFetch(probe: { version?: string; status?: string } = {}): SmitheryFetch {
  return vi.fn(async () => probe);
}

function makeExec(result: { exitCode: number; stdout?: string; stderr?: string }): ExecFn {
  return vi.fn<ExecFn>(async () => ({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode,
  }));
}

describe('publishSmithery (MCPB flow — Story 5.11)', () => {
  let bundlePath: string;
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-smithery-'));
    bundlePath = path.join(tmpDir, 'multi-tool-v1.0.0.mcpb');
    await fs.writeFile(bundlePath, 'PK\x03\x04stub');
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function input(extra: Partial<Parameters<typeof publishSmithery>[0]> = {}) {
    return {
      mcp_name: 'multi-tool',
      version: '1.0.0',
      pipeline_run_id: 'run-1',
      dry_run: false,
      bundle_path: bundlePath,
      ...extra,
    };
  }

  it("fails when the bundle file does not exist (artifact download didn't run, or path wrong)", async () => {
    const out = await publishSmithery(input({ bundle_path: '/nonexistent/file.mcpb' }), {
      fetchSmithery: makeFetch(),
      exec: makeExec({ exitCode: 0 }),
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'x' },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('not found');
    expect(out.error?.cause).toContain('artifact');
  });

  it('idempotency: returns skipped(version_published=X) when the registry already carries the same version', async () => {
    const fetchSmithery = makeFetch({ version: '1.0.0', status: 'active' });
    const exec = makeExec({ exitCode: 0 });
    const out = await publishSmithery(input(), {
      fetchSmithery,
      exec,
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'x' },
    });
    expect(out.status).toBe('skipped');
    expect(out.version_published).toBe('1.0.0');
    expect(out.target_url).toBe(`https://smithery.ai/server/${QUALIFIED}`);
    expect(exec).not.toHaveBeenCalled();
  });

  it('dry-run: returns succeeded with placeholder URL, no CLI invocation', async () => {
    const exec = makeExec({ exitCode: 0 });
    const out = await publishSmithery(input({ dry_run: true }), {
      fetchSmithery: makeFetch(),
      exec,
      logger: silentLogger(),
      env: {},
    });
    expect(out.status).toBe('succeeded');
    expect(out.dry_run).toBe(true);
    expect(out.target_url).toContain('example.invalid/dry-run/smithery');
    expect(exec).not.toHaveBeenCalled();
  });

  it('fails fast with a typed error if SMITHERY_TOKEN is missing for a real publish', async () => {
    const exec = makeExec({ exitCode: 0 });
    const out = await publishSmithery(input(), {
      fetchSmithery: makeFetch(),
      exec,
      logger: silentLogger(),
      env: {},
    });
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('SMITHERY_TOKEN');
    expect(exec).not.toHaveBeenCalled();
  });

  it('happy path: shells out to `npx --yes @smithery/cli mcp publish <bundle> -n <ns>/<name>`', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: 'Published.', stderr: '', exitCode: 0 }));
    const out = await publishSmithery(input(), {
      fetchSmithery: makeFetch(),
      exec,
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'service-tok' },
    });
    expect(out.status).toBe('succeeded');
    expect(out.target_url).toBe(`https://smithery.ai/server/${QUALIFIED}`);
    expect(exec).toHaveBeenCalledOnce();
    const call = exec.mock.calls[0];
    expect(call).toBeDefined();
    const [cmd, args, opts] = call!;
    expect(cmd).toBe('npx');
    expect(args[0]).toBe('--yes');
    expect(args[1]).toBe('@smithery/cli@^4.11.1');
    expect(args.slice(2)).toEqual(['mcp', 'publish', bundlePath, '-n', QUALIFIED]);
    // Token forwarded to the child env under SMITHERY_API_KEY (NOT
    // SMITHERY_TOKEN — the @smithery/cli reads SMITHERY_API_KEY per
    // smithery-ai/cli src/utils/smithery-settings.ts; passing it under
    // any other name makes the CLI prompt interactively and exit 130 on
    // stdin EOF in CI). Regression for real-publish run #26109827581.
    const childEnv = (opts as { env?: Record<string, string> })?.env ?? {};
    expect(childEnv.SMITHERY_API_KEY).toBe('service-tok');
    expect(childEnv.SMITHERY_TOKEN).toBeUndefined();
  });

  it("idempotency on publish-time error: maps 'duplicate version' stderr to skipped(version_published)", async () => {
    const out = await publishSmithery(input(), {
      fetchSmithery: makeFetch(),
      exec: makeExec({
        exitCode: 1,
        stderr: 'Error: cannot publish duplicate version 1.0.0 of g-digital-by-Garrigues/multi-tool (status: 409)',
      }),
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'x' },
    });
    expect(out.status).toBe('skipped');
    expect(out.version_published).toBe('1.0.0');
  });

  it("maps auth-shaped stderr to a typed 'smithery_auth_failed' error with mint instructions", async () => {
    const out = await publishSmithery(input(), {
      fetchSmithery: makeFetch(),
      exec: makeExec({ exitCode: 1, stderr: '401 Unauthorized: token not authenticated for namespace publish' }),
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'bad' },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('401');
    expect(out.error?.action).toContain('smithery auth token');
    expect(out.error?.action).toContain(NS);
  });

  it('surfaces unclassified CLI errors with the stderr excerpt, not a generic message', async () => {
    const out = await publishSmithery(input(), {
      fetchSmithery: makeFetch(),
      exec: makeExec({ exitCode: 1, stderr: 'Network error: ECONNRESET talking to smithery.ai' }),
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'x' },
    });
    expect(out.status).toBe('failed');
    expect(out.error?.message).toContain('ECONNRESET');
    expect(out.error?.action).toContain('/retry-publish?step=smithery');
  });

  it('treats an idempotency-probe failure as non-fatal — still proceeds to publish', async () => {
    const fetchSmithery = vi.fn<SmitheryFetch>(async () => {
      throw new Error('probe failed');
    });
    const exec = vi.fn<ExecFn>(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const out = await publishSmithery(input(), {
      fetchSmithery,
      exec,
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'x' },
    });
    expect(out.status).toBe('succeeded');
    expect(exec).toHaveBeenCalledOnce();
  });

  it('respects an override smithery_namespace (future multi-org support)', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await publishSmithery(input({ smithery_namespace: 'other-org' }), {
      fetchSmithery: makeFetch(),
      exec,
      logger: silentLogger(),
      env: { SMITHERY_TOKEN: 'x' },
    });
    const args = exec.mock.calls[0]?.[1] as readonly string[];
    expect(args[args.length - 2]).toBe('-n');
    expect(args[args.length - 1]).toBe('other-org/multi-tool');
  });
});
