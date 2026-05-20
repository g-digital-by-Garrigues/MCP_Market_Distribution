import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runTrackCLayer3 } from '../../../src/gates/run-track-c-layer-3.js';
import type { McpbBundleSpec } from '../../../src/adapters/mcpb-adapter/types.js';
import type {
  InspectorResult,
  InspectorToolEntry,
  RunInspectorHarnessOptions,
} from '../../../src/gates/inspector-harness.js';

type RunInspector = (opts: RunInspectorHarnessOptions) => Promise<InspectorResult>;

function sampleSpec(): McpbBundleSpec {
  return {
    name: 'multi-tool',
    displayName: 'Multi Tool',
    version: '1.0.0',
    description: 'A test multi-tool MCP server.',
    sourceMcpPackageName: '@g-digital/mcp-multi-tool',
    sourceRepoUrl: 'https://github.com/g-digital-by-Garrigues/multi-tool-mcp',
    author: { name: 'g-digital by Garrigues' },
    operations: [
      { name: 'get_widget', description: 'Fetch a widget.' },
      { name: 'list_widgets', description: 'List widgets.' },
    ],
    userConfig: [
      { envName: 'TEST_API_KEY', configKey: 'test_api_key', title: 'Api Key', description: 'k', sensitive: true, required: true },
    ],
    entryPoint: 'server/index.js',
    smitheryNamespace: 'g-digital',
  };
}

function fakeInspectorResult(overrides: Partial<InspectorResult> = {}): InspectorResult {
  const defaults: InspectorResult = {
    initialize_succeeded: true,
    tools_list: [
      { name: 'get_widget', description: 'Fetch a widget.', inputSchema: { type: 'object' } } as InspectorToolEntry,
      { name: 'list_widgets', description: 'List widgets.', inputSchema: { type: 'object' } } as InspectorToolEntry,
    ],
    sample_call_results: [],
  };
  return { ...defaults, ...overrides };
}

describe('Track C — Layer 3 (runtime roundtrip)', () => {
  let bundleDir: string;
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-c-l3-'));
    // Pre-flight requires entry file to exist on disk.
    await fs.mkdir(path.join(bundleDir, 'server'), { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'server', 'index.js'), '// stub\n');
  });
  afterEach(async () => {
    await fs.rm(bundleDir, { recursive: true, force: true });
  });

  it('passes when bundled server initializes + tools/list matches spec', async () => {
    const runInspector = vi.fn<RunInspector>(async () => fakeInspectorResult());
    const result = await runTrackCLayer3({ mcpName: 'multi-tool', spec: sampleSpec(), bundleDir }, { runInspector });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tools_listed).toEqual(['get_widget', 'list_widgets']);
    expect(result.log.event).toBe('gate.track_c_layer_3_passed');
    // Confirm we passed synthetic env values mapped from the spec.
    expect(runInspector).toHaveBeenCalledOnce();
    const callArgs = runInspector.mock.calls[0]?.[0];
    expect(callArgs?.env).toEqual({ TEST_API_KEY: 'placeholder-test_api_key' });
  });

  it('fails launch check if the bundled entry file is missing (CLI shim never staged dist/)', async () => {
    await fs.rm(path.join(bundleDir, 'server', 'index.js'));
    const runInspector = vi.fn(async () => fakeInspectorResult());
    const result = await runTrackCLayer3({ mcpName: 'multi-tool', spec: sampleSpec(), bundleDir }, { runInspector });
    expect(result.passed).toBe(false);
    expect(result.errors[0]!.check).toBe('launch');
    expect(result.errors[0]!.observation).toContain('server/index.js');
    // We never reached inspector.
    expect(runInspector).not.toHaveBeenCalled();
  });

  it('fails initialize check when the handshake fails', async () => {
    const runInspector = vi.fn(async () =>
      fakeInspectorResult({ initialize_succeeded: false, initialize_error: 'protocol error: invalid jsonrpc' }),
    );
    const result = await runTrackCLayer3({ mcpName: 'multi-tool', spec: sampleSpec(), bundleDir }, { runInspector });
    expect(result.passed).toBe(false);
    expect(result.errors[0]!.check).toBe('initialize');
    expect(result.errors[0]!.observation).toContain('invalid jsonrpc');
  });

  it('fails tools_list check when the spec has tools the bundled server does not expose', async () => {
    const runInspector = vi.fn(async () =>
      fakeInspectorResult({
        tools_list: [{ name: 'get_widget', inputSchema: {} } as InspectorToolEntry],
      }),
    );
    const result = await runTrackCLayer3({ mcpName: 'multi-tool', spec: sampleSpec(), bundleDir }, { runInspector });
    expect(result.passed).toBe(false);
    expect(result.errors[0]!.check).toBe('tools_list');
    expect(result.errors[0]!.observation).toContain('list_widgets');
    expect(result.tools_listed).toEqual(['get_widget']);
  });

  it('fails tools_list check when the bundled server exposes EXTRA tools not in the spec (drift)', async () => {
    const runInspector = vi.fn(async () =>
      fakeInspectorResult({
        tools_list: [
          { name: 'get_widget', inputSchema: {} } as InspectorToolEntry,
          { name: 'list_widgets', inputSchema: {} } as InspectorToolEntry,
          { name: 'delete_widget', inputSchema: {} } as InspectorToolEntry,
        ],
      }),
    );
    const result = await runTrackCLayer3({ mcpName: 'multi-tool', spec: sampleSpec(), bundleDir }, { runInspector });
    expect(result.passed).toBe(false);
    expect(result.errors[0]!.observation).toContain('delete_widget');
  });

  it('surfaces inspector-harness throwing as a launch-level failure', async () => {
    const runInspector = vi.fn(async () => {
      throw new Error('spawn ENOENT');
    });
    const result = await runTrackCLayer3({ mcpName: 'multi-tool', spec: sampleSpec(), bundleDir }, { runInspector });
    expect(result.passed).toBe(false);
    expect(result.errors[0]!.check).toBe('launch');
    expect(result.errors[0]!.observation).toContain('spawn ENOENT');
  });
});
