// Types for the n8n community-node adapter (Track B, Epic 5 / FR27).
//
// The adapter converts an MCP server (tools + credentials + metadata) into
// an n8n community node TypeScript source tree. The intermediate shape is
// an `N8nNodeSpec` — a fully-resolved, validated description of what the
// generator should emit. The Handlebars templates consume this spec; the
// json-schema-to-properties converter feeds it. Keeping the spec separate
// from the IO layer lets us unit-test conversion logic without touching
// the filesystem.
//
// n8n shape recap (single node, multiple operations — the convention for
// MCPs that share credentials across their tools):
//   Resource (constant, hidden) → MCP name
//   Operation (dropdown)        → one entry per MCP tool
//   Operation-scoped properties → derived from each tool's inputSchema
//
// Property types we emit map to n8n's INodeProperties.type union; we
// intentionally support only the subset needed for the v1 MCPs (string,
// number, boolean, options, json) and defer collection/fixedCollection
// until a real MCP needs them.

export type N8nPropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'json';

export interface N8nPropertyOption {
  /** Human-readable label shown in n8n's UI. */
  name: string;
  /** Wire value sent on execute(). */
  value: string | number;
  /** Optional per-option help text. */
  description?: string;
}

export interface N8nProperty {
  /** Camel-case parameter id used in execute() — matches the JSON-Schema property name. */
  name: string;
  /** Title-case label rendered in the n8n UI. */
  displayName: string;
  type: N8nPropertyType;
  default: string | number | boolean | Record<string, unknown> | unknown[];
  description?: string;
  placeholder?: string;
  required?: boolean;
  options?: N8nPropertyOption[];
  /**
   * When set, the property only renders for the named operation(s). The
   * orchestrator fills this in with the parent tool's name so each
   * operation's inputs show conditionally — n8n's standard pattern.
   */
  showForOperation?: string;
  /**
   * Free-form numeric constraints surfaced from the source JSON Schema.
   * n8n's typeOptions accepts minValue/maxValue for `type: 'number'`.
   */
  numberConstraints?: {
    minValue?: number;
    maxValue?: number;
    numberPrecision?: number;
  };
}

/**
 * One tier-3 pre-flight condition: "`field` is mandatory when the server says `driver` is X".
 * Consumed by execute() in node.ts.hbs — see N8nNodeSpec.preflightGuards.
 */
export interface N8nPreflightGuard {
  /** The parameter that may turn out to be mandatory (e.g. 'phone', 'coordinates'). */
  field: string;
  /**
   * URL template of the GET that reveals the driver, relative to the same base +
   * manager prefix as the operation itself. Its `{placeholders}` are filled from the
   * operation's own path params.
   */
  lookupUrl: string;
  /** Optional: pick the array element whose `id` equals the `matchParam` path param. */
  arrayPath?: string;
  /** Path-param name whose value identifies the element inside `arrayPath`. */
  matchParam?: string;
  /** Property holding the driver value (e.g. 'signatureType', 'filename'). */
  driver: string;
  /** Condition: driver === equals. Mutually exclusive with `matchesRe`. */
  equals?: string;
  /** Condition: case-insensitive regex over the driver (e.g. '\\.pdf$'). */
  matchesRe?: string;
  /** The error the user gets instead of the API's opaque rejection. */
  message: string;
}

export interface N8nOperationSpec {
  /** Tool name as exposed by the MCP (snake_case ASCII per the schema). */
  name: string;
  /** Title-case label shown in n8n's Operation dropdown. */
  displayName: string;
  /** Concise description (≤ 1 sentence) shown beneath the dropdown. */
  description: string;
  /** Properties scoped to this operation (already tagged with showForOperation=name). */
  properties: N8nProperty[];
  /**
   * Story 13.2b (FR52) tier 4: genuinely secondary parameters, rendered inside an
   * "Additional Fields" collection instead of top-level. The collection wrapper
   * itself is emitted by node.ts.hbs; this array holds its items, pre-sorted by
   * displayName (n8n's node-param-collection-type-unsorted-items lint rule).
   * Absent when every parameter of the operation stays top-level.
   */
  additionalFields?: N8nProperty[];
  /**
   * HTTP method for the REST-direct call (e.g. 'GET', 'POST').
   * Extracted from the `// Sourced from operation:` comment in the
   * source MCP's `src/tools/<tool>.ts`. 'STUB' means the tool is
   * custom/handwritten and lacks an annotation — it will throw a
   * "use self-hosted" error at runtime.
   * Story 12.2 (Epic 12): REST-direct architecture per ADR 0008.
   */
  httpMethod: string;
  /**
   * URL template for the REST call, e.g. `/case-files/{caseFileId}`.
   * Path parameters are replaced by matching input property names.
   * Empty string when httpMethod === 'STUB'.
   */
  httpUrlTemplate: string;
  /**
   * True when the URL was annotated via `// n8n-http:` comment (custom
   * tool) rather than auto-extracted from `// Sourced from operation:`.
   */
  customAnnotation?: boolean;
  /**
   * True when neither comment was found — the generated node will throw
   * a "use self-hosted" error if this operation is invoked in n8n Cloud.
   */
  isStub?: boolean;
  /**
   * Pre-rendered suffix for the Handlebars template (avoids nested
   * {{#if}} inside {{#each}} which triggers Handlebars standalone-
   * stripping quirks in v4). Either `', stub: true'` or `''`.
   */
  stubSuffix?: string;
}

