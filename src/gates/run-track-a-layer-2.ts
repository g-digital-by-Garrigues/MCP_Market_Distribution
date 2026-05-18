import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  runInspectorHarness,
  type InspectorSampleCallInput,
  type InspectorToolEntry,
} from './inspector-harness.js';
import type { ErrorReport } from '../schemas/error-report.schema.js';
import { loadDistributionConfig } from '../distribution/load-distribution-config.js';

const PLACEHOLDER_STRING = 'placeholder';
const METHOD_NOT_FOUND = -32601;

function gateError(check: string, fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>): ErrorReport {
  return { stage: 'gate', layer: 2, target: null, check, ...fields };
}

export interface RunTrackALayer2Options {
  repoRoot: string;
  mcpName: string;
  /** Defaults to `node`. */
  serverCommand?: string;
  /** Defaults to `['dist/server.js']` relative to `pending-to-publish/<mcpName>/`. */
  serverArgs?: readonly string[];
  /** Defaults to `pending-to-publish/<mcpName>/`. */
  serverCwd?: string;
  /** Defaults to `tests/fixtures/<mcpName>/sample-tool-inputs.json` (optional file). */
  sampleInputsPath?: string;
  pipelineRunId?: string;
  timeoutMs?: number;
}

export interface TrackALayer2Result {
  passed: boolean;
  mcpName: string;
  tools_checked: string[];
  errors: ErrorReport[];
  log: { event: 'gate.layer_2_passed' | 'gate.layer_2_failed'; pipeline_run_id?: string };
}

function pickSampleArgs(
  tool: InspectorToolEntry,
  fixture: Record<string, Record<string, unknown>> | null,
): Record<string, unknown> {
  const fromFixture = fixture?.[tool.name];
  if (fromFixture) return fromFixture;
  const schema = tool.inputSchema as
    | { properties?: Record<string, { type?: string }>; required?: string[] }
    | undefined;
  if (!schema?.required || schema.required.length === 0) return {};
  const firstRequired = schema.required[0];
  if (!firstRequired) return {};
  const propType = schema.properties?.[firstRequired]?.type;
  let value: unknown = PLACEHOLDER_STRING;
  if (propType === 'number' || propType === 'integer') value = 0;
  else if (propType === 'boolean') value = false;
  else if (propType === 'array') value = [];
  else if (propType === 'object') value = {};
  return { [firstRequired]: value };
}

function extractMcpErrorCode(error: string | undefined): number | null {
  if (!error) return null;
  // Try parse JSON-RPC error embedded in the message.
  const match = error.match(/[-+]?\d{3,5}/);
  if (!match) return null;
  const code = Number(match[0]);
  return Number.isFinite(code) ? code : null;
}

