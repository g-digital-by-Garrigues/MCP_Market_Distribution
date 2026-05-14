#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v3';
import { generateEvidence, GenerateEvidenceInput } from './workflow.service';
import { getToken } from './auth.service';
import { getEvidence } from './evidence.service';
import { createSignatureRequest, getSignatureRequest, addDocumentToSignatureRequest, addSignatoryToDocument, activateSignatureRequest, addValidatorToSignatory, addObserverToDocument } from './signature.service';
import { uploadFileToS3 } from './s3-upload.service';
import { calculateSha256FromFile, sha256HexToBase64 } from './hash.service';
import * as path from 'path';
import { config } from './config';
import { createHttpApp } from './http';

const server = new McpServer({
  name: 'evidence-manager-mcp-server',
  version: '1.0.0',
});

// ─── generate_evidence ───────────────────────────────────────────────────────

const generateEvidenceSchema = {
  filePath: z.string().describe('Absolute path to the file on disk (e.g. /home/user/contract.pdf)'),
  evidenceId: z.string().uuid().describe('Unique UUID for this evidence (used for idempotency)'),
  title: z.string().describe('Human-readable title for the evidence'),
  createdBy: z.string().max(50).describe('Name of the person creating the evidence (max 50 characters)'),
  capturedAt: z.string().describe('ISO 8601 datetime when the evidence was captured (e.g. 2024-11-01T10:00:00Z)'),
  custodyType: z
    .enum(['INTERNAL', 'EXTERNAL'])
    .default('INTERNAL')
    .describe('INTERNAL = file hosted by the platform, EXTERNAL = hosted externally. Defaults to INTERNAL.'),
  testimonyTSP: z
    .boolean()
    .optional()
    .describe('Enable TSP timestamping via EADTrust (qualified eIDAS). Defaults to true if no testimony specified.'),
  testimonyDLT: z
    .boolean()
    .optional()
    .describe('Enable DLT timestamping via Lacnet blockchain. Requires prior tenant activation.'),
  requiredTestimonyProviders: z
    .string()
    .optional()
    .describe('Comma-separated required providers: "TSP", "DLT", or "TSP,DLT". Omit to use tenant defaults.'),
  metadata: z
    .string()
    .optional()
    .describe('JSON string of key-value pairs for custom business data (e.g. {"contractRef":"CTR-2024-001"}).'),
};

