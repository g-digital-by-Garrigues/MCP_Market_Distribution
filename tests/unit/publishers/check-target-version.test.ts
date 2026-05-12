import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY_DELAYS_MS,
  checkTargetVersion,
  type ExecFn,
  type ExecResult,
} from '../../../src/publishers/check-target-version.js';

function execStub(responses: ExecResult[]): { exec: ExecFn; calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[i++];
    if (!r) throw new Error(`execStub ran out of responses at call #${i}`);
    return r;
  };
  return { exec, calls };
}

describe('DEFAULT_RETRY_DELAYS_MS', () => {
  it('is [30s, 2m, 5m] per AC', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 300_000]);
  });
});

describe('checkTargetVersion → npm', () => {
  it('returns status=present + version from `npm view --json` on first try', async () => {
    const { exec, calls } = execStub([
      { stdout: '"1.2.3"\n', stderr: '', exitCode: 0 },
    ]);
    const result = await checkTargetVersion('npm', '@g-digital/mcp-ead-factory', {
      exec,
      retryDelaysMs: [0, 0, 0],
    });
    expect(result).toEqual({ status: 'present', version: '1.2.3', attempts: 1 });
    expect(calls[0]?.args).toEqual(['view', '@g-digital/mcp-ead-factory', 'version', '--json']);
  });

  it('returns status=absent when npm view reports E404 on stderr', async () => {
    const { exec } = execStub([
      { stdout: '', stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/...', exitCode: 1 },
    ]);
    const result = await checkTargetVersion('npm', '@g-digital/mcp-new-thing', { exec, retryDelaysMs: [0] });
    expect(result).toEqual({ status: 'absent', version: null, attempts: 1 });
  });

  it('retries with the configured delays and succeeds on the 3rd attempt', async () => {
    const { exec, calls } = execStub([
      { stdout: '', stderr: 'transient ETIMEDOUT', exitCode: 1 }, // attempt 1 → null parse → retry
      { stdout: '', stderr: 'transient ETIMEDOUT', exitCode: 1 }, // attempt 2 → null parse → retry
      { stdout: '"2.0.0"', stderr: '', exitCode: 0 },               // attempt 3 → present
    ]);
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    const result = await checkTargetVersion('npm', '@g-digital/mcp-x', {
      exec,
      sleep,
      retryDelaysMs: [10, 20, 30],
    });
    expect(result).toEqual({ status: 'present', version: '2.0.0', attempts: 3 });
    expect(calls).toHaveLength(3);
    // Two sleeps between three attempts; the 3rd attempt succeeds so no sleep after.
    expect(sleeps).toEqual([10, 20]);
  });

  it('after exhausting all 3 attempts on transient failures, returns status=error (does NOT throw)', async () => {
    const { exec } = execStub([
      { stdout: '', stderr: 'ETIMEDOUT', exitCode: 1 },
      { stdout: '', stderr: 'ETIMEDOUT', exitCode: 1 },
      { stdout: '', stderr: 'ETIMEDOUT', exitCode: 1 },
    ]);
    const result = await checkTargetVersion('npm', '@g-digital/mcp-x', {
      exec,
      sleep: async () => {},
      retryDelaysMs: [0, 0, 0],
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.attempts).toBe(3);
      expect(result.error.message).toContain('check-target-version for npm');
      expect(result.error.lastStderr).toContain('ETIMEDOUT');
    }
  });
});

describe('checkTargetVersion → docker-hub', () => {
  it('returns status=absent when Docker Hub returns 404', async () => {
    const { exec } = execStub([
      { stdout: '{"detail":"object not found"}\n404', stderr: '', exitCode: 0 },
    ]);
    const result = await checkTargetVersion('docker-hub', 'gdigital/mcp-new-thing', {
      exec,
      retryDelaysMs: [0],
    });
    expect(result).toEqual({ status: 'absent', version: null, attempts: 1 });
  });

  it('returns status=present + the first semver-shaped tag on 200', async () => {
    const body = JSON.stringify({
      count: 2,
      results: [{ name: 'latest' }, { name: '1.0.0' }],
    });
    const { exec } = execStub([
      { stdout: `${body}\n200`, stderr: '', exitCode: 0 },
    ]);
    const result = await checkTargetVersion('docker-hub', 'gdigital/mcp-ead-factory', {
      exec,
      retryDelaysMs: [0],
    });
    expect(result).toEqual({ status: 'present', version: '1.0.0', attempts: 1 });
  });

  it('treats malformed JSON as transient and retries', async () => {
    const { exec, calls } = execStub([
      { stdout: 'not-json\n200', stderr: '', exitCode: 0 },
      { stdout: `${JSON.stringify({ results: [{ name: '1.0.0' }] })}\n200`, stderr: '', exitCode: 0 },
    ]);
    const result = await checkTargetVersion('docker-hub', 'gdigital/x', {
      exec,
      sleep: async () => {},
      retryDelaysMs: [0, 0],
    });
    expect(result.status).toBe('present');
    expect(calls).toHaveLength(2);
  });
});

describe('checkTargetVersion → mcp-publisher', () => {
  it('returns status=present + version when the registry reports the server with matching name', async () => {
    const body = JSON.stringify({
      servers: [
        {
          name: 'io.github.g-digital-by-Garrigues/mcp-ead-factory',
          version_detail: { version: '1.0.0' },
        },
      ],
    });
    const { exec } = execStub([
      { stdout: `${body}\n200`, stderr: '', exitCode: 0 },
    ]);
    const result = await checkTargetVersion(
      'mcp-publisher',
      'io.github.g-digital-by-Garrigues/mcp-ead-factory',
      { exec, retryDelaysMs: [0] },
    );
    expect(result).toEqual({ status: 'present', version: '1.0.0', attempts: 1 });
  });

  it('returns status=absent when the registry search returns no matching server', async () => {
    const { exec } = execStub([
      { stdout: `${JSON.stringify({ servers: [] })}\n200`, stderr: '', exitCode: 0 },
    ]);
    const result = await checkTargetVersion('mcp-publisher', 'io.github.foo/bar', {
      exec,
      retryDelaysMs: [0],
    });
    expect(result).toEqual({ status: 'absent', version: null, attempts: 1 });
  });

  it('returns status=absent when the search returns a near-match but not an exact name match', async () => {
    const body = JSON.stringify({
      servers: [{ name: 'io.github.other-org/mcp-ead-factory', version_detail: { version: '1.0.0' } }],
    });
    const { exec } = execStub([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
    const result = await checkTargetVersion('mcp-publisher', 'io.github.g-digital-by-Garrigues/mcp-ead-factory', {
      exec,
      retryDelaysMs: [0],
    });
    expect(result.status).toBe('absent');
  });
});

describe('checkTargetVersion error paths', () => {
  it('returns error for an unknown target without invoking exec', async () => {
    const exec = vi.fn();
    const result = await checkTargetVersion(
      'snyk' as unknown as 'npm',
      'whatever',
      { exec, retryDelaysMs: [0] },
    );
    expect(result.status).toBe('error');
    expect(exec).not.toHaveBeenCalled();
  });
});
