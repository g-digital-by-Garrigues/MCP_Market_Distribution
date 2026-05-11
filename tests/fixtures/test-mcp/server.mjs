// Minimal stub MCP server used by Layer 2 harness integration tests.
// Advertises two tools: `echo` (round-trips its argument) and
// `always_fails` (throws). Speaks stdio MCP via @modelcontextprotocol/sdk.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-stub', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Returns the provided message verbatim.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
    {
      name: 'always_fails',
      description: 'Always throws so the harness can record a failure.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'echo') {
    return {
      content: [{ type: 'text', text: String(args.message ?? '') }],
    };
  }
  if (name === 'always_fails') {
    throw new Error('always_fails is intentionally failing.');
  }
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
