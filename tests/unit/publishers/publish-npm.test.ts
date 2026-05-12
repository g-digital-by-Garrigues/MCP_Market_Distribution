import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishNpm } from '../../../src/publishers/publish-npm.js';
import type { ExecFn } from '../../../src/publishers/publish-npm.js';
import type { ExecFn as ProbeExecFn } from '../../../src/publishers/check-target-version.js';

interface FakeExec {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
}

function fakeExec(responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>): FakeExec {
  const calls: FakeExec['calls'] = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options.cwd, env: options.env });
    const r = responses[i++];
    if (!r) throw new Error(`fakeExec ran out of responses at call #${i}`);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { exec, calls };
}

function fakeProbe(responses: Array<{ stdout: string; stderr: string; exitCode: number }>): ProbeExecFn {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error('fakeProbe exhausted');
    return r;
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function withTempPackage(
  body: (packageDir: string) => Promise<void>,
  pkg: Record<string, unknown> = { name: '@g-digital/mcp-ead-factory', version: '1.0.0' },
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-npm-test-'));
  try {
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
    await body(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('publishNpm', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: idempotency-absent → npm publish succeeds with NPM_TOKEN → status="succeeded"', async () => {
    await withTempPackage(async (packageDir) => {
      const probeExec = fakeProbe([
        { stdout: '', stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found', exitCode: 1 },
      ]);
      const { exec, calls } = fakeExec([{ exitCode: 0, stdout: '+ @g-digital/mcp-ead-factory@1.0.0' }]);
      const writeNpmrc = vi.fn(async (_p: string, _c: string): Promise<void> => {});
      const removeNpmrc = vi.fn(async (_p: string): Promise<void> => {});

      const t0 = 1_000;
      const output = await publishNpm(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
        },
        {
          exec,
          probeExec,
          now: (() => {
            let t = t0;
            return () => (t += 5);
          })(),
          logger: silentLogger,
          env: { NPM_TOKEN: 'npm_abc1234567890def' },
          writeNpmrc,
          removeNpmrc,
        },
      );

      expect(output.status).toBe('succeeded');
      expect(output.target).toBe('npm');
      expect(output.target_url).toBe('https://www.npmjs.com/package/@g-digital/mcp-ead-factory/v/1.0.0');
      expect(output.version_published).toBe('1.0.0');
      expect(output.dry_run).toBe(false);
      expect(output.metadata).toEqual({ auth_mode: 'npm_token' });

      // Auth: temp .npmrc was written and cleaned up.
      expect(writeNpmrc).toHaveBeenCalledOnce();
      expect(writeNpmrc.mock.calls[0]?.[1]).toContain('//registry.npmjs.org/:_authToken=npm_abc1234567890def');
      expect(removeNpmrc).toHaveBeenCalledOnce();

      // No --provenance when NPM_TOKEN auth is in use.
      const publishCall = calls.find((c) => c.cmd === 'npm');
      expect(publishCall?.args).toEqual(['publish', '--access', 'public']);
      expect(publishCall?.cwd).toBe(packageDir);

      // Structured logs.
      const events = silentLogger.info.mock.calls.map((c) => c[0]);
      expect(events).toContain('target.publish_started');
      expect(events).toContain('target.publish_succeeded');
    });
  });

  it('OIDC path: no NPM_TOKEN → npm publish is invoked with --provenance', async () => {
    await withTempPackage(async (packageDir) => {
      const probeExec = fakeProbe([
        { stdout: '', stderr: 'npm ERR! code E404', exitCode: 1 },
      ]);
      const { exec, calls } = fakeExec([{ exitCode: 0 }]);

      const output = await publishNpm(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-1',
          dry_run: false,
          package_dir: packageDir,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: { NPM_TOKEN: '' },
        },
      );

      expect(output.status).toBe('succeeded');
      expect(output.metadata?.auth_mode).toBe('oidc');
      const publishCall = calls.find((c) => c.cmd === 'npm');
      expect(publishCall?.args).toEqual(['publish', '--access', 'public', '--provenance']);
    });
  });

  it('dry_run: true → invokes `npm publish --dry-run`, target_url is placeholder, status=succeeded', async () => {
    await withTempPackage(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const { exec, calls } = fakeExec([{ exitCode: 0 }]);

      const output = await publishNpm(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-1',
          dry_run: true,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('succeeded');
      expect(output.dry_run).toBe(true);
      expect(output.target_url).toContain('https://example.invalid/dry-run/npm/');
      const args = calls.find((c) => c.cmd === 'npm')?.args ?? [];
      expect(args).toContain('--dry-run');
    });
  });

  it('idempotency hit: probe returns present + matching version → status="skipped", does NOT call npm publish', async () => {
    await withTempPackage(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '"1.0.0"\n', stderr: '', exitCode: 0 }]);
      const { exec, calls } = fakeExec([]); // should never be called

      const output = await publishNpm(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-1',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'npm_x' } },
      );

      expect(output.status).toBe('skipped');
      expect(output.target_url).toBe('https://www.npmjs.com/package/@g-digital/mcp-ead-factory/v/1.0.0');
      expect(output.version_published).toBe('1.0.0');
      expect(calls).toEqual([]);
    });
  });

  it('npm publish exit non-zero → status="failed" with classified cause + remediation', async () => {
    await withTempPackage(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const stderr = 'npm ERR! 409 Conflict — cannot publish over the previously published versions';
      const { exec } = fakeExec([{ exitCode: 1, stderr }]);

      const output = await publishNpm(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-1',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'npm_x' } },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('npm publish exited 1');
      expect(output.error?.cause).toContain('Version conflict');
      expect(output.error?.action).toContain('Bump the version');
    });
  });

  it('package.json version mismatch → status="failed" before any registry call', async () => {
    await withTempPackage(
      async (packageDir) => {
        const probeExec = fakeProbe([]); // never reached
        const { exec, calls } = fakeExec([]);

        const output = await publishNpm(
          {
            mcp_name: 'ead-factory',
            version: '1.0.0',
            pipeline_run_id: 'run-1',
            dry_run: false,
            package_dir: packageDir,
          },
          { exec, probeExec, logger: silentLogger, env: {} },
        );

        expect(output.status).toBe('failed');
        expect(output.error?.message).toContain('does not match');
        expect(calls).toEqual([]);
      },
      { name: '@g-digital/mcp-ead-factory', version: '0.9.0' },
    );
  });

  it('idempotency probe errors out → status="failed" with registry-health remediation', async () => {
    await withTempPackage(async (packageDir) => {
      const probeExec = fakeProbe([
        { stdout: '', stderr: 'ETIMEDOUT', exitCode: 1 },
        { stdout: '', stderr: 'ETIMEDOUT', exitCode: 1 },
        { stdout: '', stderr: 'ETIMEDOUT', exitCode: 1 },
      ]);
      const { exec, calls } = fakeExec([]);

      const output = await publishNpm(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-1',
          dry_run: false,
          package_dir: packageDir,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: {},
          probeOptions: { retryDelaysMs: [0, 0, 0], sleep: async () => {} },
        },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.cause).toContain('idempotency');
      expect(output.error?.action).toContain('status.npmjs.org');
      expect(calls).toEqual([]);
    });
  });
});
