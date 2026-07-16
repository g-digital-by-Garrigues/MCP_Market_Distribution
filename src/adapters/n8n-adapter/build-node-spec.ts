import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runInspectorHarness, type InspectorToolEntry } from '../../gates/inspector-harness.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';
import type { DistributionConfig } from '../../schemas/distribution-config.schema.js';
import { jsonSchemaToProperties, type ToolInputSchema } from './json-schema-to-properties.js';
import type {
  N8nCredentialField,
  N8nNodeSpec,
  N8nOperationSpec,
  N8nPreflightGuard,
  N8nProperty,
} from './types.js';
import { resolveMcpEntryRelPath } from '../../utils/resolve-mcp-entry.js';

// Story 5.1b: assemble the N8nNodeSpec for a single MCP.
//
// Pulls together three input sources:
//   1. tools/list via inspector-harness — gives us the canonical tool
//      names + descriptions + inputSchemas the MCP actually exposes
//      (more reliable than the static .distribution.yaml#tools list,
//      which engineers can drift).
//   2. .distribution.yaml — npm_scope, n8n_adapter_target_name, repo
//      URL, source-MCP package metadata.
//   3. server.json#packages[0].environmentVariables — what credentials
//      the n8n node needs to expose (mapping 1:1 from MCP env vars).
//
// The output spec is consumed by the Handlebars codegen step (5.1c).
// Unsupported-schema notes from the converter are aggregated and
// surfaced via `unsupportedNotes` so the generator can write them
// into the README / hand them to the LLM-refine pass (5.1d).

export interface BuildN8nNodeSpecInput {
  /** Path to the MCP source folder (clone target: pending-to-publish/<id>/). */
  readonly packageDir: string;
  /** Pipeline-repo root, used to load .distribution.yaml. */
  readonly repoRoot: string;
  /** MCP id (kebab-case). */
  readonly mcpName: string;
  /** Version to embed in the generated package.json (typically the source MCP's version). */
  readonly version: string;
  /**
   * Inspector-harness configuration — defaults to spawning
   * `node <packageDir>/dist/server.js`, which is what publish-npm
   * ships. Tests can inject a mock command/args here.
   */
  readonly inspectorCommand?: string;
  readonly inspectorArgs?: readonly string[];
  readonly inspectorTimeoutMs?: number;
}

export interface BuildN8nNodeSpecResult {
  spec: N8nNodeSpec;
  /** Aggregated diagnostic notes (across all operations). */
  unsupportedNotes: string[];
}

export class BuildN8nNodeSpecError extends Error {
  readonly stage: 'tools_list' | 'server_json' | 'distribution_config' | 'launch';
  constructor(stage: BuildN8nNodeSpecError['stage'], message: string) {
    super(message);
    this.name = 'BuildN8nNodeSpecError';
    this.stage = stage;
  }
}

// Brand tokens with non-titlecase canonical casing. Generic toTitleCase
// produces 'Ead' / 'Gocertius'; these brands require 'EAD' / 'GoCertius'.
// Applied as a fallback when .distribution.yaml omits n8n_connector_display_name,
// so a generator regen that wipes the override can't silently mis-case the brand.
// Keyed by lowercased token. See docs/n8n-adapter-contract.md.
const BRAND_TOKEN_CASING: Readonly<Record<string, string>> = {
  ead: 'EAD',
  gocertius: 'GoCertius',
};

