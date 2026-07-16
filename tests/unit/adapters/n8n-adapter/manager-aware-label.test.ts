import { describe, expect, it } from 'vitest';
import { managerAwareLabel } from '../../../../src/adapters/n8n-adapter/build-node-spec.js';

// Story 13.4 (FR54): the caller prefixes manager initials; this produces the
// "<Verb> <Object>" core with the intercalated manager word dropped.
describe('managerAwareLabel', () => {
  it('drops the leading manager token when an object noun remains', () => {
    expect(managerAwareLabel('evidence_case_file_search', 'evidence')).toBe('Search Case File');
    // The manager word is dropped even inside a compound object; the 'EM'/'SM' prefix
    // (added by the caller) disambiguates e.g. "EM Create Group" vs "SM Create Group".
    expect(managerAwareLabel('evidence_group_create', 'evidence')).toBe('Create Group');
  });

  it('keeps the manager word as the object when only the verb remains', () => {
    expect(managerAwareLabel('evidence_search', 'evidence')).toBe('Search Evidence');
  });

  it('leaves names that do not start with the manager slug intact (verb-first)', () => {
    expect(managerAwareLabel('create_signature_request', 'signature')).toBe('Create Signature Request');
    expect(managerAwareLabel('generate_evidence', 'evidence')).toBe('Generate Evidence');
    expect(managerAwareLabel('get_evidence', 'evidence')).toBe('Get Evidence');
  });

  it('handles notification ops (manager word dropped, object kept)', () => {
    expect(managerAwareLabel('notification_request_create', 'notification')).toBe('Create Request');
  });

  // The two examples Hugo called out explicitly must be unambiguous once initials are prefixed.
  it("distinguishes 'EM Search Case File' from 'EM Search Evidence'", () => {
    expect(`EM ${managerAwareLabel('evidence_case_file_search', 'evidence')}`).toBe('EM Search Case File');
    expect(`EM ${managerAwareLabel('evidence_search', 'evidence')}`).toBe('EM Search Evidence');
  });
});
