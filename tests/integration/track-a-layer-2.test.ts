import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runTrackALayer2 } from '../../src/gates/run-track-a-layer-2.js';
import { errorReportSchema } from '../../src/schemas/error-report.schema.js';
import { writeTestConfig } from '../helpers/write-test-config.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'test-mcp',
);
const STUB_HAPPY = path.join(FIXTURES_DIR, 'server-happy.mjs');
const STUB_THROWS = path.join(FIXTURES_DIR, 'server.mjs');
const STUB_NO_DESC = path.join(FIXTURES_DIR, 'server-no-description.mjs');
const STUB_NO_HANDLER = path.join(FIXTURES_DIR, 'server-advertise-no-handler.mjs');
const SAMPLE_INPUTS_PATH = path.join(FIXTURES_DIR, 'sample-tool-inputs.json');

async function tempRepoRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'layer-2-'));
}

// Writes the minimal mcp-pipeline.yaml + per-MCP .distribution.yaml that
// Layer 2 expects. `tools` is the list the test wants to compare against
// the server's advertised tools/list. Pass null to omit the field
// entirely (which makes the drift check a no-op).
async function writeConfig(
  repoRoot: string,
  mcpName: string,
  tools: Array<{ name: string; description: string }> | null,
): Promise<void> {
  const distributionOverrides: Record<string, unknown> = {
    reverse_dns_name: `io.github.example/${mcpName}`,
    npm_scope: '@example',
    npm_package_name: `@example/${mcpName}`,
    docker_image_name: `example/${mcpName}`,
    n8n_adapter_target_name: `n8n-nodes-${mcpName}`,
    credential_help_url: 'https://example.com',
    track_b_targets: [],
  };
  if (tools !== null) distributionOverrides.tools = tools;
  await writeTestConfig({
    repoRoot,
    mcpName,
    distributionOverrides,
  });
}

