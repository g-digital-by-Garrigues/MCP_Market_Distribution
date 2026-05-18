import { describe, expect, it, vi } from 'vitest';
import {
  runTrackBLayer2,
  type ExecFn,
} from '../../../src/gates/run-track-b-layer-2.js';

function fakeExec(responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>): {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: readonly string[]; cwd?: string }>;
} {
  const calls: Array<{ cmd: string; args: readonly string[]; cwd?: string }> = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args, options) => {
    calls.push({ cmd, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    const r = responses[i++];
    if (!r) throw new Error(`fakeExec exhausted at call #${i}`);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { exec, calls };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('runTrackBLayer2 (compile gate)', () => {
  it('happy path: install + tsc both exit 0 → passed', async () => {
    const { exec, calls } = fakeExec([
      { exitCode: 0, stdout: 'Packages: +37\n' },
      { exitCode: 0, stdout: '' },
    ]);
    const result = await runTrackBLayer2(
      { mcpName: 'multi-tool', nodeDir: '/tmp/node' },
      { exec, logger: silentLogger },
    );
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.log.event).toBe('gate.track_b_layer_2_passed');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      cmd: 'pnpm',
      args: ['install', '--no-frozen-lockfile'],
      cwd: '/tmp/node',
    });
    expect(calls[1]).toMatchObject({
      cmd: 'pnpm',
      args: ['exec', 'tsc', '--noEmit'],
      cwd: '/tmp/node',
    });
  });

  it("install failure: short-circuits before tsc runs", async () => {
    const { exec, calls } = fakeExec([
      {
        exitCode: 1,
        stderr: "ERR_PNPM_FETCH_404 GET https://registry.npmjs.com/@g-digital%2Fmcp-broken: Not Found",
      },
    ]);
    const result = await runTrackBLayer2(
      { mcpName: 'broken', nodeDir: '/tmp/node' },
      { exec, logger: silentLogger },
    );
    expect(result.passed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    const e = result.errors[0]!;
    expect(e.check).toBe('install');
    expect(e.layer).toBe(2);
    expect(e.target).toBe('n8n');
    expect(e.observation).toContain('ERR_PNPM_FETCH_404');
  });

  it("compile failure: surfaces a sample of TS diagnostics in the observation", async () => {
    const tscOut = [
      "nodes/MultiTool/MultiTool.node.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "nodes/MultiTool/MultiTool.node.ts(43,5): error TS2552: Cannot find name 'fooBar'.",
      "credentials/MultiToolApi.credentials.ts(10,3): error TS1109: Expression expected.",
    ].join('\n');
    const { exec, calls } = fakeExec([
      { exitCode: 0 },
      { exitCode: 1, stdout: tscOut },
    ]);
    const result = await runTrackBLayer2(
      { mcpName: 'multi-tool', nodeDir: '/tmp/node' },
      { exec, logger: silentLogger },
    );
    expect(result.passed).toBe(false);
    expect(calls).toHaveLength(2);
    const compile = result.errors.find((e) => e.check === 'compile');
    expect(compile).toBeDefined();
    expect(compile!.observation).toContain('3 error(s)');
    expect(compile!.observation).toContain('TS2322');
    expect(compile!.observation).toContain('TS2552');
    expect(compile!.action).toContain('pnpm exec tsc --noEmit');
  });

  it('falls back to a stderr tail when no parseable diagnostics are present', async () => {
    const { exec } = fakeExec([
      { exitCode: 0 },
      { exitCode: 2, stderr: 'tsc: command not found (something else went wrong)' },
    ]);
    const result = await runTrackBLayer2(
      { mcpName: 'x', nodeDir: '/tmp/n' },
      { exec, logger: silentLogger },
    );
    expect(result.passed).toBe(false);
    const compile = result.errors.find((e) => e.check === 'compile');
    expect(compile!.observation).toContain('no parseable diagnostics');
    expect(compile!.observation).toContain('tsc: command not found');
  });

  it('every emitted ErrorReport carries the canonical Track B shape (stage=gate, layer=2, target=n8n)', async () => {
    const { exec } = fakeExec([{ exitCode: 1, stderr: 'install boom' }]);
    const result = await runTrackBLayer2(
      { mcpName: 'x', nodeDir: '/tmp/n' },
      { exec, logger: silentLogger },
    );
    for (const e of result.errors) {
      expect(e.stage).toBe('gate');
      expect(e.layer).toBe(2);
      expect(e.target).toBe('n8n');
      expect(e.check.length).toBeGreaterThan(0);
      expect(e.observation.length).toBeGreaterThan(0);
      expect(e.cause.length).toBeGreaterThan(0);
      expect(e.action.length).toBeGreaterThan(0);
    }
  });

  it('passes the configured timeout through to each exec call', async () => {
    let capturedInstallTimeout: number | undefined;
    let capturedCompileTimeout: number | undefined;
    let n = 0;
    const exec: ExecFn = async (_cmd, _args, opts) => {
      n += 1;
      if (n === 1) capturedInstallTimeout = opts?.timeoutMs;
      else capturedCompileTimeout = opts?.timeoutMs;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await runTrackBLayer2(
      { mcpName: 'x', nodeDir: '/tmp/n', timeoutMs: 120_000 },
      { exec, logger: silentLogger },
    );
    expect(capturedInstallTimeout).toBe(120_000);
    expect(capturedCompileTimeout).toBe(120_000);
  });
});
