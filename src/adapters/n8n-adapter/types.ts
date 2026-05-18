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

export interface N8nOperationSpec {
  /** Tool name as exposed by the MCP (snake_case ASCII per the schema). */
  name: string;
  /** Title-case label shown in n8n's Operation dropdown. */
  displayName: string;
  /** Concise description (≤ 1 sentence) shown beneath the dropdown. */
  description: string;
  /** Properties scoped to this operation (already tagged with showForOperation=name). */
  properties: N8nProperty[];
}

export interface N8nCredentialField {
  /** Env-var name as the MCP expects it (e.g., OKTA_CLIENT_ID). */
  envName: string;
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
   * `@g-digital/n8n-node-ead-factory`. Derived from
   * `.distribution.yaml#npm_scope + n8n_adapter_target_name`.
   */
  packageName: string;
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
  /** Display label for the (single) resource. */
  resourceDisplayName: string;
  /** Operations the node exposes (one per MCP tool). */
  operations: N8nOperationSpec[];
  /** Credential-class fields derived from server.json#environmentVariables. */
  credentials: N8nCredentialField[];
  /**
   * Repo URL of the MCP source — surfaced in the generated package.json's
   * homepage + repository.url so n8n consumers can find docs.
   */
  sourceRepoUrl: string;
  /**
   * Author block for the generated package.json. Defaults to "g-digital by Garrigues".
   */
  author: string;
}
