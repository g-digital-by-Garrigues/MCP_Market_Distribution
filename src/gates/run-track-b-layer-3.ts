import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import {
  runInspectorHarness,
  type InspectorSampleCallInput,
  type InspectorSampleCallResult,
} from './inspector-harness.js';
import type { ErrorReport } from '../schemas/error-report.schema.js';
import type { N8nNodeSpec, N8nProperty } from '../adapters/n8n-adapter/types.js';
import { resolveMcpEntryRelPath } from '../utils/resolve-mcp-entry.js';

// Story 5.4: Track B — Layer 3 (per-operation smoke).
//
// FR30 reads: "each operation exposed by the n8n node, when invoked
// with sample inputs, returns a structurally valid response without
// contacting real APIs."
//
// The n8n node delegates every operation 1:1 to a `tools/call` on the
// source MCP, so we satisfy the contract by:
//   1. Building a synthetic args dict for each operation from the
//      N8nNodeSpec's property descriptors (one arg per property,
//      defaulting to the property's `default` value or a per-type
//      placeholder).
//   2. Spawning the source MCP and issuing the corresponding
//      tools/call via inspector-harness.
//   3. Verifying the response is either (a) a success with a `content`
//      array (per MCP protocol) or (b) a typed protocol/application
//      error (e.g. "missing required parameter X" or "OKTA_CLIENT_ID
//      not set"). Both prove the MCP received + processed the call;
//      neither contacts a real backend in CI.
//
// We do NOT compile + load the n8n node here — that's Layer 2's job.
// The output of Layer 3 is a per-operation pass/fail with the offending
// observation surfaced into a single ErrorReport (one per failed op).

const PLACEHOLDER_STRING = 'placeholder';

function gateError(
  check: string,
  fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>,
): ErrorReport {
  return { stage: 'gate', layer: 3, target: 'n8n', check, ...fields };
}

export interface TrackBLayer3CheckResult {
  /** Operation name probed (or 'launch' for the spawn-level failure). */
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackBLayer3Result {
  passed: boolean;
  mcpName: string;
  operations_checked: string[];
  checks: TrackBLayer3CheckResult[];
  errors: ErrorReport[];
  log: {
    event: 'gate.track_b_layer_3_passed' | 'gate.track_b_layer_3_failed';
    pipeline_run_id?: string;
  };
}

export interface RunTrackBLayer3Options {
  mcpName: string;
  spec: N8nNodeSpec;
  /**
   * Absolute path to the source MCP's package dir, e.g.
   * `pending-to-publish/<mcp_name>/`. We spawn `node dist/server.js`
   * relative to this.
   */
  packageDir: string;
  pipelineRunId?: string;
  serverCommand?: string;
  serverArgs?: readonly string[];
  timeoutMs?: number;
}

function placeholderForProperty(p: N8nProperty): unknown {
  // Prefer the spec's existing default — keeps args sensible for enum
  // (options) properties. Fall back to type-specific neutrals.
  if (p.default !== undefined && p.default !== null && p.default !== '') {
    return p.default;
  }
  switch (p.type) {
    case 'string':
      return PLACEHOLDER_STRING;
    case 'number':
      return p.numberConstraints?.minValue ?? 0;
    case 'boolean':
      return false;
    case 'options':
      // Options always carry an array; the codegen picks the first as default.
      return p.options?.[0]?.value ?? '';
    case 'json':
      return {};
  }
}

function buildArgsForOperation(op: N8nNodeSpec['operations'][number]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const prop of op.properties) {
    args[prop.name] = placeholderForProperty(prop);
  }
  return args;
}

// Classifies a tools/call response as "structurally valid" per the
// FR30 contract. A success with `content` is the clear pass. A failure
// with an error that mentions auth/credentials/network/required is
// ALSO a pass — it proves the MCP accepted the call and got far enough
// to reject for a backend reason. The only real failures are
// protocol-level "method not found" or unparseable responses, which
// indicate the n8n node's operation name does not match the MCP's
// actual tools/list.
function classifySampleResult(r: InspectorSampleCallResult): { ok: boolean; reason: string } {
  if (r.ok) {
    const resp = r.response as { content?: unknown } | undefined;
    if (resp && Array.isArray((resp as { content?: unknown }).content)) {
      return { ok: true, reason: 'mcp returned content array' };
    }
    // Response without `content` is suspicious but not necessarily wrong
    // — some MCPs return `{ result: ... }` directly. Accept anything truthy.
    return { ok: resp !== undefined, reason: resp !== undefined ? 'non-empty success response' : 'empty success response' };
  }
  const err = (r.error ?? '').toLowerCase();
  // Method-not-found is the one case we DO want to flag — that means
  // the n8n operation name doesn't match the MCP's tools/list, which is
  // exactly the codegen drift Layer 3 should catch.
  if (/method not found|-32601|unknown tool/.test(err)) {
    return { ok: false, reason: `MCP rejected the tool call with 'method not found' — codegen drift between n8n op name and MCP tools/list?` };
  }
  // Treat auth / network / required-argument errors as "MCP processed
  // the call". Anything else (timeouts, JSON parse errors) is a real
  // failure.
  if (
    /credential|auth|unauthorized|forbidden|api[_ -]?key|client[_ -]?id|client[_ -]?secret/.test(err)
  ) {
    return { ok: true, reason: 'MCP responded with an auth/credential error (expected in CI without secrets)' };
  }
  if (/required|missing|invalid|validation|enum/.test(err)) {
    return { ok: true, reason: 'MCP responded with an input-validation error (structurally valid)' };
  }
  if (/network|econn|enotfound|fetch failed|backend/.test(err)) {
    return { ok: true, reason: 'MCP responded with a backend/network error (structurally valid)' };
  }
  return { ok: false, reason: `MCP returned an unclassified error: ${(r.error ?? '').slice(0, 300)}` };
}