// Two-tier title-case so 'ead-factory' → 'EadFactory' (class name)
// and 'ead-factory' → 'EAD Factory' (display).
function toPascalCase(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
function toTitleCase(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => BRAND_TOKEN_CASING[s.toLowerCase()] ?? s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

interface ServerJsonShape {
  description?: string;
  repository?: { url?: string } | string;
  packages?: ReadonlyArray<{
    environmentVariables?: ReadonlyArray<{
      name: string;
      description?: string;
      isSecret?: boolean;
      isRequired?: boolean;
    }>;
  }>;
}

async function readServerJson(packageDir: string): Promise<ServerJsonShape> {
  const filePath = path.join(packageDir, 'server.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new BuildN8nNodeSpecError(
      'server_json',
      `server.json not found at ${filePath}: ${(err as Error).message}. Run /prep-mcp first so the artifact exists.`,
    );
  }
  try {
    return JSON.parse(raw) as ServerJsonShape;
  } catch (err) {
    throw new BuildN8nNodeSpecError(
      'server_json',
      `server.json at ${filePath} is not valid JSON: ${(err as Error).message}.`,
    );
  }
}

type AuthStyle =
  | 'email-password'
  | 'okta-client-credentials'
  | 'oauth2-client-credentials'
  | 'session-login-or-token';

// ALLOWLIST (not a denylist): the exact env vars the REST-direct execute()
// reads as credentials, keyed by auth style. The n8n credential surface is
// derived ONLY from this set — `server.json#environmentVariables` (sourced from
// the MCP `.env.example`) may contain any number of MCP-server runtime settings
// (HTTP host/port, CORS, DNS-rebinding guards, OpenID, PORT…) that the n8n node
// never reads. A denylist is fail-open — every new server var leaks until
// someone blocks it (this recurred: MCP_OPENID_*/PORT in v1.2.19, MCP_HTTP_*/
// MCP_ALLOW* in v1.3.x). This allowlist is fail-closed: nothing the node can't
// use ever reaches the credential screen, regardless of what the generator adds
// to .env.example. `baseUrl` is emitted by the template separately (not an env
// var). See docs/n8n-adapter-contract.md. To support a new auth field, add it
// here AND to execute() (node.ts.hbs) AND to CREDENTIAL_PROP_NAME_MAP.
const NODE_READABLE_CREDENTIAL_ENV_VARS: Record<AuthStyle, readonly string[]> = {
  'email-password': ['MCP_AUTH_EMAIL', 'MCP_AUTH_PASSWORD'],
  'okta-client-credentials': [
    'OKTA_TOKEN_URL',
    'OKTA_CLIENT_ID',
    'OKTA_CLIENT_SECRET',
    'OKTA_SCOPE',
  ],
  // Generic OAuth2 client_credentials (the generator generalized the hardcoded
  // OKTA_* trio to a provider-agnostic MCP_SVC_* set — Okta is now just one
  // configured instance). Same grant as okta-client-credentials, different var
  // names. MCP_SVC_INTROSPECT_URL is deliberately excluded: it configures the
  // server's INBOUND bearer validation, not the node's OUTBOUND token fetch.
  'oauth2-client-credentials': [
    'MCP_SVC_TOKEN_URL',
    'MCP_SVC_CLIENT_ID',
    'MCP_SVC_CLIENT_SECRET',
    'MCP_SVC_SCOPE',
  ],
  // User-facing products (GoCertius / EAD Enterprise Suite): the n8n user signs in
  // as themselves, either with email+password (Password-type accounts) or by pasting
  // a session JWT directly. `sessionToken` has no backing env var — it is a node-only
  // credential field added in buildCredentials. See the session-login-or-token block
  // in node.ts.hbs and docs/n8n-adapter-contract.md.
  'session-login-or-token': ['MCP_AUTH_EMAIL', 'MCP_AUTH_PASSWORD'],
};

// Node-only credential fields that are NOT derived from a server env var, keyed by
// auth style. Appended to the credential surface on top of the env-var allowlist.
const EXTRA_CREDENTIAL_FIELDS: Partial<Record<AuthStyle, readonly N8nCredentialField[]>> = {
  'session-login-or-token': [
    {
      envName: '',
      propName: 'sessionToken',
      displayName: 'Session Token (JWT)',
      isSecret: true,
      description:
        'Optional. Paste a session JWT to authenticate directly (used as the Bearer token). ' +
        'Leave empty to sign in with Email + Password instead. Required for OpenID/SSO accounts, ' +
        'which cannot use email/password here.',
    },
  ],
};

function detectAuthStyle(server: ServerJsonShape): AuthStyle {
  const names = new Set((server.packages?.[0]?.environmentVariables ?? []).map((v) => v.name));
  // A product that exposes MCP_AUTH_EMAIL is user-facing: the n8n user authenticates
  // as themselves (email/password → session JWT, or a pasted token). This is checked
  // BEFORE MCP_SVC_* because such products also expose a service-account trio for their
  // OWN server-side use (GoCertius/EAD-ES do) — but that is NOT how an n8n user signs in.
  // Only a product with NO email surface (EAD Factory) is a pure service account.
  if (names.has('MCP_AUTH_EMAIL')) return 'session-login-or-token';
  if (names.has('MCP_SVC_TOKEN_URL')) return 'oauth2-client-credentials';
  if (names.has('OKTA_TOKEN_URL')) return 'okta-client-credentials';
  return 'email-password';
}

// Human-readable credential field display names. The generic
// toTitleCase(MCP_AUTH_EMAIL) → "Mcp Auth Email" leaks the env-var prefix into
// the UI; these friendlier labels match what consumers expect (and the n8n
// Creator Portal-approved v1.2.20 names).
const CREDENTIAL_DISPLAY_NAME_MAP: Record<string, string> = {
  MCP_AUTH_EMAIL: 'Auth Email',
  MCP_AUTH_PASSWORD: 'Auth Password',
  MCP_SVC_TOKEN_URL: 'OAuth Token URL',
  MCP_SVC_CLIENT_ID: 'Client ID',
  MCP_SVC_CLIENT_SECRET: 'Client Secret',
  MCP_SVC_SCOPE: 'Scope',
};

const SECRET_ENV_SUFFIX_RE = /_SECRET$|_PASSWORD$|_TOKEN$/;

// Maps SCREAMING_SNAKE_CASE env-var names to camelCase n8n credential property
// names. n8n convention requires camelCase; env-var style names are surfaced
// to end users in error messages and the credential form.
const CREDENTIAL_PROP_NAME_MAP: Record<string, string> = {
  MCP_AUTH_EMAIL: 'email',
  MCP_AUTH_PASSWORD: 'password',
  OKTA_TOKEN_URL: 'oktaTokenUrl',
  OKTA_CLIENT_ID: 'oktaClientId',
  OKTA_CLIENT_SECRET: 'oktaClientSecret',
  OKTA_SCOPE: 'oktaScope',
  MCP_SVC_TOKEN_URL: 'mcpSvcTokenUrl',
  MCP_SVC_CLIENT_ID: 'mcpSvcClientId',
  MCP_SVC_CLIENT_SECRET: 'mcpSvcClientSecret',
  MCP_SVC_SCOPE: 'mcpSvcScope',
  API_BASE_URL: 'apiBaseUrl',
  SIGNATURE_API_BASE_URL: 'signatureApiBaseUrl',
};

function envToCamelCase(envName: string): string {
  if (CREDENTIAL_PROP_NAME_MAP[envName]) return CREDENTIAL_PROP_NAME_MAP[envName];
  // Generic fallback: MY_VAR_NAME → myVarName
  return envName.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function buildCredentials(server: ServerJsonShape, authStyle: AuthStyle): N8nCredentialField[] {
  const declared = new Map(
    (server.packages?.[0]?.environmentVariables ?? []).map((v) => [v.name, v]),
  );
  // Emit only allowlisted, node-readable fields, in a deterministic order.
  // Intersect with what the MCP actually declares so the form mirrors the
  // server's real auth inputs while staying fail-closed against everything else.
  const envFields = NODE_READABLE_CREDENTIAL_ENV_VARS[authStyle]
    .filter((envName) => declared.has(envName))
    .map((envName) => {
      const v = declared.get(envName)!;
      const field: N8nCredentialField = {
        envName,
        propName: envToCamelCase(envName),
        displayName:
          CREDENTIAL_DISPLAY_NAME_MAP[envName] ??
          toTitleCase(envName.toLowerCase().replace(/_/g, '-')),
        isSecret: v.isSecret === true || SECRET_ENV_SUFFIX_RE.test(envName),
      };
      if (v.description) field.description = v.description;
      return field;
    });
  // Node-only fields (no backing env var), e.g. the session token for
  // session-login-or-token. Appended after the env-derived fields.
  const extra = EXTRA_CREDENTIAL_FIELDS[authStyle] ?? [];
  return [...envFields, ...extra];
}

// Story 12.2 (Epic 12): REST-direct architecture per ADR 0008.
// Extract HTTP method + URL template from the tool's source file.
//
// Priority order:
//   1. `// Sourced from operation: Foo_run (POST /path)` — auto-generated by @suite/generator
//   2. `// n8n-http: POST /path` — manual override for custom/handwritten tools
//   3. STUB — neither comment present; tool gets a "use self-hosted" error at runtime
// Extract the production API base URL from the MCP's session_login.ts.
// Looks for: MCP_API_BASE_URL ?? "https://..." or MCP_API_BASE_URL ?? 'https://...'
const BASE_URL_RE = /MCP_API_BASE_URL\s*\?\?\s*["'](https?:\/\/[^"']+)["']/;

async function readDefaultApiBaseUrl(packageDir: string): Promise<string> {
  const loginFile = path.join(packageDir, 'src', 'tools', 'session_login.ts');
  try {
    const content = await fs.readFile(loginFile, 'utf8');
    const m = BASE_URL_RE.exec(content);
    return m?.[1] ?? '';
  } catch {
    return '';
  }
}

const SOURCED_RE = /\/\/ Sourced from operation: \S+ \((\w+) ([^)]+)\)/;
const N8N_HTTP_RE = /\/\/ n8n-http: (\w+) (.+)/;

interface ToolHttpInfo {
  httpMethod: string;
  httpUrlTemplate: string;
  customAnnotation: boolean;
  isStub?: boolean;
  stubSuffix?: string;
}

async function readToolHttpInfo(packageDir: string, toolName: string): Promise<ToolHttpInfo> {
  const toolFile = path.join(packageDir, 'src', 'tools', `${toolName}.ts`);
  try {
    const content = await fs.readFile(toolFile, 'utf8');
    const headerLines = content.split('\n').slice(0, 8).join('\n');
    const sourced = SOURCED_RE.exec(headerLines);
    if (sourced?.[1] && sourced?.[2]) {
      return {
        httpMethod: sourced[1],
        httpUrlTemplate: sourced[2].trim(),
        customAnnotation: false,
        stubSuffix: '',
      };
    }
    const manual = N8N_HTTP_RE.exec(headerLines);
    if (manual?.[1] && manual?.[2]) {
      return {
        httpMethod: manual[1],
        httpUrlTemplate: manual[2].trim(),
        customAnnotation: true,
        stubSuffix: '',
      };
    }
  } catch {
    // File not found or unreadable — fall through to STUB
  }
  return {
    httpMethod: 'STUB',
    httpUrlTemplate: '',
    customAnnotation: true,
    isStub: true,
    stubSuffix: ', stub: true',
  };
}

// Known sensible defaults for GoCertius/EAD field names.
// Applied after jsonSchemaToProperties so enum defaults show in the n8n UI.
type FieldPatch = {
  default?: string | number | boolean;
  description?: string;
  /** Rename displayName to avoid n8n AI tool schema collisions (e.g. field named 'description'). */
  displayName?: string;
  /** Mark as required in the n8n UI when the API requires the field even if the JSON schema says optional. */
  required?: boolean;
};

// Generic defaults applied to all adapters.
const FIELD_DEFAULTS: Record<string, FieldPatch> = {
  id: {
    default: '',
    description: 'UUID v4 identifier. Leave empty — the node generates it automatically.',
  },
  // Story 13.2a tier 1 (Hugo, 2026-07-15): language is mandatory and visible, carrying
  // a valid default. gocertius / ead-enterprise-suite constrain it with an enum
  // (en_GB|es_ES|pt_PT), so the default below is always valid there. EAD Factory's
  // OpenAPI types it as a bare string and its APIs reject locales — see the
  // 'ead-factory' product override.
  language: {
    default: 'es_ES',
    required: true,
    description: 'Language used for generated documents and notices.',
  },
  evidenceType: { default: 'FILE' },
  // Story 13.2a tier 3 (Hugo, 2026-07-15): OTP / WhatsApp delivery can be MANDATORY
  // depending on how the signature is configured (an ADVANCED signature needs the
  // signatory's phone). The driver lives in a different operation, so n8n cannot show
  // these conditionally — they stay visible and state the condition instead.
  otpRequired: {
    description:
      'Require an OTP code to open/sign. REQUIRED (true) for signature types that authenticate the signatory by phone, e.g. ADVANCED — the signatory phone must then also be supplied.',
  },
  otpByDefault: {
    description: 'Apply OTP by default to participants that do not state their own setting.',
  },
  sendWaUrl: {
    description:
      'Deliver the access URL over WhatsApp. Needs the signatory phone (with phonePrefix) to be supplied.',
  },
  sendWaUrlByDefault: {
    description:
      'Deliver over WhatsApp by default for participants that do not state their own setting.',
  },
  phonePrefix: {
    description:
      'International dialling prefix for the phone (e.g. 34 for Spain). REQUIRED whenever a phone is used — OTP or WhatsApp delivery, and ADVANCED signatures.',
  },
  // Story 13.2a tier 1 (FR52): mandatory fields that CARRY A DEFAULT stay top-level
  // and required — "has a default" does not make a field optional. The default keeps
  // them always valid, so `required` never blocks the user.
  custodyType: {
    default: 'INTERNAL',
    required: true,
    description:
      'Who holds the file. INTERNAL = the platform stores and custodies it. EXTERNAL = it lives outside; only its hash is attested.',
  },
  signatureType: {
    required: true,
    description:
      'How the document is signed. INTERPOSITION = the platform mediates (e.g. OTP). ADVANCED = advanced electronic signature (requires the signatory phone).',
  },
  dossierTemplateId: {
    required: true,
    description:
      'UUID of the dossier template to use. Mandatory — the template also determines which of evidenceIds / filledFields you must supply.',
  },
  // Story 13.2a: sequence is visible top-level with its "parallel" default so nobody
  // is misled about the signing mode (the API default is parallel signing).
  sequence: {
    description:
      'Signing order. Leave at 0 for PARALLEL signing (all signatories sign at once — the API default). Set 1, 2, 3… only to require a sequential order.',
  },
  // Story 13.2a tier 3 (FR52): conditionally-required fields whose condition lives in a
  // DIFFERENT operation (a previous node in the workflow), which n8n displayOptions
  // cannot evaluate. They stay top-level and state the condition explicitly.
  phone: {
    description:
      'Signatory phone (e.g. +34600000000). REQUIRED when the document is signed with signatureType ADVANCED (set in the Add Document step); optional otherwise.',
  },
  phoneNumber: {
    description:
      'Phone number. REQUIRED when the signature request uses signatureType ADVANCED (set in the Create Signature Request step); optional otherwise.',
  },
  evidenceIds: {
    description:
      'Evidence UUIDs to include. REQUIRED by some dossier templates — which ones depends on the dossierTemplateId you chose.',
  },
  filledFields: {
    description:
      'Template field values. REQUIRED by some dossier templates — which ones depends on the dossierTemplateId you chose.',
  },
  // Story 13.2a (FR52): search/pagination is NOT secondary — it stays top-level and
  // documents how to fill it.
  page: {
    description: 'Zero-based page number for paginated results (e.g. 0 for the first page).',
  },
  size: { description: 'Page size — how many records to return (e.g. 20).' },
  sort: {
    description: 'Field to sort by (see the operation description for the accepted fields).',
  },
  order: { description: 'Sort direction / ordering for the results.' },
  service: { default: 'Telegram' },
  validityFrom: {
    default: '',
    description:
      'ISO 8601 datetime (e.g. 2026-01-01T00:00:00.000Z). Leave empty — defaults to now.',
  },
  validityTo: {
    default: '',
    description: 'ISO 8601 datetime. Leave empty — defaults to 1 year from now.',
  },
  useCaseId: {
    default: '',
    description:
      'UUID of the use case for this operation. Find it by calling case_file_list and reading useCaseId from any existing case file.',
  },
  description: {
    required: true,
    displayName: 'Item Description',
    description: 'Short plain-text description (e.g. "My case file"). Required by the API.',
  },
  reference: {
    description:
      'Optional user-defined reference code (max 32 chars, e.g. "EXP-2026-001"). Do not use a UUID.',
  },
  // 'content' is the notice body — tier 1 (FR52): mandatory everywhere. EAD Factory's
  // schema marks it optional (a gap); gocertius / ead-enterprise-suite already require
  // it. Must be valid HTML — plain text will not render.
  content: {
    required: true,
    description:
      'Must be valid HTML. Supported tags only: <p>, <strong>, <em>, <ul><li>, <ol><li>. No other tags or CSS. Example: <p>Your document is <strong>ready</strong> for review.</p>',
    displayName: 'Content (HTML)',
  },
};

// Product-specific overrides — applied on top of FIELD_DEFAULTS, keyed by mcpName.
const PRODUCT_OVERRIDES: Record<string, Record<string, FieldPatch>> = {
  gocertius: {
    useCaseId: {
      default: '063a016a-1d62-4b7b-a24f-7cf4d1d289bf',
      description:
        'UUID of the use case. Default is the general GoCertius use case (063a016a-1d62-4b7b-a24f-7cf4d1d289bf). Change only if you need a specific use case.',
    },
  },
  'ead-enterprise-suite': {
    useCaseId: {
      default: '063a016a-1d62-4b7b-a24f-7cf4d1d289bf',
      description:
        'UUID of the use case. Default is the general EAD Enterprise Suite use case (063a016a-1d62-4b7b-a24f-7cf4d1d289bf). Change only if you need a specific use case.',
    },
  },
  // Story 13.5 (FR55): copy-ready examples for EAD Factory's free-form JSON fields
  // so users supply the correct shape without reading external API docs.
  'ead-factory': {
    // Story 13.2a tier 1: EAD Factory's OpenAPI types both of these as a bare string
    // (no enum), and the two use DIFFERENT conventions — confirmed against
    // https://digitaltrust.gcloudfactory.com/notification-manager/notification-operations.html
    // and the signature flow, which rejects a locale with "Invalid language code".
    // The generic FIELD_DEFAULTS 'es_ES' is valid for gocertius / ead-enterprise-suite
    // (their enum is en_GB|es_ES|pt_PT) but would 400 every EAD Factory call, and as a
    // tier-1 field it is now sent on every request — so the default must be right.
    language: {
      default: 'es',
      required: true,
      description:
        'Language for the notice/signature emails. Two-letter code only — "es" or "en". NOT a locale: "es_ES" is rejected with "Invalid language code". (Report and certificate operations use a separate Language Code field, which does take "es_ES".)',
    },
    languageCode: {
      default: 'es_ES',
      required: true,
      description:
        'Language of the generated report/certificate. Locale form — e.g. "es_ES", "en_GB". (Distinct from the Language field on notice/signature operations, which takes a bare "es"/"en".)',
    },
    testimony: {
      description:
        'Qualified-timestamp providers, keyed by family (TSP=eIDAS timestamp, DLT=blockchain). ' +
        'Example: {"TSP":{"required":true,"providers":["EADTrust"]}}. Valid providers: EADTrust, EADTrustCompanySeal, Kepler, LACNet.',
    },
    requiredTestimonyProviders: {
      description:
        'Testimony providers required for this evidence (overrides tenant config). Example: ["EADTrust"], or [] for none.',
    },
    coordinates: {
      description:
        'On-page signature placement(s), in points from the bottom-left. Example: [{"x":100,"y":100,"page":1}]. ' +
        'REQUIRED when the document to sign is a PDF (or a Word converted with Convert To Pdf) — activation fails without it.',
    },
    data: {
      description:
        'Report data — the evidence groups (and their evidences) to include. Example: ' +
        '{"groups":[{"id":"<uuid>","code":"GRP-1","name":"Group 1","type":"FILE","capturedFrom":"2026-01-01T00:00:00Z","capturedUntil":"2026-01-01T00:00:00Z","evidences":[{"id":"<uuid>","title":"Evidence 1"}]}]}.',
    },
    metadata: {
      description:
        'Free key:value string map for extra attributes. Example: {"cliente":"ACME","expediente":"EXP-2026-001"}.',
    },
    filter: {
      description:
        'Search filter — flat fields become query parameters. Example for case files: ' +
        '{"status":"OPEN","page":0,"size":20}. Results are returned under "records".',
    },
  },
};

// Story 13.2a tier 3 (FR52): pre-flight guards, keyed by mcpName → operation.
// Each entry encodes "this field is mandatory when the server says <driver> is X".
// The driver always lives on a DIFFERENT operation (a previous node in the workflow),
// which is precisely why n8n's displayOptions cannot express it — see the tier-2 FINDING
// in epics.md. Rather than let the user hit an opaque API 400, execute() resolves the
// driver from the server when the field was left empty.
//
// Every lookupUrl/driver below is verified against the live INT API, not inferred:
//   - EAD Factory GET /signature-requests/{id} returns documents[] carrying both
//     `filename` and `signatureType` — one lookup answers both guards.
//   - EAD-ES's zShowSignatureRequestControllerRunResponse carries `signatureType` at the
//     top level, and its own signature_participant_create description states that
//     "For ADVANCED signatures, phonePrefix and phoneNumber are mandatory".
export const PRODUCT_PREFLIGHT_GUARDS: Record<string, Record<string, N8nPreflightGuard[]>> = {
  'ead-factory': {
    add_signatory_to_document: [
      {
        field: 'phone',
        lookupUrl: '/api/v1/private/signature-requests/{signatureRequestId}',
        arrayPath: 'documents',
        matchParam: 'documentId',
        driver: 'signatureType',
        equals: 'ADVANCED',
        message:
          'This document is signed with signatureType ADVANCED, so the signatory Phone is mandatory (the signatory is authenticated by phone). Set Phone — e.g. +34600000000 — or use INTERPOSITION on the Add Document step.',
      },
      {
        field: 'coordinates',
        lookupUrl: '/api/v1/private/signature-requests/{signatureRequestId}',
        arrayPath: 'documents',
        matchParam: 'documentId',
        driver: 'filename',
        matchesRe: '\\.pdf$',
        message:
          'The document to sign is a PDF, so Coordinates are mandatory — activating the request fails without them. Set the on-page placement, e.g. [{"x":100,"y":100,"page":1}].',
      },
    ],
  },
  'ead-enterprise-suite': {
    signature_participant_create: [
      {
        field: 'phoneNumber',
        lookupUrl: '/case-files/{caseFileId}/signature-requests/{requestId}',
        driver: 'signatureType',
        equals: 'ADVANCED',
        message:
          'This signature request uses signatureType ADVANCED, so Phone Number (and Phone Prefix) are mandatory — the signer receives the OTP there. Set them, or create the request with INTERPOSITION.',
      },
    ],
  },
};

// Story 13.9 (FR58): parameters that only apply to the vendor's MOBILE-APP API
// surface — device/location capture, which travels with `attestation`, plus the
// app's user agent. They cannot be satisfied from an n8n workflow and only produce
// errors, so the adapter does not emit them at all.
// NOTE: accessToken / purpose are deliberately NOT here — they belong to
// dossier_create / dossier_update, not to app capture (verified by inspection).
export const PRODUCT_EXCLUDED_FIELDS: Record<string, ReadonlySet<string>> = {
  gocertius: new Set([
    'attestation',
    'userAgent',
    'deviceManufacturer',
    'deviceModel',
    'deviceOS',
    'latitudeLocation',
    'longitudeLocation',
    'altitudeLocation',
    'locationAccuracy',
  ]),
  'ead-enterprise-suite': new Set([
    'attestation',
    'userAgent',
    'deviceManufacturer',
    'deviceModel',
    'deviceOS',
    'latitudeLocation',
    'longitudeLocation',
    'altitudeLocation',
    'locationAccuracy',
  ]),
};

// Action verbs that lead an operation label. n8n UX guidelines want operation
// labels phrased verb-first ("Create Case File", "List Evidence"), not
// noun-first ("Case File Create"). Tool names are noun_first_verb_last
// (case_file_create), so we detect a trailing verb and move it to the front.
const OPERATION_VERBS: ReadonlySet<string> = new Set([
  'create',
  'get',
  'list',
  'update',
  'delete',
  'add',
  'remove',
  'seal',
  'certify',
  'link',
  'unlink',
  'send',
  'cancel',
  'activate',
  'assign',
  'set',
  'complete',
  'initiate',
  'login',
  'logout',
  'preview',
  'search',
  'upload',
]);
// Trailing prepositions guard: don't reorder "..._to_link" / "..._for_x" where
// the verb is followed by a preposition phrase, which would mangle the label.
const TRAILING_PREPOSITIONS: ReadonlySet<string> = new Set([
  'to',
  'for',
  'with',
  'by',
  'and',
  'of',
  'from',
  'into',
]);

// Produce a verb-first display label from a snake_case tool name.
//   case_file_create        → "Create Case File"
//   evidence_list           → "List Evidence"
//   activate_signature_...  → "Activate Signature Request" (already verb-first)
//   dossier_evidence_list_to_link → "Dossier Evidence List To Link" (guarded)
function verbFirstLabel(toolName: string, titleCaseFn: (s: string) => string): string {
  const tokens = toolName.split('_').filter((t) => t.length > 0);
  if (tokens.length < 2) return titleCaseFn(toolName.replace(/_/g, '-'));
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  const secondLast = tokens[tokens.length - 2]!;
  // Already verb-first → leave order untouched.
  if (OPERATION_VERBS.has(first)) return titleCaseFn(tokens.join('-'));
  // Trailing verb with no preposition before it → hoist to front.
  if (OPERATION_VERBS.has(last) && !TRAILING_PREPOSITIONS.has(secondLast)) {
    const reordered = [last, ...tokens.slice(0, tokens.length - 1)];
    return titleCaseFn(reordered.join('-'));
  }
  return titleCaseFn(tokens.join('-'));
}

// Story 13.4 (FR54): "<Verb> <Object>" label with the intercalated manager word
// dropped. Strip the leading manager token; if only the verb remains, re-add the
// manager word as the object. Caller prefixes the manager initials.
//   ('evidence_case_file_search', 'evidence') → "Search Case File"
//   ('evidence_search', 'evidence')           → "Search Evidence"
//   ('create_signature_request', 'signature') → "Create Signature Request"
//   ('notification_request_create','notification') → "Create Request"
export function managerAwareLabel(name: string, resourceSlug: string): string {
  let core = name;
  if (name.startsWith(`${resourceSlug}_`)) {
    const rest = name.slice(resourceSlug.length + 1);
    core = rest.includes('_') ? rest : `${rest}_${resourceSlug}`;
  }
  return verbFirstLabel(core, toTitleCase);
}

// Story 13.2b (FR52) tier 4 — ALLOWLIST (not a denylist): the exact parameters that
// are GENUINELY SECONDARY and therefore render inside "Additional Fields".
// Everything else stays top-level.
//
// This MUST be an allowlist. The obvious rule — "the schema says optional, so hide
// it" — is fail-open, and generating the three real nodes proved it: EAD Factory's
// inputSchemas come from hey-api over an upstream OpenAPI that UNDER-DECLARES
// `required`, so that rule buried `code`/`owner`/`category` on
// evidence_case_file_create (the API 500s without them), `data` on
// evidence_case_file_report_generate, and entire request bodies (`patch`,
// `requestModel`, `signatureRequestBody`). With a denylist every newly-added or
// mis-declared field buries itself silently; with this allowlist the worst case is a
// node as verbose as the one already shipped. Same fail-closed reasoning as
// NODE_READABLE_CREDENTIAL_ENV_VARS above. See docs/n8n-adapter-contract.md.
//
// To hide a NEW field, add it here — and only after confirming the API cannot
// require it in any configuration. Deliberately NOT here (Hugo, 2026-07-15):
//   - OTP/WhatsApp delivery (otpRequired, sendWaUrl, phonePrefix…): can be mandatory
//     depending on the signature type → tier 3, visible with the condition stated.
//   - service/web/model (serviceTitle, webUrl, dashboardUrl…): visible.
//   - language: tier 1 — mandatory, visible, carrying a valid default.
// Matched on a normalized name (underscores dropped, lowercased) so snake_case and
// camelCase spellings of the same field cannot diverge.
const SECONDARY_FIELDS: ReadonlySet<string> = new Set(
  [
    // free-form extras — never load-bearing
    'metadata',
    'additionalData',
    // informational / user-defined
    'fileSize',
    'reference',
    // validity window: the API applies its own defaults when absent
    'validityFrom',
    'validityTo',
    // EAD Factory retention + delivery config
    'deletionDate',
    'deletionType',
    'collectMetadata',
    'embedAttachmentsEnabled',
    'autosend',
    'senderName',
    'senderAddress',
    'webhookUris',
  ].map((n) => n.replace(/_/g, '').toLowerCase()),
);

const normalizeFieldName = (name: string): string => name.replace(/_/g, '').toLowerCase();

const PATH_PARAM_RE = /\{(\w+)\}/g;

// Partition an operation's properties into top-level (tiers 1-3) and Additional
// Fields (tier 4). Collection items are sorted by displayName because n8n's
// node-param-collection-type-unsorted-items lint rule requires it.
export function splitAdditionalFields(
  properties: readonly N8nProperty[],
  urlTemplate: string,
  httpMethod: string,
): { topLevel: N8nProperty[]; additional: N8nProperty[] } {
  const pathParams = new Set<string>();
  for (const m of urlTemplate.matchAll(PATH_PARAM_RE)) pathParams.add(m[1]!);
  // A GET/DELETE carries no body: every parameter it takes IS a query/search
  // criterion, and FR52 says search is never secondary. Hiding them left an operation
  // like `notification_request_status` showing only page/size/sort while its actual
  // filters (ids, states, filters) sat behind "Add Field".
  const isBodyless = httpMethod === 'GET' || httpMethod === 'DELETE';
  const topLevel: N8nProperty[] = [];
  const additional: N8nProperty[] = [];
  for (const p of properties) {
    // Required and path params can never be hidden, even if listed as secondary.
    const pinnedTopLevel = p.required === true || isBodyless || pathParams.has(p.name);
    if (!pinnedTopLevel && SECONDARY_FIELDS.has(normalizeFieldName(p.name))) {
      additional.push(p);
    } else {
      topLevel.push(p);
    }
  }
  additional.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { topLevel, additional };
}

function buildOperation(
  tool: InspectorToolEntry,
  mcpName: string,
  urlTemplate: string,
  httpMethod: string,
): {
  op: Omit<N8nOperationSpec, 'httpMethod' | 'httpUrlTemplate' | 'customAnnotation'>;
  notes: string[];
} {
  const { properties, unsupportedNotes } = jsonSchemaToProperties(
    tool.inputSchema as ToolInputSchema | null,
    { operationName: tool.name },
  );
  const productOverrides = PRODUCT_OVERRIDES[mcpName] ?? {};
  // Story 13.9 (FR58): drop app-only parameters before anything else — they never
  // reach the properties list, OPERATION_PROPERTY_NAMES, or the request body.
  const excludedFields = PRODUCT_EXCLUDED_FIELDS[mcpName];
  // Apply known defaults so the n8n UI shows sensible pre-filled values
  const patchedProperties = properties
    .filter((p) => !excludedFields?.has(p.name))
    .map((p) => {
      const patch: FieldPatch = { ...FIELD_DEFAULTS[p.name], ...productOverrides[p.name] };
      if (Object.keys(patch).length === 0) return p;
      return {
        ...p,
        ...(patch.default !== undefined && (p.default === '' || p.default === null)
          ? { default: patch.default }
          : {}),
        ...(patch.description ? { description: patch.description } : {}),
        ...(patch.required !== undefined ? { required: patch.required } : {}),
        ...(patch.displayName ? { displayName: patch.displayName } : {}),
      };
    });
  const { topLevel, additional } = splitAdditionalFields(patchedProperties, urlTemplate, httpMethod);
  return {
    op: {
      name: tool.name,
      displayName: verbFirstLabel(tool.name, toTitleCase),
      description: tool.description ?? '',
      properties: topLevel,
      ...(additional.length > 0 ? { additionalFields: additional } : {}),
    },
    notes: unsupportedNotes,
  };
}

function npmPackageName(scope: string, targetName: string): string {
  const normalizedScope = scope.startsWith('@') ? scope : `@${scope}`;
  return `${normalizedScope}/${targetName}`;
}

function resolveRepoUrl(distribution: DistributionConfig, server: ServerJsonShape): string {
  // server.json#repository.url is the canonical URL the MCP itself
  // declares (Story 1.6); fall back to a placeholder only if it's
  // somehow absent.
  const repo = server.repository;
  if (typeof repo === 'string' && repo.length > 0) return repo;
  if (repo && typeof repo === 'object' && typeof repo.url === 'string' && repo.url.length > 0) {
    return repo.url;
  }
  // distribution config doesn't carry the repo URL directly (that
  // lives in mcp-pipeline.yaml#repo_url, which this loader doesn't
  // expose). Best-effort fallback uses npm_package_name.
  const rawName = distribution.npm_package_name;
  const scopedName = rawName.startsWith('@') ? rawName : `${distribution.npm_scope}/${rawName}`;
  return `https://www.npmjs.com/package/${encodeURIComponent(scopedName)}`;
}

export async function buildN8nNodeSpec(
  input: BuildN8nNodeSpecInput,
): Promise<BuildN8nNodeSpecResult> {
  let distribution: DistributionConfig;
  try {
    distribution = await loadDistributionConfig(input.repoRoot, input.mcpName);
  } catch (err) {
    throw new BuildN8nNodeSpecError(
      'distribution_config',
      `Could not load .distribution.yaml for '${input.mcpName}': ${(err as Error).message}`,
    );
  }

  const server = await readServerJson(input.packageDir);

  // Spawn the MCP via inspector-harness to fetch the live tools/list.
  const command = input.inspectorCommand ?? 'node';
  const args = input.inspectorArgs ?? [await resolveMcpEntryRelPath(input.packageDir)];
  const resolvedArgs = args.map((a) =>
    path.isAbsolute(a) ? a : path.resolve(input.packageDir, a),
  );

  const probe = await runInspectorHarness({
    command,
    args: resolvedArgs,
    ...(typeof input.inspectorTimeoutMs === 'number'
      ? { timeoutMs: input.inspectorTimeoutMs }
      : {}),
  });

  if (probe.launch_error) {
    throw new BuildN8nNodeSpecError(
      'launch',
      `Could not launch MCP for '${input.mcpName}' (${command} ${args.join(' ')}): ${probe.launch_error}`,
    );
  }
  if (!probe.initialize_succeeded) {
    throw new BuildN8nNodeSpecError(
      'launch',
      `MCP for '${input.mcpName}' failed the initialize handshake: ${probe.initialize_error ?? 'unknown'}.`,
    );
  }
  if (probe.tools_list_error) {
    throw new BuildN8nNodeSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' returned tools/list error: ${probe.tools_list_error}.`,
    );
  }
  if (probe.tools_list.length === 0) {
    throw new BuildN8nNodeSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' exposes zero tools — refusing to generate an empty n8n node.`,
    );
  }

  const unsupportedNotes: string[] = [];
  const allOperations: N8nOperationSpec[] = [];
  for (const tool of probe.tools_list) {
    // httpInfo first: splitAdditionalFields needs the URL template to keep path
    // params top-level (Story 13.2b).
    const httpInfo = await readToolHttpInfo(input.packageDir, tool.name);
    const { op, notes } = buildOperation(
      tool,
      input.mcpName,
      httpInfo.httpUrlTemplate,
      httpInfo.httpMethod,
    );
    allOperations.push({
      ...op,
      httpMethod: httpInfo.httpMethod,
      httpUrlTemplate: httpInfo.httpUrlTemplate,
      customAnnotation: httpInfo.customAnnotation,
      ...(httpInfo.isStub ? { isStub: true } : {}),
      // stubSuffix is a pre-rendered string used in the Handlebars template to
      // avoid nested {{#if}} inside {{#each}} (which triggers Handlebars v4's
      // standalone-stripping quirk). See node.ts.hbs OPERATION_META section.
      stubSuffix: httpInfo.stubSuffix ?? '',
    });
    unsupportedNotes.push(...notes);
  }

  // Omit operations with no REST endpoint (STUBs) from the n8n node entirely.
  // The REST-direct adapter (Epic 12 ADR 0008) cannot execute a tool that has
  // no HTTP annotation — composite/custom-only tools like `evidence_upload` do
  // local hashing + multi-step orchestration with no single backing endpoint.
  // n8n Cloud verification rejects operations that always throw, so we drop them
  // rather than ship a throwing stub. Each omission is surfaced as a diagnostic
  // note so an accidentally-unannotated REST tool doesn't disappear silently.
  // See docs/n8n-adapter-contract.md.
  const operations = allOperations.filter((op) => !op.isStub);
  const omittedStubs = allOperations.filter((op) => op.isStub);
  for (const op of omittedStubs) {
    unsupportedNotes.push(
      `Operation '${op.name}' has no REST endpoint (no // n8n-http: annotation and no Sourced-from suffix) — OMITTED from the n8n node. ` +
        `If this is a real REST endpoint, restore its annotation in the MCP source; if it is intentionally custom-only (e.g. evidence_upload), this omission is expected.`,
    );
  }
  if (operations.length === 0) {
    throw new BuildN8nNodeSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' exposes ${allOperations.length} tools but ALL are non-REST stubs — refusing to generate an empty n8n node.`,
    );
  }

  // --- Resource grouping for the n8n resource+operation UI pattern ---
  // Operations are grouped by name prefix into logical resource domains.
  // Only generated for nodes with many operations (>=8) to avoid adding
  // a redundant dropdown to small nodes like EAD Factory.
  const RESOURCE_ORDER = [
    'caseFile',
    'evidence',
    'dossierEvidence',
    'dossier',
    'notification',
    'signature',
    'chat',
    'session',
    'useCase',
  ];
  const RESOURCE_DISPLAY: Record<string, string> = {
    caseFile: 'Case File',
    evidence: 'Evidence',
    dossierEvidence: 'Dossier Evidence',
    dossier: 'Dossier',
    notification: 'Notification',
    signature: 'Signature',
    chat: 'Chat',
    session: 'Session',
    useCase: 'Use Case',
  };
  const detectResource = (opName: string): string => {
    // Legacy EAD Factory evidence tools that don't carry the 'evidence_' prefix but
    // belong to the evidence manager (/digital-trust). Without this they fall through
    // to the 'signature' default — wrong for both the dropdown grouping and, under
    // Story 13.3, the per-manager base path.
    if (opName === 'generate_evidence' || opName === 'get_evidence') return 'evidence';
    if (opName.startsWith('dossier_evidence_')) return 'dossierEvidence';
    if (opName.startsWith('dossier_')) return 'dossier';
    if (opName.startsWith('evidence_') || opName.startsWith('large_evidence_')) return 'evidence';
    if (opName.startsWith('notification_')) return 'notification';
    if (opName.startsWith('case_file_')) return 'caseFile';
    if (opName.startsWith('use_case_')) return 'useCase';
    if (opName.startsWith('session_')) return 'session';
    if (opName.startsWith('chat_')) return 'chat';
    return 'signature';
  };

  // --- Story 13.4 (FR54): manager-aware naming for MULTI-MANAGER products ---
  // Gated on manager_api_base_paths (the multi-manager signal). Resource displays
  // become "<Module> Manager" and each operation is labelled "<Initials> <Verb>
  // <Object>" so operations stay unambiguous when the node is used as an AI tool
  // (no Resource context). Slugs are untouched. Single-API products are unaffected.
  const isMultiManager = !!distribution.manager_api_base_paths;
  const MANAGER_INITIALS: Record<string, string> = {
    evidence: 'EM',
    signature: 'SM',
    notification: 'NM',
    chat: 'CM',
  };
  const RESOURCE_DISPLAY_MULTI: Record<string, string> = {
    evidence: 'Evidence Manager',
    signature: 'Signature Manager',
    notification: 'Notice Manager',
    chat: 'Chat Manager',
  };
  const resourceDisplayName = (r: string): string =>
    (isMultiManager ? RESOURCE_DISPLAY_MULTI[r] : undefined) ?? RESOURCE_DISPLAY[r] ?? r;
  // "<Initials> <Verb> <Object>" via the module-level managerAwareLabel (unit-tested):
  // evidence_search → "EM Search Evidence"; evidence_case_file_search → "EM Search Case File".
  if (isMultiManager) {
    for (const op of operations) {
      const res = detectResource(op.name);
      const initials = MANAGER_INITIALS[res];
      if (initials) op.displayName = `${initials} ${managerAwareLabel(op.name, res)}`;
    }
  }

  const resourceMap = new Map<string, typeof operations>();
  for (const op of operations) {
    const res = detectResource(op.name);
    if (!resourceMap.has(res)) resourceMap.set(res, []);
    resourceMap.get(res)!.push(op);
  }
  const computedResources =
    operations.length >= 8
      ? RESOURCE_ORDER.filter((r) => resourceMap.has(r)).map((r) => ({
          displayName: resourceDisplayName(r),
          value: r,
          operations: resourceMap.get(r)!,
        }))
      : undefined;

  // --- Auto-ID output field map ---
  const AUTO_ID_MAP: Record<string, string> = {
    case_file_create: 'caseFileId',
    evidence_create: 'evidenceId',
    evidence_group_create: 'evidenceGroupId',
    dossier_create: 'dossierId',
    dossier_group_certify: 'dossierId',
    notification_request_create: 'notificationRequestId',
    notification_receiver_add: 'receiverId',
    notification_document_add: 'documentId',
    chat_create: 'chatId',
    chat_certificate_create: 'certificateId',
    signature_request_create: 'requestId',
    signature_group_create: 'groupId',
    signature_participant_create: 'signatoryId',
  };
  const autoIdOutputFields = operations
    .filter((op) => AUTO_ID_MAP[op.name])
    .map((op) => ({ operation: op.name, fieldName: AUTO_ID_MAP[op.name]! }));

  // Story 13.1 (FR51): per-operation defaults for OPTIONAL body params. A boolean
  // 'false', a number '0', or a defaulted non-empty string (e.g. language 'es_ES')
  // would otherwise be transmitted on every call (n8n always returns the default from
  // getNodeParameter) and rejected by the API. Required params are excluded so real
  // missing-required gaps still error; '' and {} defaults are handled by the
  // empty-skip in execute() and are not emitted here.
  const optionalDefaults = operations
    .map((op) => ({
      operation: op.name,
      defaults: op.properties
        .filter((p) => !p.required)
        .filter(
          (p) =>
            typeof p.default === 'boolean' ||
            typeof p.default === 'number' ||
            (typeof p.default === 'string' && p.default !== ''),
        )
        .map((p) => ({ prop: p.name, valueJson: JSON.stringify(p.default) })),
    }))
    .filter((o) => o.defaults.length > 0);

  // Story 13.3 (FR53): per-operation API base-path prefix for MULTI-MANAGER products.
  // When .distribution.yaml declares manager_api_base_paths, each operation's manager
  // (its n8n resource slug, e.g. 'evidence'/'signature'/'notification') maps to a base
  // path the node appends after the credential's gateway-root base URL. A single
  // credential then serves every manager. Absent → single-API product, base URL used
  // as-is (empty prefix, unchanged behavior).
  const managerApiBasePaths = distribution.manager_api_base_paths;
  const operationBasePrefix = managerApiBasePaths
    ? operations
        .map((op) => ({ operation: op.name, prefix: managerApiBasePaths[detectResource(op.name)] }))
        .filter(
          (o): o is { operation: string; prefix: string } =>
            typeof o.prefix === 'string' && o.prefix.length > 0,
        )
    : [];

  // Story 13.2a tier 3 (FR52): emit only the guards whose operation this MCP exposes,
  // so a product never ships a guard for a tool it doesn't have.
  const productGuards = PRODUCT_PREFLIGHT_GUARDS[input.mcpName] ?? {};
  const preflightGuards = operations
    .filter((op) => productGuards[op.name])
    .map((op) => ({ operation: op.name, guards: productGuards[op.name]! }));

  const authStyle = detectAuthStyle(server);
  const credentials = buildCredentials(server, authStyle);
  const defaultApiBaseUrl = await readDefaultApiBaseUrl(input.packageDir);
  const bareTargetName = distribution.n8n_adapter_target_name.replace(/^n8n-nodes-/, '');
  const className = toPascalCase(bareTargetName);
  const resourceLabel = toTitleCase(bareTargetName);
  const paramName = className.charAt(0).toLowerCase() + className.slice(1);
  const credentialClassName = `${className}Api`;
  const credentialParamName = `${paramName}Api`;

  const rawMcpPkgName = distribution.npm_package_name;
  const fullMcpPackageName = rawMcpPkgName.startsWith('@')
    ? rawMcpPkgName
    : `${distribution.npm_scope}/${rawMcpPkgName}`;

  const spec: N8nNodeSpec = {
    packageName: npmPackageName(distribution.npm_scope, distribution.n8n_adapter_target_name),
    sourceMcpPackageName: fullMcpPackageName,
    version: input.version,
    className,
    // Per-MCP overrides (Story 11.3): .distribution.yaml may supply
    // n8n_connector_display_name / n8n_connector_description to avoid the
    // generic TitleCase fallback ("Ead Factory" → "EAD Factory") and to
    // ensure the description uses connector framing ("EAD Factory connector
    // for n8n") rather than the default "n8n community node for ... MCP".
    displayName: distribution.n8n_connector_display_name ?? resourceLabel,
    description:
      distribution.n8n_connector_description ??
      server.description ??
      `${distribution.n8n_connector_display_name ?? resourceLabel} connector for n8n.`,
    nodeName: input.mcpName,
    paramName,
    resourceDisplayName: resourceLabel,
    operations,
    credentials,
    credentialClassName,
    credentialParamName,
    sourceRepoUrl: resolveRepoUrl(distribution, server),
    credentialAcquisitionUrl: (() => {
      const urlRe = /https?:\/\/[^\s)]+/;
      for (const v of server.packages?.[0]?.environmentVariables ?? []) {
        const m = urlRe.exec(v.description ?? '');
        if (m) return m[0];
      }
      return '';
    })(),
    author: { name: 'g-digital by Garrigues', email: 'g-digital@garrigues.com' },
    defaultApiBaseUrl,
    // authStyle drives both the credential allowlist and the execute() token flow.
    authStyle,
    ...(distribution.logo_path ? { iconBundled: true } : {}),
    ...(computedResources ? { resources: computedResources } : {}),
    ...(autoIdOutputFields.length > 0 ? { autoIdOutputFields } : {}),
    ...(optionalDefaults.length > 0 ? { optionalDefaults } : {}),
    ...(operationBasePrefix.length > 0 ? { operationBasePrefix } : {}),
    ...(preflightGuards.length > 0 ? { preflightGuards } : {}),
    ...(distribution.query_param_style ? { queryParamStyle: distribution.query_param_style } : {}),
    hasChatCertificateGet: operations.some((op) => op.name === 'chat_certificate_get') || undefined,
    hasChat: operations.some((op) => op.name.startsWith('chat_')) || undefined,
  };

  return { spec, unsupportedNotes };
}
