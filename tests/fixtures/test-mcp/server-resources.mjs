// Stub MCP with enough tools (>= 8) to cross the threshold at which
// buildN8nNodeSpec computes the Resource dropdown, spanning the prefixes
// detectResource() actually routes on. Story 18.4 uses it for three things:
//   * AC3 — `id_verification_*` reaches the real 'idVerification' resource
//     instead of being buried under the Signature fallback.
//   * AC4 — the role-aware auto-id on signature_participant_create.
//   * AC5 — `widget_frobnicate` matches no prefix and is not signature-shaped,
//     so it is the deliberate offender that must make the build THROW. A test
//     that wants the positive case simply omits its `// n8n-http:` annotation,
//     which drops it from `operations` as a non-REST stub.
// The three id_verification_* names are the real ones emitted by
// EAD Enterprise Suite, not invented.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-resources', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'case_file_create',
      description: 'Creates a case file. You generate the id (UUID v4).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID v4 you generate.' },
          name: { type: 'string' },
        },
        required: ['id', 'name'],
      },
    },
    {
      name: 'evidence_get',
      description: 'Gets one evidence. Returns status (COMPLETED|IN_PROCESS|ERROR).',
      inputSchema: {
        type: 'object',
        properties: { evidenceId: { type: 'string' } },
        required: ['evidenceId'],
      },
    },
    {
      name: 'notification_request_status',
      description: 'Reads the status of a certified notification request.',
      inputSchema: {
        type: 'object',
        properties: { notificationRequestId: { type: 'string' } },
        required: ['notificationRequestId'],
      },
    },
    {
      name: 'id_verification_video_create',
      description:
        'Starts a REMOTE VIDEO identity verification. Returns HTTP 201 with NO body, so keep the id you generated — it is the verificationId.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID v4 you generate.' },
          email: { type: 'string' },
        },
        required: ['id', 'email'],
      },
    },
    {
      name: 'id_verification_list',
      description: 'Lists the identity verifications belonging to a user.',
      inputSchema: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId'],
      },
    },
    {
      name: 'id_verification_contract_url',
      description: 'Retrieves the signed identity-verification contract for one completed verification.',
      inputSchema: {
        type: 'object',
        properties: { verificationId: { type: 'string' } },
        required: ['verificationId'],
      },
    },
    {
      name: 'signature_participant_create',
      description:
        'Adds one participant to a DRAFT signature request. The id you generated IS the participantId, and it is the signatoryId if you passed role SIGNATORY or the validatorId if you passed role VALIDATOR.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID v4 you generate.' },
          requestId: { type: 'string' },
          role: { type: 'string', enum: ['SIGNATORY', 'OBSERVER', 'VALIDATOR'] },
          email: { type: 'string' },
        },
        required: ['id', 'requestId', 'role', 'email'],
      },
    },
    {
      name: 'signature_request_create',
      description: 'Creates a new signature request in DRAFT status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          caseFileId: { type: 'string' },
        },
        required: ['id', 'caseFileId'],
      },
    },
    {
      name: 'widget_frobnicate',
      description:
        'Frobnicates a widget. Matches no resource prefix and is not signature-shaped — the deliberate AC5 offender.',
      inputSchema: {
        type: 'object',
        properties: { widget_id: { type: 'string' } },
        required: ['widget_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'ok' }],
}));

await server.connect(new StdioServerTransport());
