import type { N8nNodeSpec } from '../../src/adapters/n8n-adapter/types.js';

// Story 18.7 (AC6): the EAD-Factory-shaped spec used to prove the connector
// README gains NOTHING when the product has no `.github/RELEASE_NOTES.md` — no
// section, no stray blank line. (The README is not byte-identical to 1.x overall:
// Epic 18 re-points its `API Base URL` row at the emitted contract's authored
// text. The *.node.ts / *.credentials.ts byte-identity claim is pinned separately
// by tests/unit/adapters/n8n-adapter/oauth2-node-byte-identity.test.ts.)
//
// It lives in tests/helpers/ (outside vitest's `tests/**/*.test.ts` include glob)
// so the golden README committed under tests/fixtures/release-notes/ and the test
// that asserts against it are rendered from the SAME literal. A second copy of
// this object would make the golden prove nothing.
//
// oauth2-client-credentials + an empty `credentials` array is EAD Factory's
// shape: the credential is the native n8n oAuth2Api one (Epic 16), so no env-var
// credential rows reach the README, and `baseUrlRequired` stays unset because
// EAD Factory's `.env.example` declares `MCP_API_BASE_URL` optional (Story 18.1).
export function oauth2NodeSpec(): N8nNodeSpec {
  return {
    packageName: '@g-digital/n8n-nodes-ead-factory',
    sourceMcpPackageName: '@g-digital/mcp-ead-factory',
    version: '1.3.1',
    className: 'EadFactory',
    displayName: 'EAD Factory',
    description: 'EAD Factory connector for n8n.',
    nodeName: 'ead-factory',
    paramName: 'eadFactory',
    resourceDisplayName: 'Ead Factory',
    credentialClassName: 'EadFactoryOAuth2Api',
    credentialParamName: 'eadFactoryOAuth2Api',
    sourceRepoUrl: 'https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP',
    credentialAcquisitionUrl: 'https://example.com/onboarding',
    author: { name: 'g-digital by Garrigues', email: 'g-digital@garrigues.com' },
    authStyle: 'oauth2-client-credentials',
    defaultApiBaseUrl: 'https://api.example.com',
    // Story 18.4 remediation (FR62): the README's `API Base URL` row now renders
    // the AUTHORED description of MCP_API_BASE_URL instead of pipeline copy. This
    // is EAD Factory's, verbatim from `git show origin/main:.env.example`.
    baseUrlDescription:
      'Gateway ROOT URL (e.g. https://api.int.gcloudfactory.com) — each manager\'s path prefix is appended automatically; do NOT include a manager path here',
    credentials: [],
    operations: [
      {
        name: 'evidence_create',
        displayName: 'Evidence Create',
        description: 'Create an evidence record.',
        httpMethod: 'POST',
        httpUrlTemplate: '/evidences',
        properties: [
          {
            name: 'title',
            displayName: 'Title',
            type: 'string',
            default: '',
            description: 'Evidence title.',
            required: true,
            showForOperation: 'evidence_create',
          },
        ],
      },
      {
        name: 'evidence_list',
        displayName: 'Evidence List',
        description: 'List evidence records.',
        httpMethod: 'GET',
        httpUrlTemplate: '/evidences',
        properties: [],
      },
    ],
  };
}
