import type { N8nProperty, N8nPropertyOption } from './types.js';

// Convert one MCP tool's JSON Schema (the `inputSchema` returned by
// tools/list) into an array of n8n `INodeProperties`. The converter is
// deterministic and side-effect free so unit tests can pin it down.
//
// Scope (v1):
//   - Flat top-level properties. JSON Schema lets you nest objects/arrays
//     arbitrarily deep, but n8n's UI works best with a flat parameter
//     list. We collapse nested objects to `type: 'json'` and surface the
//     subschema as a placeholder hint. Real MCPs can revisit this if a
//     tool needs structured nested input.
//   - Type mapping: string → string (or 'options' when `enum` is set),
//     integer/number → number, boolean → boolean, array → json, object →
//     json. enum on a non-string is also lowered to 'options'.
//   - Required tracking: a property is `required: true` iff its name is
//     in the schema's top-level `required[]`.
//   - Defaults: prefer the schema's `default`. Falls back to a per-type
//     safe value (empty string, 0, false, {}) so n8n always has SOMETHING
//     to render — n8n's INodeProperties demands a `default`.
//
// Out of scope (v1):
//   - allOf / anyOf / oneOf — not seen in our MCPs; would need real
//     discriminator logic to model in n8n's UI.
//   - $ref resolution — assumed already de-referenced by the MCP SDK.
//   - format hints (date-time → n8n's dateTime widget) — defer until a
//     real MCP needs it.

const ASCII_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export interface ToolInputSchema {
  type?: 'object' | string;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  // unused but allowed: title, description, additionalProperties, etc.
  [k: string]: unknown;
}

export interface JsonSchemaNode {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | string;
  description?: string;
  default?: unknown;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  // For string types
  format?: string;
  // For array/object — we only surface them as 'json' but keep the field
  // so future versions can render fixedCollection.
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  [k: string]: unknown;
}

export interface JsonSchemaToPropertiesOptions {
  /**
   * Tool name (snake_case) — used to tag every property with
   * `showForOperation` so n8n only renders it for the right operation.
   */
  operationName: string;
  /**
   * If true, log a warning to console.warn whenever we encounter a JSON
   * Schema construct we don't yet support (oneOf/anyOf, deep nesting,
   * unknown type). Defaults to false so library callers can opt in.
   */
  warnOnUnsupported?: boolean;
}

export interface JsonSchemaToPropertiesResult {
  properties: N8nProperty[];
  /**
   * Diagnostic notes about schema features that were lowered with loss
   * (nested object → json, etc.). Surfaced to callers so they can
   * include them in the generated node's README / refinement prompt.
   */
  unsupportedNotes: string[];
}

// Common abbreviations that should be fully uppercased in display names.
const DISPLAY_ABBREVS: ReadonlySet<string> = new Set([
  'id', 'ids', 'url', 'api', 'otp', 'wa', 'os', 'html', 'json', 'pdf', 'sms', 'uuid', 'uri', 'mb', 'gb', 'kb',
]);

function titleCase(name: string): string {
  // Split camelCase (e.g. caseFileId → case File Id) then also split on _ and -
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → words
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // handle consecutive caps: HTMLParser → HTML Parser
    .split(/[_\- ]+/)
    .filter((s) => s.length > 0);

  return words
    .map((word) => {
      const lower = word.toLowerCase();
      if (DISPLAY_ABBREVS.has(lower)) return word.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function defaultForType(type: N8nProperty['type'], options?: N8nPropertyOption[]): N8nProperty['default'] {
  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'options':
      return options && options.length > 0 ? options[0]!.value : '';
    case 'json':
      return {};
  }
}

// BCP-47 locale codes used in EAD/GoCertius APIs mapped to human-readable names.
// titleCase('en_GB') → 'En GB' which is wrong; this map takes priority.
const LOCALE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  en_GB: 'English (UK)',
  en_US: 'English (US)',
  es_ES: 'Spanish (Spain)',
  pt_PT: 'Portuguese (Portugal)',
  fr_FR: 'French (France)',
  de_DE: 'German (Germany)',
  it_IT: 'Italian (Italy)',
  ca_ES: 'Catalan (Spain)',
};

function buildEnumOptions(values: readonly (string | number)[]): N8nPropertyOption[] {
  return values.map((v) => ({
    name: typeof v === 'string' ? (LOCALE_DISPLAY_NAMES[v] ?? titleCase(v)) : String(v),
    value: v,
  }));
}

function jsonSchemaTypeToN8n(node: JsonSchemaNode): N8nProperty['type'] {
  if (node.enum && node.enum.length > 0) return 'options';
  switch (node.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
    case 'object':
      return 'json';
    default:
      return 'json';
  }
}

export function jsonSchemaToProperties(
  schema: ToolInputSchema | null | undefined,
  opts: JsonSchemaToPropertiesOptions,
): JsonSchemaToPropertiesResult {
  const unsupportedNotes: string[] = [];
  const warn = (msg: string): void => {
    unsupportedNotes.push(msg);
    if (opts.warnOnUnsupported) {
      // eslint-disable-next-line no-console
      console.warn(`[n8n-adapter] ${msg}`);
    }
  };

  if (!schema) {
    return { properties: [], unsupportedNotes };
  }

  if (schema.type !== undefined && schema.type !== 'object') {
    warn(
      `Tool '${opts.operationName}' top-level inputSchema.type is '${schema.type}'; expected 'object'. Skipping property generation.`,
    );
    return { properties: [], unsupportedNotes };
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  const properties: N8nProperty[] = [];

  for (const [name, node] of Object.entries(props)) {
    if (!ASCII_IDENT.test(name)) {
      warn(
        `Tool '${opts.operationName}' has a non-identifier property name '${name}'; skipping (n8n parameter names must be valid TS identifiers).`,
      );
      continue;
    }

    const type = jsonSchemaTypeToN8n(node);
    const options = node.enum && node.enum.length > 0 ? buildEnumOptions(node.enum) : undefined;

    // Detect lowering for diagnostics. We lower nested objects + arrays to
    // 'json' so the consumer of unsupportedNotes can show a hint.
    if ((node.type === 'object' || node.type === 'array') && !node.enum) {
      warn(
        `Tool '${opts.operationName}' property '${name}' is type '${node.type}'; rendered as n8n 'json'. Consumers must enter raw JSON in the UI.`,
      );
    }
    if (Array.isArray((node as { oneOf?: unknown }).oneOf)) {
      warn(`Tool '${opts.operationName}' property '${name}' uses oneOf — not modelled in n8n UI; falling back to 'json'.`);
    }
    if (Array.isArray((node as { anyOf?: unknown }).anyOf)) {
      warn(`Tool '${opts.operationName}' property '${name}' uses anyOf — not modelled in n8n UI; falling back to 'json'.`);
    }

    const prop: N8nProperty = {
      name,
      displayName: titleCase(name),
      type,
      default: node.default !== undefined ? (node.default as N8nProperty['default']) : defaultForType(type, options),
      showForOperation: opts.operationName,
    };
    if (node.description) prop.description = node.description;
    if (required.has(name)) prop.required = true;
    if (options) prop.options = options;

    if (type === 'number') {
      const constraints: NonNullable<N8nProperty['numberConstraints']> = {};
      if (typeof node.minimum === 'number') constraints.minValue = node.minimum;
      if (typeof node.maximum === 'number') constraints.maxValue = node.maximum;
      if (node.type === 'integer') constraints.numberPrecision = 0;
      if (Object.keys(constraints).length > 0) prop.numberConstraints = constraints;
    }

    properties.push(prop);
  }

  return { properties, unsupportedNotes };
}
