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

  const sampleInputs: InspectorSampleCallInput[] = probe.tools_list.map((tool) => ({
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
