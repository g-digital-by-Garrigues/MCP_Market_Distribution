import { describe, expect, it } from 'vitest';
import {
  jsonSchemaToProperties,
  type ToolInputSchema,
} from '../../../../src/adapters/n8n-adapter/json-schema-to-properties.js';

describe('jsonSchemaToProperties', () => {
  it('converts a required string property with description', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        evidence_id: { type: 'string', description: 'Evidence ID to retrieve.' },
      },
      required: ['evidence_id'],
    };
    const { properties, unsupportedNotes } = jsonSchemaToProperties(schema, {
      operationName: 'get_evidence',
    });
    expect(unsupportedNotes).toEqual([]);
    expect(properties).toHaveLength(1);
    expect(properties[0]).toMatchObject({
      name: 'evidence_id',
      displayName: 'Evidence Id',
      type: 'string',
      default: '',
      required: true,
      description: 'Evidence ID to retrieve.',
      showForOperation: 'get_evidence',
    });
  });

  it("lowers a string with enum to type 'options'", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'CLOSED'] },
      },
    };
    const { properties } = jsonSchemaToProperties(schema, { operationName: 'set_status' });
    expect(properties[0]?.type).toBe('options');
    expect(properties[0]?.options).toEqual([
      { name: 'DRAFT', value: 'DRAFT' },
      { name: 'ACTIVE', value: 'ACTIVE' },
      { name: 'CLOSED', value: 'CLOSED' },
    ]);
    // Default lands on the first option.
    expect(properties[0]?.default).toBe('DRAFT');
  });

  it('integer with minimum + maximum surfaces numberConstraints with precision 0', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        page_size: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    };
    const { properties } = jsonSchemaToProperties(schema, { operationName: 'list_things' });
    expect(properties[0]?.type).toBe('number');
    expect(properties[0]?.default).toBe(25);
    expect(properties[0]?.numberConstraints).toEqual({
      minValue: 1,
      maxValue: 100,
      numberPrecision: 0,
    });
  });

  it('boolean property defaults to false when schema omits default', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        full_flow: { type: 'boolean', description: 'Run the full convenience flow.' },
      },
    };
    const { properties } = jsonSchemaToProperties(schema, { operationName: 'create' });
    expect(properties[0]?.type).toBe('boolean');
    expect(properties[0]?.default).toBe(false);
    expect(properties[0]?.required).toBeUndefined();
  });

  it("lowers nested object to 'json' and adds an unsupportedNotes entry", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        metadata: {
          type: 'object',
          properties: {
            author: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    };
    const { properties, unsupportedNotes } = jsonSchemaToProperties(schema, {
      operationName: 'submit_doc',
    });
    expect(properties[0]?.type).toBe('json');
    expect(properties[0]?.default).toEqual({});
    expect(unsupportedNotes.length).toBeGreaterThanOrEqual(1);
    expect(unsupportedNotes.some((n) => n.includes("'metadata'") && n.includes('object'))).toBe(true);
  });

  it("lowers array to 'json' with a diagnostic note", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    const { properties, unsupportedNotes } = jsonSchemaToProperties(schema, {
      operationName: 'tag',
    });
    expect(properties[0]?.type).toBe('json');
    expect(unsupportedNotes.some((n) => n.includes("'tags'") && n.includes('array'))).toBe(true);
  });

  it("skips properties with non-identifier names (n8n requires valid TS idents)", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        'illegal-dash-name': { type: 'string' },
        legalName: { type: 'string' },
      },
    };
    const { properties, unsupportedNotes } = jsonSchemaToProperties(schema, {
      operationName: 'mixed',
    });
    expect(properties.map((p) => p.name)).toEqual(['legalName']);
    expect(unsupportedNotes.some((n) => n.includes('illegal-dash-name'))).toBe(true);
  });

  it("flags oneOf and anyOf as unsupported but still produces a json fallback", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        value: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      },
    };
    const { properties, unsupportedNotes } = jsonSchemaToProperties(schema, {
      operationName: 'either',
    });
    expect(properties[0]?.type).toBe('json');
    expect(unsupportedNotes.some((n) => n.toLowerCase().includes('oneof'))).toBe(true);
  });

  it("returns empty + diagnostic when top-level type is not 'object'", () => {
    const schema = { type: 'string' } as ToolInputSchema;
    const { properties, unsupportedNotes } = jsonSchemaToProperties(schema, {
      operationName: 'weird',
    });
    expect(properties).toEqual([]);
    expect(unsupportedNotes[0]).toMatch(/expected 'object'/);
  });

  it('handles a null/undefined schema gracefully', () => {
    const { properties: a, unsupportedNotes: na } = jsonSchemaToProperties(null, { operationName: 'x' });
    expect(a).toEqual([]);
    expect(na).toEqual([]);
    const { properties: b } = jsonSchemaToProperties(undefined, { operationName: 'y' });
    expect(b).toEqual([]);
  });

  it('uses the schema default verbatim when present', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        page_size: { type: 'integer', default: 50 },
        verbose: { type: 'boolean', default: true },
        sort: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
      },
    };
    const { properties } = jsonSchemaToProperties(schema, { operationName: 'list' });
    expect(properties.find((p) => p.name === 'page_size')?.default).toBe(50);
    expect(properties.find((p) => p.name === 'verbose')?.default).toBe(true);
    expect(properties.find((p) => p.name === 'sort')?.default).toBe('desc');
  });

  it('tags every property with showForOperation = operationName', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    };
    const { properties } = jsonSchemaToProperties(schema, { operationName: 'do_it' });
    for (const p of properties) {
      expect(p.showForOperation).toBe('do_it');
    }
  });
});