describe('Track A — Layer 2 protocol smoke test gate', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('happy path: passes when initialize + tools_list + tools_call all succeed with sample inputs', async () => {
    repoRoot = await tempRepoRoot();
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp',
      serverCommand: process.execPath,
      serverArgs: [STUB_HAPPY],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      pipelineRunId: 'run-7',
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(true);
    expect(result.log.event).toBe('gate.layer_2_passed');
    expect(result.log.pipeline_run_id).toBe('run-7');
    expect(result.tools_checked).toEqual(['echo']);
    expect(result.errors).toEqual([]);
  }, 60_000);

  it('failure: an advertised tool throws on tools/call → recorded as tools_call_probe', async () => {
    repoRoot = await tempRepoRoot();
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp-throws',
      serverCommand: process.execPath,
      serverArgs: [STUB_THROWS],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(false);
    const probeError = result.errors.find(
      (e) => e.check === 'tools_call_probe' && e.observation.includes('always_fails'),
    );
    expect(probeError).toBeDefined();
    expect(probeError!.action).toMatch(/sample-tool-inputs\.json/);
  }, 60_000);

  it('failure: tool advertised but tools/call returns -32601 → AC-mandated cause + action', async () => {
    repoRoot = await tempRepoRoot();
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp-no-handler',
      serverCommand: process.execPath,
      serverArgs: [STUB_NO_HANDLER],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.layer_2_failed');
    const probeError = result.errors.find((e) => e.check === 'tools_call_probe');
    expect(probeError).toBeDefined();
    expect(probeError!.observation).toContain('ghost_tool');
    expect(probeError!.observation).toContain('-32601');
    expect(probeError!.cause).toContain('Handler not registered');
    expect(probeError!.action).toContain('src/server.ts');
    expect(probeError!.action).toContain('ghost_tool');
    expect(errorReportSchema.safeParse(probeError).success).toBe(true);
  }, 60_000);

  it('failure: tool description is empty → tool_description error per tool', async () => {
    repoRoot = await tempRepoRoot();
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp-no-desc',
      serverCommand: process.execPath,
      serverArgs: [STUB_NO_DESC],
      serverCwd: FIXTURES_DIR,
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(false);
    const descError = result.errors.find((e) => e.check === 'tool_description');
    expect(descError).toBeDefined();
    expect(descError!.observation).toContain('mystery');
    expect(descError!.observation).toContain('empty description');
  }, 60_000);

  it('failure: server cannot be launched → initialize error with launch_error context', async () => {
    repoRoot = await tempRepoRoot();
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'nonexistent',
      serverCommand: 'this-binary-does-not-exist-on-the-runner',
      serverArgs: [],
      serverCwd: FIXTURES_DIR,
      timeoutMs: 5_000,
    });
    expect(result.passed).toBe(false);
    const initError = result.errors.find((e) => e.check === 'initialize');
    expect(initError).toBeDefined();
    expect(initError!.cause).toContain('could not be launched');
  }, 30_000);

  it('every emitted error carries the canonical stage/layer/target shape', async () => {
    repoRoot = await tempRepoRoot();
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp-no-handler',
      serverCommand: process.execPath,
      serverArgs: [STUB_NO_HANDLER],
      serverCwd: FIXTURES_DIR,
      timeoutMs: 15_000,
    });
    for (const err of result.errors) {
      expect(err.stage).toBe('gate');
      expect(err.layer).toBe(2);
      expect(err.target).toBeNull();
    }
  }, 60_000);

  // tools_yaml_drift cross-check (v1.1 item 5): the Docker MCP Catalog
  // publisher feeds `.distribution.yaml#tools` to servers/<mcp>/
  // tools.json. If it drifts from what the server actually advertises via
  // tools/list, consumers see a wrong tool list. Layer 2 owns the protocol
  // contract — drift fails the gate.

  it('tools_yaml_drift: yaml tools list matches server → no drift error', async () => {
    repoRoot = await tempRepoRoot();
    await writeConfig(repoRoot, 'test-mcp', [
      { name: 'echo', description: 'Echoes the input back.' },
    ]);
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp',
      serverCommand: process.execPath,
      serverArgs: [STUB_HAPPY],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(true);
    expect(result.errors.find((e) => e.check === 'tools_yaml_drift')).toBeUndefined();
  }, 60_000);

  it('tools_yaml_drift: yaml has tool the server does NOT advertise → fails with onlyInYaml drift', async () => {
    repoRoot = await tempRepoRoot();
    await writeConfig(repoRoot, 'test-mcp', [
      { name: 'echo', description: 'Echoes the input back.' },
      { name: 'phantom_tool', description: 'Listed but not implemented.' },
    ]);
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp',
      serverCommand: process.execPath,
      serverArgs: [STUB_HAPPY],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(false);
    const drift = result.errors.find((e) => e.check === 'tools_yaml_drift');
    expect(drift).toBeDefined();
    expect(drift!.observation).toContain('phantom_tool');
    expect(drift!.observation).toContain('but NOT advertised by src/server.ts');
    expect(drift!.action).toContain('Remove the obsolete tool');
    expect(errorReportSchema.safeParse(drift).success).toBe(true);
  }, 60_000);

  it('tools_yaml_drift: server advertises a tool MISSING from yaml → fails with onlyInServer drift', async () => {
    repoRoot = await tempRepoRoot();
    // Empty tools list — server's 'echo' is not in yaml.
    await writeConfig(repoRoot, 'test-mcp', []);
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp',
      serverCommand: process.execPath,
      serverArgs: [STUB_HAPPY],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      timeoutMs: 15_000,
    });
    expect(result.passed).toBe(false);
    const drift = result.errors.find((e) => e.check === 'tools_yaml_drift');
    expect(drift).toBeDefined();
    expect(drift!.observation).toContain('echo');
    expect(drift!.observation).toContain('missing from mcp-pipeline.yaml');
    expect(drift!.action).toContain('Add the missing tool');
  }, 60_000);

  it('tools_yaml_drift: yaml has no `tools` field → drift check is SKIPPED (backward compat)', async () => {
    repoRoot = await tempRepoRoot();
    // tools=null → omit the field entirely from the yaml entry.
    await writeConfig(repoRoot, 'test-mcp', null);
    const result = await runTrackALayer2({
      repoRoot,
      mcpName: 'test-mcp',
      serverCommand: process.execPath,
      serverArgs: [STUB_HAPPY],
      serverCwd: FIXTURES_DIR,
      sampleInputsPath: SAMPLE_INPUTS_PATH,
      timeoutMs: 15_000,
    });
    // Should pass — no drift error because we didn't opt into the static list.
    expect(result.errors.find((e) => e.check === 'tools_yaml_drift')).toBeUndefined();
    expect(result.passed).toBe(true);
  }, 60_000);
});
