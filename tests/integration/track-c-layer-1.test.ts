import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runTrackCLayer1 } from '../../src/gates/run-track-c-layer-1.js';
import { generateMcpbBundle } from '../../src/adapters/mcpb-adapter/generate-mcpb-bundle.js';
import type { McpbBundleSpec } from '../../src/adapters/mcpb-adapter/types.js';

function sampleSpec(): McpbBundleSpec {
  return {
    name: 'multi-tool',
    displayName: 'Multi Tool',
    version: '1.0.0',
    description: 'A test multi-tool MCP server.',
    sourceMcpPackageName: '@g-digital/mcp-multi-tool',
    sourceRepoUrl: 'https://github.com/g-digital-by-Garrigues/multi-tool-mcp',
    author: { name: 'g-digital by Garrigues' },
    keywords: ['mcp', 'test'],
    operations: [
      { name: 'get_widget', description: 'Fetch a widget by id.' },
      { name: 'list_widgets', description: 'List widgets.' },
    ],
    userConfig: [
      {
        envName: 'TEST_API_KEY',
        configKey: 'test_api_key',
        title: 'Test Api Key',
        description: 'API key for the test backend.',
        sensitive: true,
        required: true,
      },
      {
        envName: 'TEST_BASE_URL',
        configKey: 'test_base_url',
        title: 'Test Base Url',
        description: 'Base URL of the test backend.',
        sensitive: false,
        required: true,
      },
    ],
    entryPoint: 'server/index.js',
    smitheryNamespace: 'g-digital',
  };
}

async function writeStubSourceMcp(sourceDir: string): Promise<void> {
  await fs.mkdir(path.join(sourceDir, 'dist'), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'package.json'),
    JSON.stringify({ name: '@g-digital/mcp-multi-tool', version: '1.0.0', main: 'dist/server.js' }, null, 2),
  );
  await fs.writeFile(path.join(sourceDir, 'dist', 'server.js'), 'console.log("server entry");\n');
}

/**
 * Story 5.10a: Layer 1 takes a fully-populated bundle tree (post-CLI-shim).
 * The shim runs `npm install --omit=dev` + `mcpb pack`, neither of which we
 * want to invoke in a unit test. So each test calls generateMcpbBundle to get
 * the templated tree, then synthesises the CLI-shim outputs (an empty
 * server/node_modules/ dir + an empty <name>-v<version>.mcpb file) so the
 * file_layout check has something to find.
 */
