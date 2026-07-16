import { describe, expect, it } from 'vitest';
import { PRODUCT_PREFLIGHT_GUARDS } from '../../../../src/adapters/n8n-adapter/build-node-spec.js';

// Story 13.2a tier 3 (FR52): a guarded field is mandatory only in a configuration the
// node cannot see locally, because the driver is set on a DIFFERENT operation. These
// tests pin the shape and the verified-against-the-real-API facts, so a well-meaning
// edit can't quietly point a guard at a field the response doesn't carry.

describe('PRODUCT_PREFLIGHT_GUARDS', () => {
  it('ead-factory guards phone on the document signatureType (driver set by Add Document)', () => {
    const g = PRODUCT_PREFLIGHT_GUARDS['ead-factory']!['add_signatory_to_document']!.find(
      (x) => x.field === 'phone',
    )!;
    expect(g.lookupUrl).toBe('/api/v1/private/signature-requests/{signatureRequestId}');
    // Verified live: GET signature-request → documents[] carries signatureType.
    expect(g.arrayPath).toBe('documents');
    expect(g.matchParam).toBe('documentId');
    expect(g.driver).toBe('signatureType');
    expect(g.equals).toBe('ADVANCED');
    expect(g.message).toMatch(/ADVANCED/);
  });

  it('ead-factory guards coordinates on the document being a PDF', () => {
    const g = PRODUCT_PREFLIGHT_GUARDS['ead-factory']!['add_signatory_to_document']!.find(
      (x) => x.field === 'coordinates',
    )!;
    expect(g.driver).toBe('filename');
    expect(g.matchesRe).toBe('\\.pdf$');
    // The regex must match real filenames case-insensitively and not fire on other types.
    const re = new RegExp(g.matchesRe!, 'i');
    expect(re.test('documento-demo.pdf')).toBe(true);
    expect(re.test('CONTRATO.PDF')).toBe(true);
    expect(re.test('contrato.docx')).toBe(false);
    expect(re.test('pdf-notes.txt')).toBe(false);
  });

  it('ead-factory shares ONE lookup between both guards (same URL → single fetch)', () => {
    const guards = PRODUCT_PREFLIGHT_GUARDS['ead-factory']!['add_signatory_to_document']!;
    expect(new Set(guards.map((g) => g.lookupUrl)).size).toBe(1);
  });

  it('ead-enterprise-suite guards phoneNumber on the request-level signatureType', () => {
    const g = PRODUCT_PREFLIGHT_GUARDS['ead-enterprise-suite']!['signature_participant_create']![0]!;
    expect(g.field).toBe('phoneNumber');
    expect(g.lookupUrl).toBe('/case-files/{caseFileId}/signature-requests/{requestId}');
    // Verified: zShowSignatureRequestControllerRunResponse has signatureType at top level,
    // so there is no array to index into here (unlike ead-factory's per-document type).
    expect(g.arrayPath).toBeUndefined();
    expect(g.driver).toBe('signatureType');
    expect(g.equals).toBe('ADVANCED');
  });

  it('gocertius has no guards (no cross-operation signature conditional)', () => {
    expect(PRODUCT_PREFLIGHT_GUARDS['gocertius']).toBeUndefined();
  });

  it('every guard is well-formed: exactly one condition, and a message that helps', () => {
    for (const [product, ops] of Object.entries(PRODUCT_PREFLIGHT_GUARDS)) {
      for (const [op, guards] of Object.entries(ops)) {
        for (const g of guards) {
          const where = `${product}.${op}.${g.field}`;
          // Exactly one of equals / matchesRe — execute() treats "no equals" as "use matchesRe".
          expect((g.equals !== undefined) !== (g.matchesRe !== undefined), where).toBe(true);
          if (g.matchesRe) expect(() => new RegExp(g.matchesRe!), where).not.toThrow();
          // arrayPath and matchParam only make sense together.
          expect(!!g.arrayPath, where).toBe(!!g.matchParam);
          // The lookup must be parameterised — a guard that GETs a fixed URL would be
          // reading someone else's object.
          const placeholders = [...g.lookupUrl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
          expect(placeholders.length, where).toBeGreaterThan(0);
          // matchParam is a path param of the OPERATION (used to pick the array element),
          // deliberately NOT of the lookup URL: ead-factory looks up the whole signature
          // request by {signatureRequestId}, then selects documents[] by documentId.
          if (g.matchParam) expect(g.matchParam, where).toMatch(/^\w+$/);
          expect(g.message.length, where).toBeGreaterThan(40);
        }
      }
    }
  });
});
