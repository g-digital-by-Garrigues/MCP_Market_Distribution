import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runTrackBLayer3 } from '../../src/gates/run-track-b-layer-3.js';
import type { N8nNodeSpec } from '../../src/adapters/n8n-adapter/types.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'test-mcp',
);
const MULTI_TOOL_STUB = path.join(FIXTURES_DIR, 'server-multi-tool.mjs');
const METHOD_NOT_FOUND_STUB = path.join(FIXTURES_DIR, 'server-rejects-method.mjs');
const AUTH_ERROR_STUB = path.join(FIXTURES_DIR, 'server-auth-error.mjs');
const POLLABLE_ERROR_STUB = path.join(FIXTURES_DIR, 'server-pollable-error.mjs');

function specForMultiTool(): N8nNodeSpec {
  return {
    packageName: '@g-digital/n8n-nodes-multi-tool',
    sourceMcpPackageName: '@g-digital/mcp-multi-tool',
    version: '1.0.0',
    className: 'MultiTool',
    displayName: 'Multi Tool',
    description: 'A test multi-tool MCP node.',
    nodeName: 'multi-tool',
    paramName: 'multiTool',
    resourceDisplayName: 'Multi Tool',
    credentialClassName: 'MultiToolApi',
    credentialParamName: 'multiToolApi',
    sourceRepoUrl: 'https://github.com/test/test-mcp',
    author: 'g-digital by Garrigues',
    authStyle: 'email-password',
    operations: [
      {
        name: 'get_widget',
        displayName: 'Get Widget',
        description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test',
        httpMethod: 'GET',
        httpUrlTemplate: '/widgets/{widget_id}',
        properties: [
          {
            name: 'widget_id',
            displayName: 'Widget Id',
            type: 'string',
            default: '',
            required: true,
            showForOperation: 'get_widget',
          },
        ],
      },
      {
        name: 'list_widgets',
        displayName: 'List Widgets',
        description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test',
        httpMethod: 'GET',
        httpUrlTemplate: '/widgets',
        properties: [
          {
            name: 'page_size',
            displayName: 'Page Size',
            type: 'number',
            default: 25,
            showForOperation: 'list_widgets',
          },
        ],
      },
    ],
    credentials: [],
  };
}

describe('Track B — Layer 3 (per-operation smoke)', () => {
  it('happy path: multi-tool stub returns content arrays for both ops → passed', async () => {
    const spec = specForMultiTool();
    const result = await runTrackBLayer3({
      mcpName: 'multi-tool',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: [MULTI_TOOL_STUB],
      timeoutMs: 10_000,
    });
    expect(result.passed).toBe(true);
    expect(result.operations_checked.sort()).toEqual(['get_widget', 'list_widgets']);
    expect(result.errors).toEqual([]);
    expect(result.log.event).toBe('gate.track_b_layer_3_passed');
  }, 30_000);

  it('classifies auth-error responses as structurally valid (no real creds in CI)', async () => {
    const spec: N8nNodeSpec = {
      ...specForMultiTool(),
      operations: [
        {
          name: 'do_thing',
          displayName: 'Do Thing',
          description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test',
          httpMethod: 'GET',
          httpUrlTemplate: '/things/{id}',
          properties: [
            {
              name: 'id',
              displayName: 'Id',
              type: 'string',
              default: '',
              required: true,
              showForOperation: 'do_thing',
            },
          ],
        },
      ],
    };
    const result = await runTrackBLayer3({
      mcpName: 'auth-fail',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: [AUTH_ERROR_STUB],
      timeoutMs: 10_000,
    });
    expect(result.passed).toBe(true);
    expect(result.operations_checked).toEqual(['do_thing']);
  }, 30_000);

  it('classifies pollable / task-based-execution responses as structurally valid (tool exists, demands callToolStream)', async () => {
    const spec: N8nNodeSpec = {
      ...specForMultiTool(),
      operations: [
        {
          name: 'pollable_tool',
          displayName: 'Pollable Tool',
          description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test',
          properties: [
            {
              name: 'id',
              displayName: 'Id',
              type: 'string',
              default: '',
              required: true,
              showForOperation: 'pollable_tool',
            },
          ],
        },
      ],
    };
    const result = await runTrackBLayer3({
      mcpName: 'pollable',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: [POLLABLE_ERROR_STUB],
      timeoutMs: 10_000,
    });
    expect(result.passed).toBe(true);
    expect(result.operations_checked).toEqual(['pollable_tool']);
  }, 30_000);

  it("fails when the MCP rejects every tools/call with method-not-found (codegen drift signal)", async () => {
    // Spec advertises an op the MCP does not implement — the rejects-method
    // stub will return a -32601-flavored error for whatever name we send.
    const spec: N8nNodeSpec = {
      ...specForMultiTool(),
      operations: [
        {
          name: 'drifted_tool',
          displayName: 'Drifted Tool',
          description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test',
          properties: [],
        },
      ],
    };
    const result = await runTrackBLayer3({
      mcpName: 'drifted',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: [METHOD_NOT_FOUND_STUB],
      timeoutMs: 10_000,
    });
    expect(result.passed).toBe(false);
    const e = result.errors[0]!;
    expect(e.layer).toBe(3);
    expect(e.target).toBe('n8n');
    expect(e.check).toBe('per_operation_smoke');
    expect(e.observation).toContain('drifted_tool');
    expect(e.observation.toLowerCase()).toContain('method not found');
  }, 30_000);

  it("emits a launch-level error when the source MCP cannot start", async () => {
    const spec = specForMultiTool();
    const result = await runTrackBLayer3({
      mcpName: 'broken',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: ['/path/that/does/not/exist.mjs'],
      timeoutMs: 10_000,
    });
    expect(result.passed).toBe(false);
    expect(result.operations_checked).toEqual([]);
    const launchError = result.errors.find((e) => e.check === 'launch');
    expect(launchError).toBeDefined();
    expect(launchError!.layer).toBe(3);
    expect(launchError!.target).toBe('n8n');
  }, 30_000);

  it('emits one ErrorReport per failing operation (parallel failures coexist)', async () => {
    const spec: N8nNodeSpec = {
      ...specForMultiTool(),
      operations: [
        { name: 'one', displayName: 'One', description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test', properties: [] },
        { name: 'two', displayName: 'Two', description: '',
          httpMethod: 'GET',
          httpUrlTemplate: '/test', properties: [] },
      ],
    };
    const result = await runTrackBLayer3({
      mcpName: 'two-drifts',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: [METHOD_NOT_FOUND_STUB],
      timeoutMs: 10_000,
    });
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors.map((e) => e.observation).join(' ')).toMatch(/one[\s\S]+two|two[\s\S]+one/);
  }, 30_000);

  it('every emitted ErrorReport carries stage=gate, layer=3, target=n8n', async () => {
    const spec = specForMultiTool();
    const result = await runTrackBLayer3({
      mcpName: 'x',
      spec,
      packageDir: os.tmpdir(),
      serverCommand: process.execPath,
      serverArgs: ['/no/such/file.mjs'],
      timeoutMs: 5_000,
    });
    for (const e of result.errors) {
      expect(e.stage).toBe('gate');
      expect(e.layer).toBe(3);
      expect(e.target).toBe('n8n');
    }
  }, 30_000);
});
