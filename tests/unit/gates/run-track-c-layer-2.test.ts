import { describe, expect, it, vi } from 'vitest';

import { runTrackCLayer2, type ExecFn } from '../../../src/gates/run-track-c-layer-2.js';

function okExec(): ExecFn {
  return vi.fn(async () => ({ stdout: 'OK', stderr: '', exitCode: 0 }));
}

function failingExec(exitCode = 1, stderr = 'manifest_version: expected "0.3" got "0.2"'): ExecFn {
  return vi.fn(async () => ({ stdout: '', stderr, exitCode }));
}

describe('Track C — Layer 2 (mcpb validate)', () => {
  it('passes when `mcpb validate <bundle>` exits 0', async () => {
    const exec = okExec();
    const result = await runTrackCLayer2(
      { mcpName: 'multi-tool', bundlePath: '/tmp/multi-tool-v1.0.0.mcpb' },
      { exec },
    );
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.log.event).toBe('gate.track_c_layer_2_passed');
    // Confirm we actually invoked `npx --yes @anthropic-ai/mcpb@^2.1.2 validate`.
    expect(exec).toHaveBeenCalledOnce();
    const callArgs = (exec as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(callArgs[0]).toBe('npx');
    expect(callArgs[1]).toEqual(['--yes', '@anthropic-ai/mcpb@^2.1.2', 'validate', '/tmp/multi-tool-v1.0.0.mcpb']);
  });

  it('fails with a typed ErrorReport when validate exits non-zero, surfacing stderr', async () => {
    const exec = failingExec(1, 'manifest_version: expected "0.3" got "0.2"');
    const result = await runTrackCLayer2(
      { mcpName: 'multi-tool', bundlePath: '/tmp/multi-tool-v1.0.0.mcpb' },
      { exec },
    );
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.track_c_layer_2_failed');
    const err = result.errors[0]!;
    expect(err.stage).toBe('gate');
    expect(err.layer).toBe(2);
    expect(err.target).toBe('smithery');
    expect(err.check).toBe('mcpb_validate');
    expect(err.observation).toContain('exited 1');
    expect(err.observation).toContain('manifest_version');
    expect(err.action).toContain('manifest.json.hbs');
  });

  it('passes a custom timeoutMs through to the exec function', async () => {
    const exec = vi.fn(okExec());
    await runTrackCLayer2(
      { mcpName: 'multi-tool', bundlePath: '/tmp/x.mcpb', timeoutMs: 30_000 },
      { exec },
    );
    const opts = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(30_000);
  });
});