async function fakeCliShimArtifacts(bundleDir: string, spec: McpbBundleSpec): Promise<void> {
  await fs.mkdir(path.join(bundleDir, 'server', 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(bundleDir, `${spec.name}-v${spec.version}.mcpb`), 'PK\x03\x04stub-zip');
}

describe('Track C — Layer 1 (structural lint)', () => {
  let bundleDir: string;
  let sourceMcpDir: string;
  beforeEach(async () => {
    bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-c-l1-bundle-'));
    sourceMcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-c-l1-src-'));
    await writeStubSourceMcp(sourceMcpDir);
  });
  afterEach(async () => {
    await fs.rm(bundleDir, { recursive: true, force: true });
    await fs.rm(sourceMcpDir, { recursive: true, force: true });
  });

  it('happy path: passes every check against a freshly generated + CLI-shimmed bundle', async () => {
    const spec = sampleSpec();
    await generateMcpbBundle({ spec, outputDir: bundleDir, sourceMcpDir });
    await fakeCliShimArtifacts(bundleDir, spec);
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.log.event).toBe('gate.track_c_layer_1_passed');
  });

  it('fails file_layout when the packed .mcpb is missing (CLI shim never ran or mcpb pack failed)', async () => {
    const spec = sampleSpec();
    await generateMcpbBundle({ spec, outputDir: bundleDir, sourceMcpDir });
    // intentionally skip fakeCliShimArtifacts to leave .mcpb + node_modules absent
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(false);
    const layoutError = result.errors.find((e) => e.check === 'file_layout');
    expect(layoutError).toBeDefined();
    expect(layoutError!.observation).toContain('multi-tool-v1.0.0.mcpb');
    expect(layoutError!.observation).toContain('server/node_modules');
    expect(layoutError!.target).toBe('smithery');
    expect(layoutError!.layer).toBe(1);
  });

  it("fails manifest when manifest_version doesn't match the pinned 0.3", async () => {
    const spec = sampleSpec();
    await generateMcpbBundle({ spec, outputDir: bundleDir, sourceMcpDir });
    await fakeCliShimArtifacts(bundleDir, spec);
    // Corrupt the manifest's spec version.
    const manifestPath = path.join(bundleDir, 'manifest.json');
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { manifest_version: string };
    m.manifest_version = '0.2';
    await fs.writeFile(manifestPath, JSON.stringify(m, null, 2));
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(false);
    const manifestError = result.errors.find((e) => e.check === 'manifest');
    expect(manifestError).toBeDefined();
    expect(manifestError!.observation).toContain("manifest_version='0.2'");
  });

  it("fails user_config when a spec env var has no corresponding user_config entry", async () => {
    const spec = sampleSpec();
    await generateMcpbBundle({ spec, outputDir: bundleDir, sourceMcpDir });
    await fakeCliShimArtifacts(bundleDir, spec);
    const manifestPath = path.join(bundleDir, 'manifest.json');
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { user_config: Record<string, unknown> };
    delete m.user_config['test_api_key'];
    await fs.writeFile(manifestPath, JSON.stringify(m, null, 2));
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(false);
    const ucError = result.errors.find((e) => e.check === 'user_config');
    expect(ucError).toBeDefined();
    expect(ucError!.observation).toContain("user_config['test_api_key'] missing");
  });

  it("fails user_config when mcp_config.env substitution references the wrong key", async () => {
    const spec = sampleSpec();
    await generateMcpbBundle({ spec, outputDir: bundleDir, sourceMcpDir });
    await fakeCliShimArtifacts(bundleDir, spec);
    const manifestPath = path.join(bundleDir, 'manifest.json');
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      server: { mcp_config: { env: Record<string, string> } };
    };
    m.server.mcp_config.env['TEST_API_KEY'] = '${user_config.wrong_key}';
    await fs.writeFile(manifestPath, JSON.stringify(m, null, 2));
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(false);
    const ucError = result.errors.find((e) => e.check === 'user_config');
    expect(ucError!.observation).toContain("mcp_config.env['TEST_API_KEY']");
  });

  it("fails readme when an operation is not mentioned", async () => {
    const spec = sampleSpec();
    await generateMcpbBundle({ spec, outputDir: bundleDir, sourceMcpDir });
    await fakeCliShimArtifacts(bundleDir, spec);
    const readmePath = path.join(bundleDir, 'README.md');
    const original = await fs.readFile(readmePath, 'utf8');
    await fs.writeFile(readmePath, original.replace(/`get_widget`/g, '`removed_widget`'));
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(false);
    const readmeError = result.errors.find((e) => e.check === 'readme');
    expect(readmeError!.observation).toContain('get_widget');
  });

  it('emits log.event = track_c_layer_1_failed when any check fails', async () => {
    const spec = sampleSpec();
    // Empty bundleDir → every check that depends on the manifest/readme fails too.
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.track_c_layer_1_failed');
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('every emitted ErrorReport carries the canonical Track C shape (stage=gate, layer=1, target=smithery)', async () => {
    const spec = sampleSpec();
    const result = await runTrackCLayer1({ mcpName: 'multi-tool', bundleDir, spec });
    for (const e of result.errors) {
      expect(e.stage).toBe('gate');
      expect(e.layer).toBe(1);
      expect(e.target).toBe('smithery');
      expect(e.check.length).toBeGreaterThan(0);
      expect(e.observation.length).toBeGreaterThan(0);
      expect(e.cause.length).toBeGreaterThan(0);
      expect(e.action.length).toBeGreaterThan(0);
    }
  });
});
