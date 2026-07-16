import { describe, expect, it } from 'vitest';
import { splitAdditionalFields } from '../../../../src/adapters/n8n-adapter/build-node-spec.js';
import type { N8nProperty } from '../../../../src/adapters/n8n-adapter/types.js';

// Story 13.2b (FR52) tier 4: "Additional Fields" is driven by an ALLOWLIST of
// genuinely-secondary parameters. Everything else stays top-level.
//
// The rejected alternative — "the schema says optional, so hide it" — is fail-open:
// these inputSchemas come from an OpenAPI that under-declares `required`, so it
// buried provably-mandatory fields (see the ead-factory regressions below). Same
// fail-closed reasoning as the credential allowlist.

const prop = (name: string, over: Partial<N8nProperty> = {}): N8nProperty => ({
  name,
  displayName: name,
  type: 'string',
  default: '',
  showForOperation: 'op',
  ...over,
});

const names = (ps: readonly N8nProperty[]): string[] => ps.map((p) => p.name).sort();

describe('splitAdditionalFields (tier 4 → Additional Fields)', () => {
  it('moves only allowlisted secondary fields into the collection', () => {
    const { topLevel, additional } = splitAdditionalFields(
      [prop('title'), prop('metadata'), prop('fileSize'), prop('reference')],
      '/things',
      'POST',
    );
    expect(names(topLevel)).toEqual(['title']);
    expect(names(additional)).toEqual(['fileSize', 'metadata', 'reference']);
  });

  // The regressions that killed the denylist. Every one of these is optional per the
  // schema yet mandatory in practice, so the rule must keep unknown fields visible.
  it('keeps optional-but-mandatory ead-factory fields top-level (schema under-declares required)', () => {
    const buried = [
      'code', // evidence_case_file_create → API 500s without it
      'owner',
      'category',
      'data', // evidence_case_file_report_generate → documented mandatory
      'patch', // evidence_case_file_update_bulk → the entire payload
      'requestModel', // evidence_group_evidence_upload_url_create → the entire body
      'signatureRequestBody', // create_signature_request → the entire body
    ];
    const { topLevel, additional } = splitAdditionalFields(
      buried.map((n) => prop(n)),
      '/x',
      'POST',
    );
    expect(names(topLevel)).toEqual(names(buried.map((n) => prop(n))));
    expect(additional).toEqual([]);
  });

  it('keeps object references and search criteria top-level', () => {
    const keep = ['caseFileId', 'evidenceGroupId', 'requestId', 'ids', 'filters', 'states'];
    const { topLevel, additional } = splitAdditionalFields(
      keep.map((n) => prop(n)),
      '/x',
      'POST',
    );
    expect(names(topLevel)).toEqual(names(keep.map((n) => prop(n))));
    expect(additional).toEqual([]);
  });

  // Hugo, 2026-07-15: these three groups were explicitly ruled visible.
  it('keeps OTP/WhatsApp, service/web/model and language visible', () => {
    const visible = [
      'otpRequired',
      'otpByDefault',
      'sendWaUrl',
      'sendWaUrlByDefault',
      'phonePrefix',
      'serviceTitle',
      'serviceDescription',
      'webUrl',
      'dashboardUrl',
      'language',
    ];
    const { topLevel, additional } = splitAdditionalFields(
      visible.map((n) => prop(n)),
      '/x',
      'POST',
    );
    expect(names(topLevel)).toEqual(names(visible.map((n) => prop(n))));
    expect(additional).toEqual([]);
  });

  it('never hides a required field, even one on the secondary allowlist', () => {
    const { topLevel, additional } = splitAdditionalFields(
      [prop('metadata', { required: true })],
      '/x',
      'POST',
    );
    expect(names(topLevel)).toEqual(['metadata']);
    expect(additional).toEqual([]);
  });

  it('never hides a path param, even one on the secondary allowlist', () => {
    const { topLevel, additional } = splitAdditionalFields(
      [prop('reference')],
      '/things/{reference}',
      'POST',
    );
    expect(names(topLevel)).toEqual(['reference']);
    expect(additional).toEqual([]);
  });

  // Regression: notification_request_status showed only page/size/sort while its real
  // filters sat behind "Add Field".
  it('keeps EVERY param of a GET/DELETE top-level — they are search criteria, never secondary', () => {
    for (const method of ['GET', 'DELETE']) {
      const { topLevel, additional } = splitAdditionalFields(
        [prop('filters'), prop('metadata')],
        '/notifications/status',
        method,
      );
      expect(names(topLevel)).toEqual(['filters', 'metadata']);
      expect(additional).toEqual([]);
    }
  });

  it('matches allowlist names regardless of snake_case / camelCase spelling', () => {
    const { additional } = splitAdditionalFields(
      [prop('file_size'), prop('fileSize'), prop('validity_from')],
      '/x',
      'POST',
    );
    expect(names(additional)).toEqual(['fileSize', 'file_size', 'validity_from']);
  });

  it('sorts collection items by displayName (n8n node-param-collection-type-unsorted-items)', () => {
    const { additional } = splitAdditionalFields(
      [
        prop('webhookUris', { displayName: 'Webhook URIs' }),
        prop('autosend', { displayName: 'Autosend' }),
        prop('metadata', { displayName: 'Metadata' }),
      ],
      '/x',
      'POST',
    );
    expect(additional.map((p) => p.displayName)).toEqual(['Autosend', 'Metadata', 'Webhook URIs']);
  });

  it('returns no collection when nothing is secondary', () => {
    const { additional } = splitAdditionalFields([prop('title')], '/x', 'POST');
    expect(additional).toEqual([]);
  });
});
