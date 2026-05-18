import { describe, expect, it } from 'vitest';
import {
  jsonSchemaToMakeParams,
  type ToolInputSchema,
} from '../../../../src/adapters/make-rom/json-schema-to-make-param.js';

describe('jsonSchemaToMakeParams', () => {
  it('converts a required string property to Make `text` type with required=true', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        evidence_id: { type: 'string', description: 'Evidence ID.' },
      },
      required: ['evidence_id'],
    };
    const { parameters, notes } = jsonSchemaToMakeParams(schema, { toolName: 'get_evidence' });
    expect(notes).toEqual([]);
    expect(parameters).toHaveLength(1);
    expect(parameters[0]).toMatchObject({
      name: 'evidence_id',
      label: 'Evidence Id',
      type: 'text',
      required: true,
      default: '',
      help: 'Evidence ID.',
    });
  });

  it("string with enum lowers to type 'select' and surfaces options", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['A', 'B'] },
      },
    };
    const { parameters } = jsonSchemaToMakeParams(schema, { toolName: 'set_status' });
    expect(parameters[0]?.type).toBe('select');
    expect(parameters[0]?.options).toEqual([
      { label: 'A', value: 'A' },
      { label: 'B', value: 'B' },
    ]);
    expect(parameters[0]?.default).toBe('A');
  });

  it("integer/number map to dedicated Make types and preserve schema default", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        page_size: { type: 'integer', default: 25 },
        score: { type: 'number', default: 0.5 },
      },
    };
    const { parameters } = jsonSchemaToMakeParams(schema, { toolName: 'list' });
    const pageSize = parameters.find((p) => p.name === 'page_size')!;
    const score = parameters.find((p) => p.name === 'score')!;
    expect(pageSize.type).toBe('integer');
    expect(pageSize.default).toBe(25);
    expect(score.type).toBe('number');
    expect(score.default).toBe(0.5);
  });

  it("lowers nested object/array to 'json' and flags loweredFromComplexSchema", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        metadata: {
          type: 'object',
          properties: { author: { type: 'string' } },
        },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    const { parameters, notes } = jsonSchemaToMakeParams(schema, { toolName: 'submit' });
    expect(parameters.every((p) => p.type === 'json')).toBe(true);
    expect(parameters.every((p) => p.loweredFromComplexSchema === true)).toBe(true);
    expect(notes.length).toBeGreaterThanOrEqual(2);
  });

  it('flags oneOf/anyOf as unsupported with a note + json fallback', () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        either: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const { parameters, notes } = jsonSchemaToMakeParams(schema, { toolName: 'either' });
    expect(parameters[0]?.type).toBe('json');
    expect(parameters[0]?.loweredFromComplexSchema).toBe(true);
    expect(notes.some((n) => n.toLowerCase().includes('oneof'))).toBe(true);
  });

  it("skips non-identifier names with a diagnostic note", () => {
    const schema: ToolInputSchema = {
      type: 'object',
      properties: {
        'illegal-dash': { type: 'string' },
        legal: { type: 'string' },
      },
    };
    const { parameters, notes } = jsonSchemaToMakeParams(schema, { toolName: 'mixed' });
    expect(parameters.map((p) => p.name)).toEqual(['legal']);
    expect(notes.some((n) => n.includes('illegal-dash'))).toBe(true);
  });

  it('returns empty + note when top-level type is not object', () => {
    const schema = { type: 'string' } as ToolInputSchema;
    const { parameters, notes } = jsonSchemaToMakeParams(schema, { toolName: 'weird' });
    expect(parameters).toEqual([]);
    expect(notes[0]).toMatch(/expects an object/);
  });

  it('handles null/undefined schema gracefully', () => {
    expect(jsonSchemaToMakeParams(null, { toolName: 'x' }).parameters).toEqual([]);
    expect(jsonSchemaToMakeParams(undefined, { toolName: 'y' }).parameters).toEqual([]);
  });
});