export async function runTrackBLayer3(
  opts: RunTrackBLayer3Options,
): Promise<TrackBLayer3Result> {
  const command = opts.serverCommand ?? 'node';
  const args = opts.serverArgs ?? [await resolveMcpEntryRelPath(opts.packageDir)];
  const resolvedArgs = args.map((a) =>
    path.isAbsolute(a) ? a : path.resolve(opts.packageDir, a),
  );

  const sampleInputs: InspectorSampleCallInput[] = opts.spec.operations.map((op) => ({
    toolName: op.name,
    arguments: buildArgsForOperation(op),
  }));

  const probe = await runInspectorHarness({
    command,
    args: resolvedArgs,
    sampleInputs,
    ...(typeof opts.timeoutMs === 'number' ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const checks: TrackBLayer3CheckResult[] = [];

  if (probe.launch_error) {
    checks.push({
      name: 'launch',
      passed: false,
      error: gateError('launch', {
        observation: `Source MCP failed to launch for Layer 3: ${probe.launch_error}.`,
        cause: 'The compiled source MCP did not start. Layer 2 (compile gate on Track A or B) should normally catch this.',
        action: `Re-run /prep-mcp ${opts.mcpName} and ensure the MCP builds cleanly, then /retry-publish?step=gate.`,
      }),
    });
    const errors = checks.filter((c) => !c.passed).map((c) => c.error!);
    return {
      passed: false,
      mcpName: opts.mcpName,
      operations_checked: [],
      checks,
      errors,
      log: {
        event: 'gate.track_b_layer_3_failed',
        ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
      },
    };
  }
  if (!probe.initialize_succeeded) {
    checks.push({
      name: 'initialize',
      passed: false,
      error: gateError('initialize', {
        observation: `Source MCP failed the initialize handshake: ${probe.initialize_error ?? 'unknown'}.`,
        cause: 'The MCP started but did not implement the initialize handshake correctly.',
        action: 'Run the Layer 2 gate of Track A locally; if it passes there but fails here, file an issue with both logs attached.',
      }),
    });
  }

  const operations_checked: string[] = [];
  for (const r of probe.sample_call_results) {
    operations_checked.push(r.toolName);
    const classified = classifySampleResult(r);
    if (classified.ok) {
      checks.push({ name: r.toolName, passed: true });
      continue;
    }
    checks.push({
      name: r.toolName,
      passed: false,
      error: gateError('per_operation_smoke', {
        observation: `Operation '${r.toolName}' smoke probe failed: ${classified.reason}.`,
        cause: 'The n8n node\'s operation does not roundtrip through the source MCP — likely a codegen drift between the operation name in OPERATION_PROPERTY_NAMES and the MCP\'s actual tools/list.',
        action: `Re-run the n8n adapter generator and confirm the source MCP exposes '${r.toolName}' via tools/list. If the tool was renamed, regenerate the adapter and re-run /retry-publish?step=gate.`,
        source_path: `nodes/${opts.spec.className}/${opts.spec.className}.node.ts`,
      }),
    });
  }

  const errors = checks.filter((c) => !c.passed).map((c) => c.error!);
  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    operations_checked,
    checks,
    errors,
    log: {
      event: passed ? 'gate.track_b_layer_3_passed' : 'gate.track_b_layer_3_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const specPath = process.argv[3];
  const packageDir = process.argv[4];
  if (!mcpName || !specPath || !packageDir) {
    process.stderr.write('Usage: tsx src/gates/run-track-b-layer-3.ts <mcp-name> <spec-json> <package-dir>\n');
    return 2;
  }
  let spec: N8nNodeSpec;
  try {
    spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as N8nNodeSpec;
  } catch (err) {
    process.stderr.write(`Could not read spec at ${specPath}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = await runTrackBLayer3({
    mcpName,
    spec,
    packageDir,
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
