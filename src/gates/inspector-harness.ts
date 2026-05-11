import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The harness wraps @modelcontextprotocol/sdk's stdio client (the same library
// MCP Inspector is built on) so Layer 2 (Story 2.4) gets a headless,
// dependency-light surface without shelling into the GUI-oriented Inspector
// CLI. Behavior is equivalent: spawn the server, run the initialize handshake,
// list tools, call each one with a sample input, and return a typed result.

export interface InspectorToolEntry {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface InspectorSampleCallInput {
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface InspectorSampleCallResult {
  toolName: string;
  ok: boolean;
  response?: unknown;
  error?: string;
}

export interface InspectorResult {
  initialize_succeeded: boolean;
  initialize_error?: string;
  tools_list: InspectorToolEntry[];
  tools_list_error?: string;
  sample_call_results: InspectorSampleCallResult[];
  launch_error?: string;
}

export interface RunInspectorHarnessOptions {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  sampleInputs?: readonly InspectorSampleCallInput[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(handle);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function buildEmpty(): InspectorResult {
  return {
    initialize_succeeded: false,
    tools_list: [],
    sample_call_results: [],
  };
}

export async function runInspectorHarness(
  opts: RunInspectorHarnessOptions,
): Promise<InspectorResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = buildEmpty();

  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;

  try {
    transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args ? [...opts.args] : [],
      env: opts.env ? { ...opts.env } : undefined,
    });
  } catch (err) {
    result.launch_error = `Failed to construct stdio transport: ${(err as Error).message}`;
    return result;
  }

  client = new Client({ name: 'inspector-harness', version: '1.0.0' }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), timeoutMs, 'initialize');
    result.initialize_succeeded = true;
  } catch (err) {
    result.initialize_succeeded = false;
    const message = (err as Error).message ?? String(err);
    // The SDK surfaces spawn failures as "spawn ... ENOENT", connection drops as
    // "Connection closed" or "Process exited", and EACCES as the same — any of
    // these is a launch failure (the server never got to speak protocol). Real
    // protocol errors (bad initialize response from a server that *did* start)
    // don't match these tokens and fall through to initialize_error.
    if (/spawn|ENOENT|EACCES|EPIPE|connection closed|process exited|exit code|timed out/i.test(message)) {
      result.launch_error = message;
    } else {
      result.initialize_error = message;
    }
    await safeClose(client, transport);
    return result;
  }

  try {
    const listResponse = await withTimeout(client.listTools({}), timeoutMs, 'tools/list');
    result.tools_list = (listResponse.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  } catch (err) {
    result.tools_list_error = (err as Error).message ?? String(err);
    await safeClose(client, transport);
    return result;
  }

  for (const input of opts.sampleInputs ?? []) {
    try {
      const response = await withTimeout(
        client.callTool({ name: input.toolName, arguments: input.arguments }),
        timeoutMs,
        `tools/call ${input.toolName}`,
      );
      result.sample_call_results.push({
        toolName: input.toolName,
        ok: true,
        response,
      });
    } catch (err) {
      result.sample_call_results.push({
        toolName: input.toolName,
        ok: false,
        error: (err as Error).message ?? String(err),
      });
    }
  }

  await safeClose(client, transport);
  return result;
}

async function safeClose(
  client: Client | null,
  transport: StdioClientTransport | null,
): Promise<void> {
  try {
    if (client) await client.close();
  } catch {
    /* ignore */
  }
  try {
    if (transport) await transport.close();
  } catch {
    /* ignore */
  }
}
