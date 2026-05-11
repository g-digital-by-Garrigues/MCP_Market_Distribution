import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInspectorHarness } from '../../src/gates/inspector-harness.js';

const STUB_SERVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'test-mcp',
  'server.mjs',
);

describe('runInspectorHarness (integration against stub MCP)', () => {
  it('happy path: initialize + list + call every advertised tool', async () => {
    const result = await runInspectorHarness({
      command: process.execPath,
      args: [STUB_SERVER],
      sampleInputs: [
        { toolName: 'echo', arguments: { message: 'hola' } },
        { toolName: 'always_fails', arguments: {} },
      ],
      timeoutMs: 15_000,
    });

    expect(result.initialize_succeeded).toBe(true);
    expect(result.launch_error).toBeUndefined();
    expect(result.initialize_error).toBeUndefined();
    expect(result.tools_list.map((t) => t.name).sort()).toEqual([
      'always_fails',
      'echo',
    ]);
    const echoTool = result.tools_list.find((t) => t.name === 'echo');
    expect(echoTool?.description).toContain('verbatim');
    expect(echoTool?.inputSchema).toMatchObject({ type: 'object' });

    expect(result.sample_call_results).toHaveLength(2);
    const echoCall = result.sample_call_results.find((c) => c.toolName === 'echo');
    expect(echoCall?.ok).toBe(true);
    const failsCall = result.sample_call_results.find((c) => c.toolName === 'always_fails');
    expect(failsCall?.ok).toBe(false);
    expect(failsCall?.error).toMatch(/intentionally failing/);
  }, 30_000);

  it('records a launch_error and never throws when the command does not exist (no zombies)', async () => {
    const result = await runInspectorHarness({
      command: 'this-binary-definitely-does-not-exist-on-the-runner',
      args: [],
      sampleInputs: [{ toolName: 'whatever', arguments: {} }],
      timeoutMs: 5_000,
    });

    expect(result.initialize_succeeded).toBe(false);
    expect(result.launch_error).toBeDefined();
    expect(result.tools_list).toEqual([]);
    expect(result.sample_call_results).toEqual([]);
  }, 15_000);

  it('returns gracefully when sampleInputs is omitted (initialize + list only)', async () => {
    const result = await runInspectorHarness({
      command: process.execPath,
      args: [STUB_SERVER],
      timeoutMs: 15_000,
    });

    expect(result.initialize_succeeded).toBe(true);
    expect(result.tools_list.length).toBeGreaterThan(0);
    expect(result.sample_call_results).toEqual([]);
  }, 30_000);
});