async function loadFixture(
  fixturePath: string,
): Promise<Record<string, Record<string, unknown>> | null> {
  try {
    const raw = await fs.readFile(fixturePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

// Returns the static tool names declared in the MCP's .distribution.yaml
// (cloned into pending-to-publish/<mcp_name>/ by the checkout-mcp-source
// composite action), or null if the file is missing / the entry has no
// tools field. Returning null lets Layer 2 skip the drift check for MCPs
// that don't opt into the static list (e.g., Track-B-only MCPs whose tools
// array isn't consumed by the Docker MCP Catalog publisher).
async function tryLoadYamlTools(repoRoot: string, mcpName: string): Promise<string[] | null> {
  try {
    const distribution = await loadDistributionConfig(repoRoot, mcpName);
    const tools = distribution.tools;
    if (!tools) return null;
    return tools.map((t) => t.name);
  } catch {
    // No .distribution.yaml or schema mismatch — Layer 1 catches structural
    // problems; we just skip the drift check here.
    return null;
  }
}

export async function runTrackALayer2(
  opts: RunTrackALayer2Options,
): Promise<TrackALayer2Result> {
  const mcpFolder = opts.serverCwd ?? path.join(opts.repoRoot, 'pending-to-publish', opts.mcpName);
  const fixturePath =
    opts.sampleInputsPath ??
    path.join(opts.repoRoot, 'tests', 'fixtures', opts.mcpName, 'sample-tool-inputs.json');
  const fixture = await loadFixture(fixturePath);

  const command = opts.serverCommand ?? 'node';
  const args = opts.serverArgs ? [...opts.serverArgs] : ['dist/server.js'];
  const resolvedArgs = args.map((a) =>
    path.isAbsolute(a) ? a : path.resolve(mcpFolder, a),
  );

  const errors: ErrorReport[] = [];

  const probe = await runInspectorHarness({
    command,
    args: resolvedArgs,
    sampleInputs: [],
    timeoutMs: opts.timeoutMs,
  });

  if (!probe.initialize_succeeded) {
    const detail = probe.launch_error ?? probe.initialize_error ?? 'unknown';
    errors.push(
      gateError('initialize', {
        observation: `MCP server failed to initialize: ${detail}.`,
        cause: probe.launch_error
          ? 'The server binary could not be launched.'
          : 'The server launched but did not complete the initialize handshake.',
        action: 'Run `node dist/server.js` locally to reproduce, fix the error, rebuild, and re-tag.',
      }),
    );
    return {
      passed: false,
      mcpName: opts.mcpName,
      tools_checked: [],
      errors,
      log: { event: 'gate.layer_2_failed', pipeline_run_id: opts.pipelineRunId },
    };
  }

  if (probe.tools_list_error) {
    errors.push(
      gateError('tools_list', {
        observation: `tools/list returned an error: ${probe.tools_list_error}.`,
        cause: 'Server advertises tools capability but tools/list is rejecting the request.',
        action: 'Verify the server registers a ListToolsRequestSchema handler before calling Server.connect().',
      }),
    );
    return {
      passed: false,
      mcpName: opts.mcpName,
      tools_checked: [],
      errors,
      log: { event: 'gate.layer_2_failed', pipeline_run_id: opts.pipelineRunId },
    };
  }

  for (const tool of probe.tools_list) {
    if (!tool.description || tool.description.trim().length === 0) {
      errors.push(
        gateError('tool_description', {
          observation: `Tool '${tool.name}' has an empty description.`,
          cause: 'Marketplaces (Smithery, mcp.so) require a non-empty description per tool.',
          action: `Add a 'description' field when registering '${tool.name}' in src/server.ts.`,
        }),
      );
    }
    if (
      !tool.inputSchema ||
      typeof tool.inputSchema !== 'object' ||
      Array.isArray(tool.inputSchema)
    ) {
      errors.push(
        gateError('tool_input_schema', {
          observation: `Tool '${tool.name}' has no valid inputSchema (got: ${JSON.stringify(tool.inputSchema)}).`,
          cause: 'A JSON Schema object is required so consumers can validate inputs.',
          action: `Provide an 'inputSchema' (JSON Schema object) when registering '${tool.name}'.`,
        }),
      );
    }
  }

  // Cross-check the advertised tools list against mcp-pipeline.yaml#mcps.<id>.tools.
  // The Docker MCP Catalog publisher (PR #70) ships that static list to the
  // catalog's servers/<mcp>/tools.json — if it drifts from what the server
  // actually advertises, consumers see a wrong tool list (either claiming
  // tools that don't exist, or hiding ones that do). Layer 2 owns the
  // protocol contract, so this is where the cross-check lives.
  //
  // We only enforce when entry.tools is defined. MCPs without that field
  // (legacy or Track-B-only) skip the check.
  const yamlTools = await tryLoadYamlTools(opts.repoRoot, opts.mcpName);
  if (yamlTools !== null) {
    const actualNames = new Set(probe.tools_list.map((t) => t.name));
    const expectedNames = new Set(yamlTools);
    const onlyInServer = [...actualNames].filter((n) => !expectedNames.has(n)).sort();
    const onlyInYaml = [...expectedNames].filter((n) => !actualNames.has(n)).sort();
    if (onlyInServer.length > 0) {
      errors.push(
        gateError('tools_yaml_drift', {
          observation: `Tools advertised by src/server.ts but missing from mcp-pipeline.yaml#mcps.${opts.mcpName}.tools: [${onlyInServer.join(', ')}].`,
          cause:
            'Static tools list in mcp-pipeline.yaml is consumed by the Docker MCP Catalog publisher; drift means the catalog submission omits tools that consumers can actually call.',
          action: `Add the missing tool(s) to mcp-pipeline.yaml#mcps.${opts.mcpName}.tools[] with a 'description' field for each.`,
        }),
      );
    }
    if (onlyInYaml.length > 0) {
      errors.push(
        gateError('tools_yaml_drift', {
          observation: `Tools listed in mcp-pipeline.yaml#mcps.${opts.mcpName}.tools but NOT advertised by src/server.ts: [${onlyInYaml.join(', ')}].`,
          cause:
            "Static tools list is out of date — the server no longer registers these tools, so the catalog submission would advertise tools consumers can't actually call.",
          action: `Remove the obsolete tool(s) from mcp-pipeline.yaml#mcps.${opts.mcpName}.tools[] (or restore them in src/server.ts if the removal was unintentional).`,
        }),
      );
    }
  }

  // If no fixture file exists for this MCP, skip the tools_call probe.
  // The fixture file is the engineer's signal "I've defined sample inputs
  // for these tools that don't require external dependencies in CI."
  // Without it, calling tools with hallucinated placeholder args against
  // external APIs (Okta, registries, etc.) always fails — and that's a
  // false negative, not a real protocol-wiring bug. Layer 2 still
  // validates initialize + tools_list, which is the protocol contract
  // every MCP must satisfy regardless of consumer credentials.
  const sampleInputs: InspectorSampleCallInput[] = fixture === null
    ? []
    : probe.tools_list.map((tool) => ({
        toolName: tool.name,
        arguments: pickSampleArgs(tool, fixture),
      }));

  if (sampleInputs.length > 0) {
    const callProbe = await runInspectorHarness({
      command,
      args: resolvedArgs,
      sampleInputs,
      timeoutMs: opts.timeoutMs,
    });

    for (const call of callProbe.sample_call_results) {
      if (call.ok) continue;
      const code = extractMcpErrorCode(call.error);
      if (code === METHOD_NOT_FOUND) {
        errors.push(
          gateError('tools_call_probe', {
            observation: `Tool '${call.toolName}' advertised in tools/list but tools/call returned -32601 (Method not found).`,
            cause: 'Handler not registered (typo in mcp.tool() call?).',
            action: `Open src/server.ts and verify mcp.tool("${call.toolName}", ...) registration.`,
          }),
        );
      } else {
        errors.push(
          gateError('tools_call_probe', {
            observation: `Tool '${call.toolName}' tools/call failed: ${call.error ?? 'unknown error'}.`,
            cause: 'Handler is registered but raised an error against the sample input.',
            action: `Add a record for '${call.toolName}' to tests/fixtures/${opts.mcpName}/sample-tool-inputs.json with a known-good input, then re-tag.`,
          }),
        );
      }
    }
  }

  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    tools_checked: probe.tools_list.map((t) => t.name),
    errors,
    log: {
      event: passed ? 'gate.layer_2_passed' : 'gate.layer_2_failed',
      pipeline_run_id: opts.pipelineRunId,
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0]?.startsWith('-')) {
    process.stderr.write(
      'Usage: tsx src/gates/run-track-a-layer-2.ts <mcp-name> [--server-command <cmd>] [--server-args <a> <b> ...]\n',
    );
    return 2;
  }
  const mcpName = argv[0]!;
  const cmdIdx = argv.indexOf('--server-command');
  const argsIdx = argv.indexOf('--server-args');
  const serverCommand = cmdIdx >= 0 ? argv[cmdIdx + 1] : undefined;
  const serverArgs =
    argsIdx >= 0 ? argv.slice(argsIdx + 1).filter((s) => !s.startsWith('--')) : undefined;

  const result = await runTrackALayer2({
    repoRoot: process.cwd(),
    mcpName,
    serverCommand,
    serverArgs,
    pipelineRunId: process.env.PIPELINE_RUN_ID,
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
