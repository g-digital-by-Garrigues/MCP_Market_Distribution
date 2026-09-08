// Stub MCP whose tool descriptions carry characters that a re-encode would
// betray: an em dash, a backtick-quoted field reference, literal double
// quotes and — since Story 18.4 — a literal `|`. Used by the Story 18.3
// (FR62) authored-text fidelity test to prove the pipeline hands
// generation's copy to every rendered surface byte for byte.
//
// The pipe is in now because it is the character that distinguishes an
// encoding from a substitution: it MUST be escaped as `\|` in the README's
// markdown table cells (2 columns, not 5) and MUST stay a bare `|` in the
// node/credentials TypeScript surfaces. It mirrors the real emitted
// contract, where `evidence_get` and `notification_request_status` document
// their enum states as `COMPLETED|IN_PROCESS|ERROR`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-authored-text', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_widget',
      description:
        'Fetch a widget by `id` — returns the "canonical" record, never a summary. Returns status (COMPLETED|IN_PROCESS|ERROR). WARNING: do not call this before widget_seal has run.',
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
      description:
        'List widgets — newest first. The "page_size" cap is 100; anything larger is silently clamped.',
      inputSchema: {
        type: 'object',
        properties: {
          page_size: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      },
    },
    {
      name: 'submit_widget',
      description:
        'Submit a widget — the caller owns the "name" uniqueness constraint, and a duplicate raises WidgetCreateError.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
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
