import { describe, expect, it } from 'vitest';
import {
  RESOURCE_DISPLAY,
  RESOURCE_ORDER,
  detectResource,
} from '../../../../src/adapters/n8n-adapter/build-node-spec.js';

// Story 18.4 (AC3): detectResource decides which Operation dropdown a tool is
// reachable from, and RESOURCE_ORDER is the membership allowlist that decides
// whether that dropdown is emitted at all (build-node-spec.ts: the resource list
// is `RESOURCE_ORDER.filter(...)`, so a slug missing from it silently deletes
// every operation under it). Both are typed against each other now, so most of
// what follows is also a tsc guarantee — the tests state the intent for a reader
// and catch a regression to `Record<string, string>`.
describe('detectResource', () => {
  it("routes the emitted id_verification_* tools to their own resource, not Signature's fallback", () => {
    // The three real EAD Enterprise Suite tool names.
    expect(detectResource('id_verification_video_create')).toBe('idVerification');
    expect(detectResource('id_verification_list')).toBe('idVerification');
    expect(detectResource('id_verification_contract_url')).toBe('idVerification');
  });

  it('labels the resource "Identity Verification" — read off the contract, not invented', () => {
    // The emitted descriptions say "identity verification"; the upstream permit
    // flag is permit.idVerifications.
    expect(RESOURCE_DISPLAY.idVerification).toBe('Identity Verification');
  });

  it('keeps the pre-existing routing intact', () => {
    expect(detectResource('signature_participant_create')).toBe('signature');
    // EAD Factory's legacy evidence tools carry no evidence_ prefix.
    expect(detectResource('generate_evidence')).toBe('evidence');
    expect(detectResource('get_evidence')).toBe('evidence');
    expect(detectResource('evidence_group_create')).toBe('evidence');
    expect(detectResource('dossier_evidence_add')).toBe('dossierEvidence');
    expect(detectResource('dossier_create')).toBe('dossier');
    expect(detectResource('notification_request_create')).toBe('notification');
    expect(detectResource('case_file_create')).toBe('caseFile');
    expect(detectResource('use_case_list')).toBe('useCase');
    expect(detectResource('chat_create')).toBe('chat');
    // Epic 14: profile_get is the User Key user's way to resolve their userId.
    expect(detectResource('profile_get')).toBe('session');
    expect(detectResource('session_login')).toBe('session');
  });

  it('every slug RESOURCE_ORDER declares has a display name', () => {
    for (const slug of RESOURCE_ORDER) {
      expect(RESOURCE_DISPLAY[slug], `no display name for '${slug}'`).toBeTruthy();
    }
    // And nothing extra: an orphan display name means a dropdown nobody reaches.
    expect(Object.keys(RESOURCE_DISPLAY).sort()).toEqual([...RESOURCE_ORDER].sort());
  });

  it('everything detectResource returns over the real tool names is in RESOURCE_ORDER', () => {
    // A slug absent from RESOURCE_ORDER is dropped from `resources`, taking every
    // operation under it with it — the operations become unreachable in n8n.
    const REAL_TOOL_NAMES = [
      // GoCertius / EAD Enterprise Suite
      'case_file_create', 'case_file_list', 'evidence_create', 'evidence_get', 'evidence_seal',
      'evidence_group_create', 'dossier_create', 'dossier_certify', 'dossier_evidence_add',
      'notification_request_create', 'notification_request_status', 'notification_receiver_add',
      'chat_create', 'chat_certificate_get', 'session_login', 'session_info', 'profile_get',
      'use_case_list', 'signature_request_create', 'signature_participant_create',
      'signature_group_create', 'id_verification_video_create', 'id_verification_list',
      'id_verification_contract_url',
      // EAD Factory's unprefixed legacy names
      'generate_evidence', 'get_evidence', 'create_signature_request',
      'add_signatory_to_document', 'activate_signature_request',
    ];
    for (const name of REAL_TOOL_NAMES) {
      expect(RESOURCE_ORDER, `'${name}' → '${detectResource(name)}'`).toContain(detectResource(name));
    }
  });
});