/**
 * A named resource group used for the n8n resource+operation two-level UI
 * pattern (e.g. Evidence → Create, Get, List). Computed in build-node-spec.ts
 * from operation name prefixes and consumed by node.ts.hbs.
 */
export interface N8nNodeResource {
  /** Title-case label shown in n8n's Resource dropdown (e.g. 'Case File'). */
  displayName: string;
  /** camelCase value used in displayOptions (e.g. 'caseFile'). */
  value: string;
  /** Operations belonging to this resource, in declaration order. */
  operations: N8nOperationSpec[];
}

export interface N8nCredentialField {
  /** Env-var name as the MCP expects it (e.g., OKTA_CLIENT_ID). */
  envName: string;
  /**
   * camelCase property name used in the n8n credential form and in execute()
   * (e.g. oktaClientId). n8n convention requires camelCase, not SCREAMING_SNAKE_CASE.
   */
  propName: string;
  /** Display name shown in n8n's credential editor. */
  displayName: string;
  /** Whether this field is a secret (renders masked, stored encrypted). */
  isSecret: boolean;
  /** Optional explanation surfaced to the user creating the credential. */
  description?: string;
}

export interface N8nNodeSpec {
  /**
   * npm package name for the generated n8n node, e.g.
   * `@g-digital/n8n-nodes-ead-factory`. Derived from
   * `.distribution.yaml#npm_scope + n8n_adapter_target_name`.
   */
  packageName: string;
  /**
   * npm package name of the SOURCE MCP (e.g. `@g-digital/mcp-ead-factory`).
   * Retained for README generation and provenance; no longer bundled
   * into the n8n node (REST-direct architecture per ADR 0008).
   */
  sourceMcpPackageName: string;
  /** Version aligned with the source MCP's version (FR32). */
  version: string;
  /** TitleCase class name used for the node + credential classes. */
  className: string;
  /** Title-case node label shown in n8n's Nodes panel. */
  displayName: string;
  /** Short description shown beneath displayName. */
  description: string;
  /** kebab-case id for `.node.json#group` and search; reused as the resource value. */
  nodeName: string;
  /** camelCase n8n parameter id (`description.name`) — required by n8n. */
  paramName: string;
  /** Display label for the (single) resource. */
  resourceDisplayName: string;
  /** Operations the node exposes (one per MCP tool). */
  operations: N8nOperationSpec[];
  /** Credential-class fields derived from server.json#environmentVariables. */
  credentials: N8nCredentialField[];
  /** Credential class name (always `<className>Api`). */
  credentialClassName: string;
  /** camelCase credential id used by n8n, e.g. `eadFactoryApi`. */
  credentialParamName: string;
  /**
   * Repo URL of the MCP source — surfaced in the generated package.json's
   * homepage + repository.url so n8n consumers can find docs.
   */
  sourceRepoUrl: string;
  /**
   * URL where users can sign up / obtain credentials for this service.
   * Extracted from the first https URL found in server.json env var descriptions.
   * Shown in the README credentials section and credential field descriptions.
   * Empty string when no URL is found.
   */
  credentialAcquisitionUrl: string;
  /**
   * Author block for the generated package.json.
   * Object format avoids the no-template-placeholders linter rule that flags
   * "Name <email>" angle-bracket syntax as an unresolved placeholder.
   */
  author: { name: string; email: string };
  /**
   * When set, the generator copies the source MCP's logo PNG into
   * `<output>/nodes/<className>/icon.png` and emits
   * `icon: 'file:icon.png'` on the node's description so the n8n
   * catalogue + workflow editor render the MCP's logo instead of a
   * generic box. Set from `.distribution.yaml#logo_path` by
   * `build-node-spec.ts`; left undefined when the source MCP ships no
   * logo.
   */
  iconBundled?: boolean;
  /**
   * Default (production) API base URL, extracted from the source MCP's
   * session_login.ts fallback value. Used as the default in the credential
   * form so n8n users connecting to production don't need to fill it in.
   * Empty string when the source MCP has no extractable default (e.g.
   * Okta-only adapters where the base URL is environment-specific).
   */
  defaultApiBaseUrl: string;
  /**
   * Resource groups for the n8n resource+operation two-level UI pattern.
   * When present, the template renders one resource dropdown + one operation
   * dropdown per resource (scoped via displayOptions.show.resource).
   * When absent (e.g. small nodes with < 10 operations), the flat single
   * operation dropdown is rendered instead.
   */
  resources?: N8nNodeResource[];
  /**
   * Per-operation auto-generated ID field names, used to inject the
   * generated UUID into the output under a semantic field name.
   * Computed from AUTO_ID_MAP in build-node-spec.ts for operations in the spec.
   */
  autoIdOutputFields?: Array<{ operation: string; fieldName: string }>;
  /**
   * Story 13.1 (FR51): per-operation default values for OPTIONAL body parameters.
   * At execute() time a value equal to its default is treated as "unset" and omitted
   * from the request. Required params (incl. path params) are excluded here, so a
   * genuinely missing required field still surfaces as an API error. Empty-string and
   * empty-object defaults are already handled by the empty-skip and are not listed.
   * `valueJson` is a JSON-stringified literal for direct emission into the node.
   */
  optionalDefaults?: Array<{
    operation: string;
    defaults: Array<{ prop: string; valueJson: string }>;
  }>;
  /**
   * Story 13.3 (FR53): per-operation API base-path prefix for MULTI-MANAGER products.
   * When set, execute() builds `${baseUrl}${prefix}${urlTemplate}` so one credential
   * (gateway root) serves every manager. Empty/absent for single-API products.
   */
  operationBasePrefix?: Array<{ operation: string; prefix: string }>;
  /**
   * Story 13.2a tier 3 (FR52): pre-flight guards. A tier-3 parameter is mandatory only in
   * a configuration the node cannot see locally — its driver lives on a DIFFERENT operation
   * (set by a previous node), so n8n's `displayOptions` cannot express it and the user only
   * learns about it through an opaque API 400. When such a field is left empty, execute()
   * fetches the server's own state once and raises an explanatory NodeOperationError.
   *
   * Costs nothing when the field is filled in: the lookup only runs for guards whose field
   * is actually empty. Guards are best-effort — a failed or unrecognised lookup never blocks
   * the request, it just falls through to the real API call.
   */
  preflightGuards?: Array<{
    operation: string;
    guards: N8nPreflightGuard[];
  }>;
  /**
   * Story 13.6 (FR56): GET query-parameter serialization style. 'flat' spreads a
   * top-level object (e.g. `filter`) into `key=val` params; 'bracket' (default when
   * absent) uses qs-style `filter[key]=val`. Set 'flat' for APIs that ignore bracketed
   * params (e.g. EAD Factory).
   */
  queryParamStyle?: 'bracket' | 'flat';
  /** True when this node has a chat_certificate_get operation that needs the
   * documentUrl secondary fetch. Used to conditionalize the special-case block
   * in node.ts.hbs (EAD-ES doesn't have chat ops; GoCertius does). */
  hasChatCertificateGet?: boolean;
  /** True when this node exposes any chat_* operation. Gates chat-specific
   * copy in README.md.hbs so nodes without chat (EAD-ES) don't advertise
   * "certified chats" capabilities they can't perform. */
  hasChat?: boolean;
  /**
   * Authentication style for the REST-direct execute() body.
   * 'email-password' → POST /session with email+password → Bearer JWT.
   * 'okta-client-credentials' → POST OKTA_TOKEN_URL with
   *   grant_type=client_credentials → Bearer access_token.
   * 'oauth2-client-credentials' → POST MCP_SVC_TOKEN_URL with
   *   grant_type=client_credentials → Bearer access_token (provider-agnostic;
   *   the generator generalized the hardcoded OKTA_* trio to MCP_SVC_*).
   * Detected from server env vars: MCP_SVC_TOKEN_URL → 'oauth2-client-credentials';
   * else OKTA_TOKEN_URL → 'okta-client-credentials'; else 'email-password'.
   * Story 12.2 (Epic 12): REST-direct architecture per ADR 0008.
   */
  authStyle:
    | 'email-password'
    | 'okta-client-credentials'
    | 'oauth2-client-credentials'
    | 'session-login-or-token';
}
