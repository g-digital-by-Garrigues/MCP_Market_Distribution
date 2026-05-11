// Stub MCP that advertises a tool in tools/list but lets tools/call return
// -32601 (Method not found) for it — exercises Layer 2's 'tools_call_probe'
// failure path that the AC explicitly calls out (handler not registered).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-no-handler', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ghost_tool',
      description: 'Advertised but the handler will not match this name.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// Intentionally responds only to a different name so 'ghost_tool' yields
// -32601 via the SDK's default unknown-method handling.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'this_one_exists') {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
  const err = /** @type {Error & { code?: number }} */ (
    new Error(`Method not found: ${request.params.name}`)
  );
  err.code = -32601;
  throw err;
});

await server.connect(new StdioServerTransport());
