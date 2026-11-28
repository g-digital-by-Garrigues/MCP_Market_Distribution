import { describe, expect, it } from 'vitest';
import { normalizeIdCasing } from '../../../../src/adapters/n8n-adapter/normalize-generated-node.js';

// n8n's node-param-description-miscased-id fires on /\b(i|I)d(s?)\b/ and its autofixer
// rewrites only the first match per pass, so anything left to --fix can survive it
// (see the function's doc). These pin the normalization that runs BEFORE the linter.
describe('normalizeIdCasing', () => {
  it('uppercases a standalone id and a backticked field reference', () => {
    expect(normalizeIdCasing('reuse that id; set `id` first')).toBe('reuse that ID; set `ID` first');
  });

  it('uppercases plurals to IDs — the case that left GoCertius 2.1.0 red', () => {
    expect(
      normalizeIdCasing('Every id in `ids` must be evidence of that case file; already-linked ids are skipped.'),
    ).toBe('Every ID in `IDs` must be evidence of that case file; already-linked IDs are skipped.');
    expect(normalizeIdCasing('Ids of the receivers')).toBe('IDs of the receivers');
  });

  it('leaves camelCase identifiers, already-correct casing and other words alone', () => {
    const untouched = 'caseFileId, evidenceIds, ID, IDs, idle, identity, ideas, video';
    expect(normalizeIdCasing(untouched)).toBe(untouched);
  });

  it('leaves nothing n8n would still flag', () => {
    const n8nRule = /\b(i|I)d(s?)\b/;
    const out = normalizeIdCasing('id ids Id Ids `id` `ids` (ids) ids.');
    expect(n8nRule.test(out)).toBe(false);
  });
});
