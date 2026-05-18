import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTrackBLayer1 } from '../../src/gates/run-track-b-layer-1.js';
import { generateN8nNode } from '../../src/adapters/n8n-adapter/generate-n8n-node.js';
import type { N8nNodeSpec } from '../../src/adapters/n8n-adapter/types.js';

function sampleSpec(): N8nNodeSpec {
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
    operations: [
      {
        name: 'get_widget',
        displayName: 'Get Widget',
        description: 'Fetch a widget by id.',
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
        description: 'List widgets.',
        properties: [],
      },
    ],
    credentials: [
      { envName: 'TEST_API_KEY', displayName: 'Test Api Key', isSecret: true },
      { envName: 'TEST_BASE_URL', displayName: 'Test Base Url', isSecret: false },
    ],
  };
}

describe('Track B — Layer 1 (structural lint)', () => {
  let nodeDir: string;
  beforeEach(async () => {
    nodeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-b-l1-'));
  });
  afterEach(async () => {
    await fs.rm(nodeDir, { recursive: true, force: true });
  });

  it('happy path: passes every check against a freshly generated node tree', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir });
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.log.event).toBe('gate.track_b_layer_1_passed');
  });

  it('fails file_layout when a generated file is missing', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir });
    await fs.rm(path.join(nodeDir, 'index.ts'));
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const layoutError = result.errors.find((e) => e.check === 'file_layout');
    expect(layoutError).toBeDefined();
    expect(layoutError!.observation).toContain('index.ts');
    expect(layoutError!.stage).toBe('gate');
    expect(layoutError!.layer).toBe(1);
    expect(layoutError!.target).toBe('n8n');
  });

  it('fails package_json when the source MCP dep is not pinned to spec.version', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir });
    // Corrupt the package.json's source-MCP dep version.
    const pkgPath = path.join(nodeDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies[spec.sourceMcpPackageName] = '0.0.1';
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const pkgError = result.errors.find((e) => e.check === 'package_json');
    expect(pkgError).toBeDefined();
    expect(pkgError!.observation).toContain('pin version');
  });

  it("fails node_class when an operation is missing from OPERATION_PROPERTY_NAMES", async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir });
    // Surgically strip get_widget from the OPERATION_PROPERTY_NAMES table
    // (and the dropdown, just to amplify) to simulate a template drift bug.
    const nodePath = path.join(nodeDir, 'nodes', 'MultiTool', 'MultiTool.node.ts');
    const original = await fs.readFile(nodePath, 'utf8');
    const tampered = original
      .replace(/'get_widget':[^\n]*\n/, '')
      .replace(/value: 'get_widget',?/g, '');
    await fs.writeFile(nodePath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const nodeError = result.errors.find((e) => e.check === 'node_class');
    expect(nodeError).toBeDefined();
    expect(nodeError!.observation).toContain("get_widget");
  });

  it('fails credentials when one of the spec env vars is absent from the credentials class', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir });
    const credPath = path.join(nodeDir, 'credentials', 'MultiToolApi.credentials.ts');
    const original = await fs.readFile(credPath, 'utf8');
    const tampered = original.replace(/name: 'TEST_API_KEY'/, "name: 'WRONG_NAME'");
    await fs.writeFile(credPath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const credError = result.errors.find((e) => e.check === 'credentials');
    expect(credError).toBeDefined();
    expect(credError!.observation).toContain('TEST_API_KEY');
  });

  it('fails readme when an operation is not mentioned in the README', async () => {
    const spec = sampleSpec();
    await generateN8nNode({ spec, outputDir: nodeDir });
    const readmePath = path.join(nodeDir, 'README.md');
    const original = await fs.readFile(readmePath, 'utf8');
    // Replace ALL get_widget mentions (table row AND any other reference).
    const tampered = original.replace(/`get_widget`/g, '`removed_widget`');
    await fs.writeFile(readmePath, tampered);
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    const readmeError = result.errors.find((e) => e.check === 'readme');
    expect(readmeError).toBeDefined();
    expect(readmeError!.observation).toContain('get_widget');
  });

  it('emits log.event = track_b_layer_1_failed when any check fails', async () => {
    const spec = sampleSpec();
    // No files generated — every check fails.
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.track_b_layer_1_failed');
    // All 5 checks should have errored.
    expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });

  it('every emitted ErrorReport carries the canonical Track B shape (stage=gate, layer=1, target=n8n)', async () => {
    const spec = sampleSpec();
    const result = await runTrackBLayer1({ mcpName: 'multi-tool', nodeDir, spec });
    for (const e of result.errors) {
      expect(e.stage).toBe('gate');
      expect(e.layer).toBe(1);
      expect(e.target).toBe('n8n');
      expect(e.check.length).toBeGreaterThan(0);
      expect(e.observation.length).toBeGreaterThan(0);
      expect(e.cause.length).toBeGreaterThan(0);
      expect(e.action.length).toBeGreaterThan(0);
    }
  });
});
