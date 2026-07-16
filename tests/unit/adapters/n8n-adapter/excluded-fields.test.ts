import { describe, expect, it } from 'vitest';
import { PRODUCT_EXCLUDED_FIELDS } from '../../../../src/adapters/n8n-adapter/build-node-spec.js';

// Story 13.9 (FR58): app-only parameters must never reach the generated node —
// device/location capture travels with `attestation` and is only valid when the API
// is called from the vendor's mobile apps; exposed in n8n it only produces errors.
describe('PRODUCT_EXCLUDED_FIELDS (app-only parameters)', () => {
  const appOnly = [
    'attestation',
    'userAgent',
    'deviceManufacturer',
    'deviceModel',
    'deviceOS',
    'latitudeLocation',
    'longitudeLocation',
    'altitudeLocation',
    'locationAccuracy',
  ];

  for (const product of ['gocertius', 'ead-enterprise-suite']) {
    it(`${product}: excludes every app-only capture field`, () => {
      const set = PRODUCT_EXCLUDED_FIELDS[product];
      expect(set).toBeDefined();
      for (const field of appOnly) expect(set!.has(field)).toBe(true);
    });

    it(`${product}: does NOT exclude accessToken / purpose (they belong to dossier_create/update)`, () => {
      const set = PRODUCT_EXCLUDED_FIELDS[product]!;
      expect(set.has('accessToken')).toBe(false);
      expect(set.has('purpose')).toBe(false);
    });
  }

  it('ead-factory has no app-only exclusions (no mobile-app capture surface)', () => {
    expect(PRODUCT_EXCLUDED_FIELDS['ead-factory']).toBeUndefined();
  });
});
