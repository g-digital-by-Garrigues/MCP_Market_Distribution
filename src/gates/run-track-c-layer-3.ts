import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  runInspectorHarness,
  type InspectorResult,
} from './inspector-harness.js';
import type { ErrorReport } from '../schemas/error-report.schema.js';
import type { McpbBundleSpec } from '../adapters/mcpb-adapter/types.js';

// Story 5.10c: Track C — Layer 3 (runtime roundtrip).
//
// Spawns the BUNDLED server (from <bundleDir>/server/<entry_point>)
// with synthetic user_config env values and confirms the live MCP
// responds to the initialize handshake + tools/list with the same
// operation count + names the spec declares.
//
// Why the pre-pack dir, not the unzipped .mcpb: when an MCPB host
// unpacks the ZIP it produces this same directory layout. Layer 2
// already validated the ZIP itself via `mcpb validate`; Layer 3's
// concern is "does the bundled server actually start and expose the
// declared tools," which is the same regardless of whether we unzip
// here or use the staging dir.
//
// Synthetic env strategy: for each spec.userConfig field we set its
// envName to `placeholder-<configKey>`. The bundled MCP MIGHT fail
// later when it tries to use the value (e.g. Okta client_credentials
// will get 401), but tools/list only requires the server to start;
// it does not need a successful auth. If a particular MCP refuses to
// start without real credentials, that's a bug in the source MCP's
// startup ordering — Layer 3 surfaces it here before publish.

const DEFAULT_TIMEOUT_MS = 60 * 1000;

function gateError(
  check: string,
  fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>,
): ErrorReport {
  return { stage: 'gate', layer: 3, target: 'smithery', check, ...fields };
}

export interface TrackCLayer3CheckResult {
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackCLayer3Result {
  passed: boolean;
  mcpName: string;
  checks: TrackCLayer3CheckResult[];
  errors: ErrorReport[];
  tools_listed: string[];
  log: {
    event: 'gate.track_c_layer_3_passed' | 'gate.track_c_layer_3_failed';
    pipeline_run_id?: string;
  };
}

export interface RunTrackCLayer3Options {
  mcpName: string;
  spec: McpbBundleSpec;
  /** Absolute path to the pre-pack bundle directory. */
  bundleDir: string;
  pipelineRunId?: string;
  timeoutMs?: number;
}

export interface RunTrackCLayer3Deps {
  runInspector?: typeof runInspectorHarness;
}

function syntheticEnv(spec: McpbBundleSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const cfg of spec.userConfig) {
    env[cfg.envName] = `placeholder-${cfg.configKey}`;
  }
  return env;
}

