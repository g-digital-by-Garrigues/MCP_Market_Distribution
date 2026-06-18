import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  runInspectorHarness,
  type InspectorToolEntry,
} from '../../gates/inspector-harness.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';
import type { DistributionConfig } from '../../schemas/distribution-config.schema.js';
import {
  jsonSchemaToProperties,
  type ToolInputSchema,
} from './json-schema-to-properties.js';
import type {
  N8nCredentialField,
  N8nNodeSpec,
  N8nOperationSpec,
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

// Env-var fields from server.json that belong to the MCP server runtime and
// are never read by the n8n REST-direct adapter. Shipping them in the n8n
// credential form is confusing — users are asked to fill in fields that do nothing.
const CREDENTIAL_FIELDS_TO_EXCLUDE = new Set([
  'MCP_OPENID_CLIENT_ID',
  'MCP_OPENID_ISSUER',
  'MCP_OPENID_REFRESH_TOKEN',
  'PORT',
]);

// Pattern-based exclusion for MCP-server transport/runtime config that the
// generator may add to .env.example over time (HTTP host/port, CORS, file-URL
// guards). These configure the *MCP server process*, never the n8n REST-direct
// adapter, so they must never reach the n8n credential screen. Pattern-based so
// new transport vars are filtered automatically without a pipeline change —
// part of the regen-resilience contract (see docs/n8n-adapter-contract.md).
const CREDENTIAL_FIELD_EXCLUDE_PATTERNS: readonly RegExp[] = [
  /^MCP_HTTP_/,        // MCP_HTTP_HOST, MCP_HTTP_PUBLIC, MCP_HTTP_PORT…
  /^MCP_ALLOW/,        // MCP_ALLOW_INSECURE_FILE_URL, MCP_ALLOWED_HOSTS, MCP_ALLOWED_ORIGINS
  /^MCP_TRANSPORT/,    // MCP_TRANSPORT
  /^MCP_CORS/,         // MCP_CORS_*
];

function isExcludedCredentialField(envName: string): boolean {
  if (CREDENTIAL_FIELDS_TO_EXCLUDE.has(envName)) return true;
  return CREDENTIAL_FIELD_EXCLUDE_PATTERNS.some((re) => re.test(envName));
}

// Human-readable credential field display names. The generic
// toTitleCase(MCP_AUTH_EMAIL) → "Mcp Auth Email" leaks the env-var prefix into
// the UI; these friendlier labels match what consumers expect.
const CREDENTIAL_DISPLAY_NAME_MAP: Record<string, string> = {
  MCP_AUTH_EMAIL: 'Account Email',
  MCP_AUTH_PASSWORD: 'Account Password',
};

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
  API_BASE_URL: 'apiBaseUrl',
  SIGNATURE_API_BASE_URL: 'signatureApiBaseUrl',
};

