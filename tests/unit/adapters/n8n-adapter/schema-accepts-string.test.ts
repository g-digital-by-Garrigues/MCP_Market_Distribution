import { describe, expect, it } from 'vitest';
import { schemaAcceptsString } from '../../../../src/adapters/n8n-adapter/build-node-spec.js';

// A json-typed n8n field whose schema also accepts a plain string must take typed text
// as-is (EAD Factory: notification_request_status.requestId is anyOf [uuid string, null]).
describe('schemaAcceptsString', () => {
  it('is true for a string, a string in a type list, and a string inside anyOf/oneOf', () => {
    expect(schemaAcceptsString({ type: 'string' })).toBe(true);
    expect(schemaAcceptsString({ type: ['string', 'null'] })).toBe(true);
    expect(schemaAcceptsString({ anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] })).toBe(true);
    expect(schemaAcceptsString({ oneOf: [{ type: 'object' }, { anyOf: [{ type: 'string' }] }] })).toBe(true);
  });

  it('is false for objects, arrays, numbers and unions of them', () => {
    expect(schemaAcceptsString({ type: 'object' })).toBe(false);
    expect(schemaAcceptsString({ type: 'array', items: { type: 'string' } })).toBe(false);
    expect(schemaAcceptsString({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toBe(false);
    expect(schemaAcceptsString(undefined)).toBe(false);
  });
});
