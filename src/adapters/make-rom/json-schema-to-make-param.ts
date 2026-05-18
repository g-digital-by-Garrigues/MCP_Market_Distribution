import type { MakeParameter, MakeParamType, MakeSelectOption } from './types.js';

// Converts one MCP tool's JSON-Schema `inputSchema` into the parameter
// list Make's UI expects. Mirror image of json-schema-to-properties.ts
// (n8n side) — same lowering rules, different output shape.

const ASCII_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

export interface ToolInputSchema {
  type?: 'object' | string;
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
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
  format?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  [k: string]: unknown;
}

function titleCase(snake: string): string {
  return snake
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function defaultForType(type: MakeParamType, options?: MakeSelectOption[]): MakeParameter['default'] {
  switch (type) {
    case 'text':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'select':
      return options && options.length > 0 ? options[0]!.value : '';
    case 'json':
      return {};
  }
}

function mapType(node: JsonSchemaNode): MakeParamType {
  if (node.enum && node.enum.length > 0) return 'select';
  switch (node.type) {
    case 'string':
      return 'text';
    case 'integer':
      return 'integer';
    case 'number':
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

export interface JsonSchemaToMakeParamResult {
  parameters: MakeParameter[];
  notes: string[];
}

export interface JsonSchemaToMakeParamOptions {
  /** Tool name — used in diagnostic notes for unsupported features. */
  toolName: string;
}

export function jsonSchemaToMakeParams(
  schema: ToolInputSchema | null | undefined,
  opts: JsonSchemaToMakeParamOptions,
): JsonSchemaToMakeParamResult {
  const notes: string[] = [];
  const warn = (msg: string): void => {
    notes.push(msg);
  };

  if (!schema) return { parameters: [], notes };

  if (schema.type !== undefined && schema.type !== 'object') {
    warn(
      `Tool '${opts.toolName}' top-level inputSchema.type is '${schema.type}'; Make ROM expects an object — skipping parameters.`,
    );
    return { parameters: [], notes };
  }

  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  const parameters: MakeParameter[] = [];

  for (const [name, node] of Object.entries(props)) {
    if (!ASCII_IDENT.test(name)) {
      warn(`Tool '${opts.toolName}' has a non-identifier property name '${name}'; skipping.`);
      continue;
    }

    const type = mapType(node);
    const options =
      node.enum && node.enum.length > 0
        ? (node.enum.map((v) => ({ label: String(v), value: v })) as MakeSelectOption[])
        : undefined;

    let loweredFromComplexSchema = false;
    if ((node.type === 'object' || node.type === 'array') && !node.enum) {
      warn(
        `Tool '${opts.toolName}' property '${name}' is type '${node.type}'; rendered as Make 'json' — operator must enter raw JSON.`,
      );
      loweredFromComplexSchema = true;
    }
    if (Array.isArray((node as { oneOf?: unknown }).oneOf)) {
      warn(`Tool '${opts.toolName}' property '${name}' uses oneOf — not modelled in Make UI; falling back to 'json'.`);
      loweredFromComplexSchema = true;
    }
    if (Array.isArray((node as { anyOf?: unknown }).anyOf)) {
      warn(`Tool '${opts.toolName}' property '${name}' uses anyOf — not modelled in Make UI; falling back to 'json'.`);
      loweredFromComplexSchema = true;
    }

    const param: MakeParameter = {
      name,
      label: titleCase(name),
      type,
      required: required.has(name),
      default:
        node.default !== undefined
          ? (node.default as MakeParameter['default'])
          : defaultForType(type, options),
    };
    if (node.description) param.help = node.description;
    if (options) param.options = options;
    if (loweredFromComplexSchema) param.loweredFromComplexSchema = true;

    parameters.push(param);
  }

  return { parameters, notes };
}
