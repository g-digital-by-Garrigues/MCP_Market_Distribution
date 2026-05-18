// Stub MCP that responds to every tools/call with an auth/credential
// error. Used by Track B Layer 3 to verify that auth errors in CI (no
// real creds set) classify as "structurally valid" — the MCP processed
// the call, the failure is application-level, not protocol-level.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-auth-fail', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'do_thing',
      description: 'Requires credentials we do not have in CI.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => {
  throw new Error('OKTA_CLIENT_ID is not set — cannot authenticate.');
});

await server.connect(new StdioServerTransport());