function envToCamelCase(envName: string): string {
  if (CREDENTIAL_PROP_NAME_MAP[envName]) return CREDENTIAL_PROP_NAME_MAP[envName];
  // Generic fallback: MY_VAR_NAME → myVarName
  return envName
    .toLowerCase()
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function buildCredentials(server: ServerJsonShape): N8nCredentialField[] {
  const vars = server.packages?.[0]?.environmentVariables ?? [];
  return vars
    .filter((v) => !isExcludedCredentialField(v.name))
    .map((v) => {
      const propName = envToCamelCase(v.name);
      const field: N8nCredentialField = {
        envName: v.name,
        propName,
        displayName:
          CREDENTIAL_DISPLAY_NAME_MAP[v.name] ??
          toTitleCase(v.name.toLowerCase().replace(/_/g, '-')),
        isSecret: v.isSecret === true,
      };
      if (v.description) field.description = v.description;
      return field;
    });
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

async function readToolHttpInfo(
  packageDir: string,
  toolName: string,
): Promise<ToolHttpInfo> {
  const toolFile = path.join(packageDir, 'src', 'tools', `${toolName}.ts`);
  try {
    const content = await fs.readFile(toolFile, 'utf8');
    const headerLines = content.split('\n').slice(0, 8).join('\n');
    const sourced = SOURCED_RE.exec(headerLines);
    if (sourced?.[1] && sourced?.[2]) {
      return { httpMethod: sourced[1], httpUrlTemplate: sourced[2].trim(), customAnnotation: false, stubSuffix: '' };
    }
    const manual = N8N_HTTP_RE.exec(headerLines);
    if (manual?.[1] && manual?.[2]) {
      return { httpMethod: manual[1], httpUrlTemplate: manual[2].trim(), customAnnotation: true, stubSuffix: '' };
    }
  } catch {
    // File not found or unreadable — fall through to STUB
  }
  return { httpMethod: 'STUB', httpUrlTemplate: '', customAnnotation: true, isStub: true, stubSuffix: ', stub: true' };
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
  id: { default: '', description: 'UUID v4 identifier. Leave empty — the node generates it automatically.' },
  language: { default: 'es_ES' },
  evidenceType: { default: 'FILE' },
  custodyType: { default: 'INTERNAL' },
  service: { default: 'Telegram' },
  validityFrom: { default: '', description: 'ISO 8601 datetime (e.g. 2026-01-01T00:00:00.000Z). Leave empty — defaults to now.' },
  validityTo: { default: '', description: 'ISO 8601 datetime. Leave empty — defaults to 1 year from now.' },
  useCaseId: { default: '', description: 'UUID of the use case for this operation. Find it by calling case_file_list and reading useCaseId from any existing case file.' },
  description: { required: true, displayName: 'Item Description', description: 'Short plain-text description (e.g. "My case file"). Required by the API.' },
  reference: { description: 'Optional user-defined reference code (max 32 chars, e.g. "EXP-2026-001"). Do not use a UUID.' },
  // 'content' in notification operations must be valid HTML — plain text will not render.
  content: {
    description: 'Must be valid HTML. Supported tags only: <p>, <strong>, <em>, <ul><li>, <ol><li>. No other tags or CSS. Example: <p>Your document is <strong>ready</strong> for review.</p>',
    displayName: 'Content (HTML)',
  },
};

// Product-specific overrides — applied on top of FIELD_DEFAULTS, keyed by mcpName.
const PRODUCT_OVERRIDES: Record<string, Record<string, FieldPatch>> = {
  'gocertius': {
    useCaseId: {
      default: '063a016a-1d62-4b7b-a24f-7cf4d1d289bf',
      description: 'UUID of the use case. Default is the general GoCertius use case (063a016a-1d62-4b7b-a24f-7cf4d1d289bf). Change only if you need a specific use case.',
    },
  },
  'ead-enterprise-suite': {
    useCaseId: {
      default: '063a016a-1d62-4b7b-a24f-7cf4d1d289bf',
      description: 'UUID of the use case. Default is the general EAD Enterprise Suite use case (063a016a-1d62-4b7b-a24f-7cf4d1d289bf). Change only if you need a specific use case.',
    },
  },
};

// Action verbs that lead an operation label. n8n UX guidelines want operation
// labels phrased verb-first ("Create Case File", "List Evidence"), not
// noun-first ("Case File Create"). Tool names are noun_first_verb_last
// (case_file_create), so we detect a trailing verb and move it to the front.
const OPERATION_VERBS: ReadonlySet<string> = new Set([
  'create', 'get', 'list', 'update', 'delete', 'add', 'remove', 'seal',
  'certify', 'link', 'unlink', 'send', 'cancel', 'activate', 'assign', 'set',
  'complete', 'initiate', 'login', 'logout', 'preview', 'search', 'upload',
]);
// Trailing prepositions guard: don't reorder "..._to_link" / "..._for_x" where
// the verb is followed by a preposition phrase, which would mangle the label.
const TRAILING_PREPOSITIONS: ReadonlySet<string> = new Set([
  'to', 'for', 'with', 'by', 'and', 'of', 'from', 'into',
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

function buildOperation(tool: InspectorToolEntry, mcpName: string): {
  op: Omit<N8nOperationSpec, 'httpMethod' | 'httpUrlTemplate' | 'customAnnotation'>;
  notes: string[];
} {
  const { properties, unsupportedNotes } = jsonSchemaToProperties(
    tool.inputSchema as ToolInputSchema | null,
    { operationName: tool.name },
  );
  const productOverrides = PRODUCT_OVERRIDES[mcpName] ?? {};
  // Apply known defaults so the n8n UI shows sensible pre-filled values
  const patchedProperties = properties.map((p) => {
    const patch: FieldPatch = { ...FIELD_DEFAULTS[p.name], ...productOverrides[p.name] };
    if (Object.keys(patch).length === 0) return p;
    return {
      ...p,
      ...(patch.default !== undefined && (p.default === '' || p.default === null) ? { default: patch.default } : {}),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.required !== undefined ? { required: patch.required } : {}),
      ...(patch.displayName ? { displayName: patch.displayName } : {}),
    };
  });
  return {
    op: {
      name: tool.name,
      displayName: verbFirstLabel(tool.name, toTitleCase),
      description: tool.description ?? '',
      properties: patchedProperties,
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
    const { op, notes } = buildOperation(tool, input.mcpName);
    const httpInfo = await readToolHttpInfo(input.packageDir, tool.name);
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
  const RESOURCE_ORDER = ['caseFile', 'evidence', 'dossierEvidence', 'dossier', 'notification', 'signature', 'chat', 'session', 'useCase'];
  const RESOURCE_DISPLAY: Record<string, string> = {
    caseFile: 'Case File', evidence: 'Evidence', dossierEvidence: 'Dossier Evidence',
    dossier: 'Dossier', notification: 'Notification', signature: 'Signature',
    chat: 'Chat', session: 'Session', useCase: 'Use Case',
  };
  const detectResource = (opName: string): string => {
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
  const resourceMap = new Map<string, typeof operations>();
  for (const op of operations) {
    const res = detectResource(op.name);
    if (!resourceMap.has(res)) resourceMap.set(res, []);
    resourceMap.get(res)!.push(op);
  }
  const computedResources = operations.length >= 8
    ? RESOURCE_ORDER
        .filter((r) => resourceMap.has(r))
        .map((r) => ({ displayName: RESOURCE_DISPLAY[r]!, value: r, operations: resourceMap.get(r)! }))
    : undefined;

  // --- Auto-ID output field map ---
  const AUTO_ID_MAP: Record<string, string> = {
    case_file_create: 'caseFileId', evidence_create: 'evidenceId',
    evidence_group_create: 'evidenceGroupId', dossier_create: 'dossierId',
    dossier_group_certify: 'dossierId', notification_request_create: 'notificationRequestId',
    notification_receiver_add: 'receiverId', notification_document_add: 'documentId',
    chat_create: 'chatId', chat_certificate_create: 'certificateId',
    signature_request_create: 'requestId', signature_group_create: 'groupId',
    signature_participant_create: 'signatoryId',
  };
  const autoIdOutputFields = operations
    .filter((op) => AUTO_ID_MAP[op.name])
    .map((op) => ({ operation: op.name, fieldName: AUTO_ID_MAP[op.name]! }));

  const credentials = buildCredentials(server);
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
    description: distribution.n8n_connector_description
      ?? server.description
      ?? `${distribution.n8n_connector_display_name ?? resourceLabel} connector for n8n.`,
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
    // authStyle: detect from credential fields — OKTA_TOKEN_URL presence → client_credentials
    authStyle: credentials.some((c) => c.envName === 'OKTA_TOKEN_URL')
      ? 'okta-client-credentials'
      : 'email-password',
    ...(distribution.logo_path ? { iconBundled: true } : {}),
    ...(computedResources ? { resources: computedResources } : {}),
    ...(autoIdOutputFields.length > 0 ? { autoIdOutputFields } : {}),
    hasChatCertificateGet: operations.some((op) => op.name === 'chat_certificate_get') || undefined,
    hasChat: operations.some((op) => op.name.startsWith('chat_')) || undefined,
  };

  return { spec, unsupportedNotes };
}
