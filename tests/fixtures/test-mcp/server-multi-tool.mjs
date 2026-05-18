// Stub MCP that advertises multiple tools with diverse inputSchemas.
// Used by the n8n-adapter build-node-spec integration test so we
// exercise the full pipeline against a deterministic fixture instead
// of building EAD Factory in CI.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-multi', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_widget',
      description: 'Fetch a widget by id.',
      inputSchema: {
        type: 'object',
        properties: {
          widget_id: { type: 'string', description: 'Widget identifier.' },
        },
        required: ['widget_id'],
      },
    },
    {
      name: 'list_widgets',
      description: 'List widgets with pagination and ordering.',
      inputSchema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          sort: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          verbose: { type: 'boolean', default: false },
        },
      },
    },
    {
      name: 'submit_widget',
      description: 'Submit a widget with optional metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          metadata: {
            type: 'object',
            properties: {
              author: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'ok' }],
}));

await server.connect(new StdioServerTransport());
