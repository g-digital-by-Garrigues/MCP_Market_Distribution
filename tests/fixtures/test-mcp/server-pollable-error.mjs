// Stub MCP that responds to every tools/call with the pollable / task-based
// execution error the MCP SDK throws when a tool is registered as
// `pollable: true` and the client uses plain `tools/call` instead of
// `client.experimental.tasks.callToolStream()`. Used by Track B Layer 3 to
// verify this error classifies as "structurally valid" — the tool EXISTS in
// tools/list and the MCP routed the call; it just demands a different
// calling convention. Not a codegen-drift signal.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-pollable', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'pollable_tool',
      description: 'Long-running tool — requires tasks.callToolStream().',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  throw new Error(
    'Tool "pollable_tool" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.',
  );
});

await server.connect(new StdioServerTransport());
