// Stub MCP that advertises a tool 'known_tool' but rejects EVERY
// tools/call with a method-not-found error. Used by Track B Layer 3
// to exercise the "operation name mismatch" failure path — when the
// n8n adapter tries to call an operation whose name doesn't line up
// with what the MCP actually implements.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-rejects', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'known_tool',
      description: 'Advertised but rejects all calls.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const err = new Error(`Method not found: ${request.params.name}`);
  err.code = -32601;
  throw err;
});

await server.connect(new StdioServerTransport());