server.tool(
  'generate_evidence',
  'Creates a digital evidence with internal custody: ' +
    '(1) authenticates with Okta, (2) calculates SHA-256 of the local file, ' +
    '(3) registers the evidence in Evidence Manager, (4) uploads the file to S3 via presigned URL, ' +
    '(5) polls until status is COMPLETED or ERROR. Returns the final evidence details.',
  generateEvidenceSchema,
  async (args) => {
    const testimony: Record<string, { required: boolean; providers: string[] }> = {};
    if (args.testimonyTSP !== false) {
      testimony.TSP = { required: true, providers: ['EADTrust'] };
    }
    if (args.testimonyDLT) {
      testimony.DLT = { required: true, providers: ['Lacnet'] };
    }

    const input: GenerateEvidenceInput = {
      filePath: args.filePath,
      evidenceId: args.evidenceId,
      title: args.title,
      createdBy: args.createdBy,
      capturedAt: args.capturedAt,
      custodyType: args.custodyType,
      testimony: Object.keys(testimony).length > 0 ? testimony : undefined,
      requiredTestimonyProviders: args.requiredTestimonyProviders
        ? (args.requiredTestimonyProviders.split(',').map((s) => s.trim()) as ('TSP' | 'DLT')[])
        : undefined,
      metadata: args.metadata ? JSON.parse(args.metadata) : undefined,
    };

    const progressLog: string[] = [];

    try {
      const result = await drainGenerator(generateEvidence(input), progressLog);

      const output = [
        ...progressLog,
        '',
        'Evidence generated successfully!',
        `  ID:     ${result.evidenceId}`,
        `  Status: ${result.status}`,
        '',
        'Details:',
        JSON.stringify(result.details, null, 2),
      ].join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const progress = progressLog.length > 0 ? progressLog.join('\n') + '\n\n' : '';
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `${progress}Error: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── get_evidence ────────────────────────────────────────────────────────────

server.tool(
  'get_evidence',
  'Retrieves the full details of an evidence by its ID, including status, timestamps, custody info, and metadata.',
  {
    evidenceId: z.string().uuid().describe('UUID of the evidence to retrieve'),
  },
  async (args) => {
    try {
      const token = await getToken();
      const evidence = await getEvidence(token, args.evidenceId);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(evidence, null, 2) }],
      };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error retrieving evidence: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── create_signature_request ────────────────────────────────────────────────

const FULL_FLOW_FILE_PATH = config.fullFlowFilePath;
const [emailUser, emailDomain] = config.fullFlowEmailBase.split('@');
const FULL_FLOW_SIGNATORY = { name: 'Firmante',  surnames: 'Demo', email: `${emailUser}+signatory@${emailDomain}` };
const FULL_FLOW_VALIDATOR = { name: 'Validador',  surnames: 'Demo', email: `${emailUser}+validator@${emailDomain}` };
const FULL_FLOW_OBSERVER  = { name: 'Observador', surnames: 'Demo', email: `${emailUser}+observer@${emailDomain}` };

server.tool(
  'create_signature_request',
  'Creates a new signature request in Signature Manager. ' +
    'Authenticates with Okta and POSTs to /api/v1/private/signature-requests. ' +
    'When fullFlow=true, also adds a document, signatory, validator and observer with default values, then activates the SR.',
  {
    name: z.string().min(1).describe('Name of the signature request'),
    createdBy: z.string().min(1).describe('Identifier of the user creating the request (e.g. email or username)'),
    description: z.string().optional().describe('Optional description of the signature request'),
    notifications: z
      .boolean()
      .optional()
      .describe('Whether to send email notifications to participants. Defaults to tenant configuration.'),
    language: z
      .string()
      .optional()
      .describe('Language code for notifications and UI (e.g. "ES", "EN")'),
    uniqueValidator: z
      .boolean()
      .optional()
      .describe('Whether a single validator can validate all signatories'),
    provider: z
      .enum(['NOTICEMAN', 'NOTICEMAN_AND_WHATSAPP'])
      .optional()
      .describe('Notification provider. NOTICEMAN = email only, NOTICEMAN_AND_WHATSAPP = email + WhatsApp'),
    senderName: z.string().optional().describe('Display name of the sender shown to participants'),
    senderAddress: z.string().email().optional().describe('Reply-to email address for notifications'),
    closeCondition: z
      .enum(['ALL_REQUIRED', 'PARTIAL_ALLOWED'])
      .optional()
      .describe('Condition to close the request: ALL_REQUIRED = all signatories must sign, PARTIAL_ALLOWED = partial signatures accepted'),
    closeAt: z
      .string()
      .optional()
      .describe('ISO 8601 datetime after which the request is automatically closed (e.g. 2025-12-31T23:59:59Z)'),
    signatureRequestBody: z
      .string()
      .optional()
      .describe(
        'JSON array of body objects to customise notification emails. ' +
          'Each item: { "status": "DRAFT"|"ACTIVE"|..., "content": { "subject": "...", "body": "...", "additionalText": "..." } }',
      ),
    fullFlow: z
      .boolean()
      .optional()
      .describe(
        `When true, after creating the SR automatically: ` +
        `(1) adds ${FULL_FLOW_FILE_PATH} as a document, ` +
        `(2) adds a signatory (${FULL_FLOW_SIGNATORY.email}), ` +
        `(3) adds a validator (${FULL_FLOW_VALIDATOR.email}) to the signatory, ` +
        `(4) adds an observer (${FULL_FLOW_OBSERVER.email}), ` +
        `(5) activates the SR.`,
      ),
  },
  async (args) => {
    try {
      const token = await getToken();

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      const dateStamp = `${pad(now.getDate())} ${months[now.getMonth()]} ${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      const sr = await createSignatureRequest(token, {
        name: `${args.name} ${dateStamp}`,
        createdBy: args.createdBy,
        description: args.description ? `${args.description} ${dateStamp}` : dateStamp,
        notifications: args.notifications,
        language: args.language,
        uniqueValidator: args.uniqueValidator,
        provider: args.provider,
        senderName: args.senderName,
        senderAddress: args.senderAddress,
        closeConfig:
          args.closeCondition !== undefined || args.closeAt !== undefined
            ? { condition: args.closeCondition, date: args.closeAt }
            : undefined,
        signatureRequestBody: args.signatureRequestBody
          ? JSON.parse(args.signatureRequestBody)
          : undefined,
      });

      if (!args.fullFlow) {
        const output = [
          'Signature request created successfully!',
          `  ID:     ${sr.id}`,
          `  Status: ${sr.status}`,
          `  Name:   ${sr.name}`,
          '',
          'Details:',
          JSON.stringify(sr, null, 2),
        ].join('\n');
        return { content: [{ type: 'text' as const, text: output }] };
      }

      // ── Full flow ────────────────────────────────────────────────────────────
      const log: string[] = [
        `SR created:        ${sr.id}`,
      ];

      const filename = path.basename(FULL_FLOW_FILE_PATH);
      const hashHex  = calculateSha256FromFile(FULL_FLOW_FILE_PATH);

      const doc = await addDocumentToSignatureRequest(token, sr.id, {
        filename,
        title: filename,
        hash: hashHex,
        signatureType: 'INTERPOSITION',
      });
      await uploadFileToS3(doc.url, FULL_FLOW_FILE_PATH, sha256HexToBase64(hashHex));
      log.push(`Document added:    ${doc.id}`);

      await waitForDocumentsReady(token, sr.id);
      log.push(`Documents ready`);

      const signatory = await addSignatoryToDocument(token, sr.id, doc.id, FULL_FLOW_SIGNATORY);
      log.push(`Signatory added:   ${signatory.id}`);

      const validator = await addValidatorToSignatory(token, signatory.documentId ?? doc.id, signatory.id, FULL_FLOW_VALIDATOR);
      log.push(`Validator added:   ${validator.id}`);

      const observer = await addObserverToDocument(token, sr.id, doc.id, FULL_FLOW_OBSERVER);
      log.push(`Observer added:    ${observer.id}`);

      const activated = await activateSignatureRequest(token, sr.id);
      log.push(`SR activated:      ${activated.status}`);

      const output = [
        'Signature request created and activated!',
        '',
        ...log,
      ].join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error creating signature request: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── add_document_to_signature_request ──────────────────────────────────────

server.tool(
  'add_document_to_signature_request',
  'Adds a document to an existing signature request and uploads the file content. ' +
    '(1) Derives filename and SHA-256 hash from the local file. ' +
    '(2) POSTs to /api/v1/private/signature-requests/{id}/documents to register the document and get a presigned S3 URL. ' +
    '(3) PUTs the file content to the presigned URL using the SHA-256 checksum. ' +
    'Returns the document ID once the upload is complete.',
  {
    signatureRequestId: z.string().uuid().describe('UUID of the signature request to add the document to'),
    filePath: z.string().describe('Absolute path to the file on disk (e.g. /home/user/contract.pdf)'),
    title: z.string().min(1).describe('Human-readable title for the document'),
    signatureType: z
      .enum(['INTERPOSITION', 'ADVANCED', 'OTHER'])
      .describe('Type of signature: INTERPOSITION, ADVANCED, or OTHER'),
    description: z.string().optional().describe('Optional description of the document'),
    signatureDeadline: z
      .string()
      .optional()
      .describe('ISO 8601 datetime deadline for signing this document (e.g. 2025-12-31T23:59:59Z)'),
    provider: z
      .enum(['EADTRUST'])
      .optional()
      .describe('Signing provider. Currently only EADTRUST is supported.'),
    evidenceId: z
      .string()
      .uuid()
      .optional()
      .describe('UUID of an existing evidence to link to this document'),
    metadata: z
      .string()
      .optional()
      .describe('JSON object of string key-value pairs for custom business data (e.g. {"ref":"DOC-001"})'),
    certificateFilesOriginalDocument: z
      .boolean()
      .optional()
      .describe('Include the original document in the certificate package'),
    certificateFilesSignedDocument: z
      .boolean()
      .optional()
      .describe('Include the signed document in the certificate package'),
    sequence: z.number().int().optional().describe('Order/sequence number of the document within the request'),
    fileSize: z.number().int().min(1).optional().describe('Size of the file in bytes'),
    detached: z.boolean().optional().describe('Whether the signature is detached from the document'),
    convertToPdf: z.boolean().optional().describe('Whether to convert the document to PDF before signing'),
  },
  async (args) => {
    try {
      const token = await getToken();
      const filename = path.basename(args.filePath);
      const hashHex = calculateSha256FromFile(args.filePath);

      const hasCertFiles =
        args.certificateFilesOriginalDocument !== undefined || args.certificateFilesSignedDocument !== undefined;

      const result = await addDocumentToSignatureRequest(token, args.signatureRequestId, {
        filename,
        title: args.title,
        hash: hashHex,
        signatureType: args.signatureType,
        description: args.description,
        signatureDeadline: args.signatureDeadline,
        provider: args.provider,
        evidenceId: args.evidenceId,
        metadata: args.metadata ? JSON.parse(args.metadata) : undefined,
        certificateFiles: hasCertFiles
          ? {
              originalDocument: args.certificateFilesOriginalDocument,
              signedDocument: args.certificateFilesSignedDocument,
            }
          : undefined,
        sequence: args.sequence,
        fileSize: args.fileSize,
        detached: args.detached,
        convertToPdf: args.convertToPdf,
      });

      await uploadFileToS3(result.url, args.filePath, sha256HexToBase64(hashHex));

      const output = [
        'Document added and uploaded successfully!',
        `  Document ID: ${result.id}`,
      ].join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error adding document: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── add_signatory_to_document ───────────────────────────────────────────────

server.tool(
  'add_signatory_to_document',
  'Adds a signatory to a document within a signature request. ' +
    'POSTs to /api/v1/private/signature-requests/{signatureRequestId}/documents/{documentId}/signatories. ' +
    'The signature request must be in DRAFT status. Returns the created signatory with its ID.',
  {
    signatureRequestId: z.string().uuid().describe('UUID of the signature request'),
    documentId: z.string().uuid().describe('UUID of the document to add the signatory to'),
    name: z.string().min(1).describe('First name of the signatory'),
    email: z.string().email().describe('Email address of the signatory'),
    surnames: z.string().optional().describe('Surnames of the signatory'),
    phone: z.string().optional().describe('Phone number of the signatory (used for WhatsApp notifications)'),
    sequence: z.number().int().optional().describe('Signing order sequence number'),
    uniqueValidator: z
      .boolean()
      .optional()
      .describe('Whether this signatory has a unique validator assigned'),
    coordinates: z
      .string()
      .optional()
      .describe(
        'JSON array of signature position coordinates. Each item: { "x": number, "y": number, "page": number }',
      ),
  },
  async (args) => {
    try {
      const token = await getToken();

      const result = await addSignatoryToDocument(token, args.signatureRequestId, args.documentId, {
        name: args.name,
        email: args.email,
        surnames: args.surnames,
        phone: args.phone,
        sequence: args.sequence,
        uniqueValidator: args.uniqueValidator,
        coordinates: args.coordinates ? JSON.parse(args.coordinates) : undefined,
      });

      const output = [
        'Signatory added successfully!',
        `  Signatory ID: ${result.id}`,
        `  Name:         ${result.name}${result.surnames ? ' ' + result.surnames : ''}`,
        `  Email:        ${result.email}`,
        result.sequence !== undefined ? `  Sequence:     ${result.sequence}` : '',
        '',
        'Details:',
        JSON.stringify(result, null, 2),
      ]
        .filter((line) => line !== '')
        .join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error adding signatory: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── add_observer_to_document ────────────────────────────────────────────────

server.tool(
  'add_observer_to_document',
  'Adds an observer to a document within a signature request. ' +
    'POSTs to /api/v1/private/signature-requests/{signatureRequestId}/documents/{documentId}/observers. ' +
    'The signature request must be in DRAFT status. Returns the created observer with its ID.',
  {
    signatureRequestId: z.string().uuid().describe('UUID of the signature request'),
    documentId: z.string().uuid().describe('UUID of the document to add the observer to'),
    name: z.string().min(1).describe('First name of the observer'),
    email: z.string().email().describe('Email address of the observer'),
    surnames: z.string().optional().describe('Surnames of the observer'),
  },
  async (args) => {
    try {
      const token = await getToken();

      const result = await addObserverToDocument(token, args.signatureRequestId, args.documentId, {
        name: args.name,
        email: args.email,
        surnames: args.surnames,
      });

      const output = [
        'Observer added successfully!',
        `  Observer ID: ${result.id}`,
        `  Name:        ${result.name}${result.surnames ? ' ' + result.surnames : ''}`,
        `  Email:       ${result.email}`,
      ].join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error adding observer: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── add_validator_to_signatory ──────────────────────────────────────────────

server.tool(
  'add_validator_to_signatory',
  'Adds a validator to a signatory within a document. ' +
    'POSTs to /api/v1/private/documents/{documentId}/signatories/{signatoryId}/validators. ' +
    'Returns the created validator with its ID.',
  {
    documentId: z.string().uuid().describe('UUID of the document'),
    signatoryId: z.string().uuid().describe('UUID of the signatory to add the validator to'),
    name: z.string().min(1).describe('First name of the validator'),
    email: z.string().email().describe('Email address of the validator'),
    surnames: z.string().optional().describe('Surnames of the validator'),
    phone: z.string().optional().describe('Phone number of the validator'),
  },
  async (args) => {
    try {
      const token = await getToken();

      const result = await addValidatorToSignatory(token, args.documentId, args.signatoryId, {
        name: args.name,
        email: args.email,
        surnames: args.surnames,
        phone: args.phone,
      });

      const output = [
        'Validator added successfully!',
        `  Validator ID:  ${result.id}`,
        `  Name:          ${result.name}${result.surnames ? ' ' + result.surnames : ''}`,
        `  Email:         ${result.email}`,
        result.signatoryId ? `  Signatory ID:  ${result.signatoryId}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error adding validator: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── activate_signature_request ──────────────────────────────────────────────

server.tool(
  'activate_signature_request',
  'Activates a signature request, changing its status from DRAFT to ACTIVE and triggering notifications to signatories. ' +
    'POSTs to /api/v1/private/signature-requests/{signatureRequestId}/activate. ' +
    'Returns the updated ID and status.',
  {
    signatureRequestId: z.string().uuid().describe('UUID of the signature request to activate'),
  },
  async (args) => {
    try {
      const token = await getToken();
      const result = await activateSignatureRequest(token, args.signatureRequestId);

      const output = [
        'Signature request activated successfully!',
        `  ID:     ${result.id}`,
        `  Status: ${result.status}`,
      ].join('\n');

      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error activating signature request: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── get_signature_request ───────────────────────────────────────────────────

server.tool(
  'get_signature_request',
  'Retrieves the full details of a signature request by its ID, including status, documents, participants, status history, and close configuration.',
  {
    signatureRequestId: z.string().uuid().describe('UUID of the signature request to retrieve'),
  },
  async (args) => {
    try {
      const token = await getToken();
      const detail = await getSignatureRequest(token, args.signatureRequestId);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }],
      };
    } catch (error) {
      const message = extractErrorMessage(error);
      return {
        content: [{ type: 'text' as const, text: `Error retrieving signature request: ${message}` }],
        isError: true,
      };
    }
  },
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosError = error as { response?: { data?: unknown } };
    if (axiosError.response?.data) {
      return `${error.message} — ${JSON.stringify(axiosError.response.data)}`;
    }
    return error.message;
  }
  return String(error);
}

async function waitForDocumentsReady(
  token: string,
  signatureRequestId: string,
  { intervalMs = 2000, timeoutMs = 30000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sr = await getSignatureRequest(token, signatureRequestId);
    const docs = (sr.documents ?? []) as { status?: string }[];
    const allReady = docs.length > 0 && docs.every((d) => d.status === 'READY_TO_SIGN');
    if (allReady) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for documents to reach READY_TO_SIGN in SR ${signatureRequestId}`);
}

async function drainGenerator<T>(gen: AsyncGenerator<string, T>, log: string[]): Promise<T> {
  let next = await gen.next();
  while (!next.done) {
    log.push(next.value as string);
    next = await gen.next();
  }
  return next.value;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main() {
  const transportMode = config.transport;

  if (transportMode === 'http') {
    const app = createHttpApp(server);
    const port = config.httpPort;
    app.listen(port, () => {
      console.error(`Evidence Manager MCP Server listening on http://0.0.0.0:${port}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Evidence Manager MCP Server running on stdio');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