export async function runTrackCLayer3(
  opts: RunTrackCLayer3Options,
  deps: RunTrackCLayer3Deps = {},
): Promise<TrackCLayer3Result> {
  const inspect = deps.runInspector ?? runInspectorHarness;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const entryPath = path.join(opts.bundleDir, opts.spec.entryPoint);
  // Cheap pre-flight: refuse to spawn if the entry file is missing.
  // The harness would also fail, but this gives a clearer error.
  try {
    await fs.access(entryPath);
  } catch {
    const err = gateError('launch', {
      observation: `Entry file ${opts.spec.entryPoint} not found under bundleDir. Cannot spawn the bundled server.`,
      cause: 'The CLI shim did not stage the source MCP\'s dist/ into the bundle correctly (or the spec.entryPoint drifted from generator output).',
      action: 'Re-run run-mcpb-adapter-build.ts and inspect for write failures during the stage step in generateMcpbBundle.',
      source_path: opts.spec.entryPoint,
    });
    return {
      passed: false,
      mcpName: opts.mcpName,
      checks: [{ name: 'launch', passed: false, error: err }],
      errors: [err],
      tools_listed: [],
      log: {
        event: 'gate.track_c_layer_3_failed',
        ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
      },
    };
  }

  let probe: InspectorResult;
  try {
    probe = await inspect({
      command: process.execPath,
      args: [entryPath],
      env: syntheticEnv(opts.spec),
      timeoutMs,
    });
  } catch (e) {
    const err = gateError('launch', {
      observation: `inspector-harness threw before completing: ${(e as Error).message}`,
      cause: 'Spawn-level failure — the bundled node entry could not be launched at all.',
      action: 'Verify Node version >= 20 in CI and that server/node_modules/ was populated by the CLI shim.',
    });
    return {
      passed: false,
      mcpName: opts.mcpName,
      checks: [{ name: 'launch', passed: false, error: err }],
      errors: [err],
      tools_listed: [],
      log: {
        event: 'gate.track_c_layer_3_failed',
        ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
      },
    };
  }

  const checks: TrackCLayer3CheckResult[] = [];
  const errors: ErrorReport[] = [];

  if (probe.launch_error) {
    const err = gateError('launch', {
      observation: `Bundled MCP failed to launch: ${probe.launch_error}`,
      cause: 'The node process exited before the MCP initialize handshake could complete.',
      action: 'Re-build the source MCP (npm run build), re-run the adapter build, and check stderr from the spawned process.',
    });
    checks.push({ name: 'launch', passed: false, error: err });
    errors.push(err);
  } else if (!probe.initialize_succeeded) {
    const err = gateError('initialize', {
      observation: `MCP initialize handshake failed: ${probe.initialize_error ?? 'unknown'}`,
      cause: 'The bundled server started but did not complete the MCP protocol handshake (initialize → result).',
      action: 'Inspect the source MCP\'s startup ordering — Layer 3 spawns it with placeholder env values, so a real-credential dependency in startup is the usual culprit.',
    });
    checks.push({ name: 'initialize', passed: false, error: err });
    errors.push(err);
  } else if (probe.tools_list_error) {
    const err = gateError('tools_list', {
      observation: `tools/list returned an error: ${probe.tools_list_error}`,
      cause: 'The bundled server initialized but rejected the tools/list call.',
      action: 'Inspect the source MCP — tools/list should never require credentials. This is a bug in the source.',
    });
    checks.push({ name: 'tools_list', passed: false, error: err });
    errors.push(err);
  } else {
    const expected = new Set(opts.spec.operations.map((o) => o.name));
    const got = new Set(probe.tools_list.map((t) => t.name));
    const missing = [...expected].filter((n) => !got.has(n));
    const extra = [...got].filter((n) => !expected.has(n));
    if (missing.length === 0 && extra.length === 0) {
      checks.push({ name: 'tools_list', passed: true });
    } else {
      const err = gateError('tools_list', {
        observation: `tools/list mismatch — missing: ${missing.join(', ') || '(none)'}; unexpected: ${extra.join(', ') || '(none)'}.`,
        cause: 'The bundled server exposes a different set of tools than the spec was built from. The source MCP likely changed between when the spec was built and when the bundle was packed.',
        action: 'Re-run buildMcpbBundleSpec (the spec is derived from tools/list of the source MCP). If the diff is intentional, regenerate. If unexpected, investigate the source MCP\'s tool registration.',
      });
      checks.push({ name: 'tools_list', passed: false, error: err });
      errors.push(err);
    }
  }

  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    checks,
    errors,
    tools_listed: probe.tools_list.map((t) => t.name),
    log: {
      event: passed ? 'gate.track_c_layer_3_passed' : 'gate.track_c_layer_3_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

async function readSpec(specPath: string): Promise<McpbBundleSpec> {
  const raw = await fs.readFile(specPath, 'utf8');
  return JSON.parse(raw) as McpbBundleSpec;
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const bundleDir = process.argv[3];
  const specPath = process.argv[4] ?? (bundleDir ? path.join(bundleDir, '.spec.json') : undefined);
  if (!mcpName || !bundleDir || !specPath) {
    process.stderr.write('Usage: tsx src/gates/run-track-c-layer-3.ts <mcp-name> <bundle-dir> [<spec-json>]\n');
    return 2;
  }
  let spec: McpbBundleSpec;
  try {
    spec = await readSpec(specPath);
  } catch (err) {
    process.stderr.write(`Could not read spec at ${specPath}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = await runTrackCLayer3({
    mcpName,
    spec,
    bundleDir,
    ...(process.env.PIPELINE_RUN_ID ? { pipelineRunId: process.env.PIPELINE_RUN_ID } : {}),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.passed ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
