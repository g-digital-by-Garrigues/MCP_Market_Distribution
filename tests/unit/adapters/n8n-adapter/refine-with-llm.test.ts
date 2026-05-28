import { describe, expect, it, vi } from 'vitest';
import { refineWithLlm } from '../../../../src/adapters/n8n-adapter/refine-with-llm.js';
import type { N8nNodeSpec } from '../../../../src/adapters/n8n-adapter/types.js';

function baseSpec(): N8nNodeSpec {
  return {
    packageName: '@g-digital/n8n-nodes-ead-factory',
    sourceMcpPackageName: '@g-digital/mcp-ead-factory',
    version: '1.0.0',
    className: 'EadFactory',
    displayName: 'Ead Factory',
    description: 'n8n community node for the Ead Factory MCP.',
    nodeName: 'ead-factory',
    paramName: 'eadFactory',
    resourceDisplayName: 'Ead Factory',
    credentialClassName: 'EadFactoryApi',
    credentialParamName: 'eadFactoryApi',
    sourceRepoUrl: 'https://github.com/g/x',
    author: 'g-digital by Garrigues',
    authStyle: 'email-password',
    operations: [
      {
        name: 'get_evidence',
        displayName: 'Get Evidence',
        description: '',
        properties: [],
      },
      {
        name: 'create_signature_request',
        displayName: 'Create Signature Request',
        description: '',
        properties: [],
      },
    ],
    credentials: [
      { envName: 'OKTA_CLIENT_ID', displayName: 'Okta Client Id', isSecret: false },
      { envName: 'OKTA_CLIENT_SECRET', displayName: 'Okta Client Secret', isSecret: true },
    ],
  };
}

function mockSuccessResponse(payload: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    }),
    text: async () => '',
  }) as unknown as typeof fetch;
}

const silentLogger = { info: vi.fn(), warn: vi.fn() };

describe('refineWithLlm', () => {
  it('without ANTHROPIC_API_KEY, returns the original spec and applied=false', async () => {
    const spec = baseSpec();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await refineWithLlm({ spec, fetchImpl, env: {}, logger: silentLogger });
    expect(result.applied).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.spec).toBe(spec);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('merges polished copy into operations + credentials when the model returns a valid refinement', async () => {
    const fetchImpl = mockSuccessResponse({
      nodeDescription: 'Use EAD Factory to issue evidence and signatures from n8n.',
      operations: [
        {
          name: 'get_evidence',
          displayName: 'Retrieve Evidence',
          description: 'Fetch the full evidence record (status, custody, metadata) by id.',
        },
        {
          name: 'create_signature_request',
          displayName: 'Start Signature',
          description: 'Open a signature request in DRAFT for one or more documents.',
        },
      ],
      credentials: [
        {
          envName: 'OKTA_CLIENT_ID',
          displayName: 'Okta Client ID',
          description: 'OAuth client id from Okta admin console.',
        },
        {
          envName: 'OKTA_CLIENT_SECRET',
          displayName: 'Okta Client Secret',
          description: 'OAuth client secret paired with the client id.',
        },
      ],
    });

    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'test-key' },
      logger: silentLogger,
    });

    expect(result.applied).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.spec.description).toBe(
      'Use EAD Factory to issue evidence and signatures from n8n.',
    );
    const getEvidence = result.spec.operations.find((o) => o.name === 'get_evidence');
    expect(getEvidence?.displayName).toBe('Retrieve Evidence');
    expect(getEvidence?.description).toContain('evidence record');
    const oktaId = result.spec.credentials.find((c) => c.envName === 'OKTA_CLIENT_ID');
    expect(oktaId?.displayName).toBe('Okta Client ID');
    expect(oktaId?.description).toContain('Okta admin console');

    // changes log records each diff with before/after.
    const paths = result.changes.map((c) => c.path).sort();
    expect(paths).toContain('description');
    expect(paths).toContain('operations[get_evidence].displayName');
    expect(paths).toContain('credentials[OKTA_CLIENT_ID].displayName');
  });

  it('does NOT mutate identifiers (operation name, credential envName) under any output', async () => {
    const fetchImpl = mockSuccessResponse({
      nodeDescription: 'd',
      operations: [
        { name: 'get_evidence', displayName: 'New', description: 'new' },
        { name: 'create_signature_request', displayName: 'X', description: 'y' },
      ],
      credentials: [
        { envName: 'OKTA_CLIENT_ID', displayName: 'A' },
        { envName: 'OKTA_CLIENT_SECRET', displayName: 'B' },
      ],
    });
    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'k' },
      logger: silentLogger,
    });
    expect(result.spec.operations.map((o) => o.name)).toEqual([
      'get_evidence',
      'create_signature_request',
    ]);
    expect(result.spec.credentials.map((c) => c.envName)).toEqual([
      'OKTA_CLIENT_ID',
      'OKTA_CLIENT_SECRET',
    ]);
  });

  it('tolerates the model wrapping JSON in a ```json fence', async () => {
    const payload = {
      nodeDescription: 'd',
      operations: [
        { name: 'get_evidence', displayName: 'Get E', description: 'desc1' },
        { name: 'create_signature_request', displayName: 'Sign', description: 'desc2' },
      ],
      credentials: [
        { envName: 'OKTA_CLIENT_ID', displayName: 'Okta CID' },
        { envName: 'OKTA_CLIENT_SECRET', displayName: 'Okta CS' },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }],
      }),
      text: async () => '',
    }) as unknown as typeof fetch;
    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'k' },
      logger: silentLogger,
    });
    expect(result.applied).toBe(true);
    expect(result.spec.operations[0]!.displayName).toBe('Get E');
  });

  it('returns applied=false + a warning when the model output fails schema validation (e.g., missing required field)', async () => {
    const fetchImpl = mockSuccessResponse({
      nodeDescription: 'd',
      operations: [
        { name: 'get_evidence' /* missing displayName */ },
      ],
      credentials: [],
    });
    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'k' },
      logger: silentLogger,
    });
    expect(result.applied).toBe(false);
    expect(result.warning).toMatch(/schema/);
    expect(result.spec).toEqual(baseSpec());
  });

  it('returns applied=false + warning on HTTP error (no exception escapes)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'invalid api key',
    }) as unknown as typeof fetch;
    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'bad' },
      logger: silentLogger,
    });
    expect(result.applied).toBe(false);
    expect(result.warning).toContain('401');
  });

  it('returns applied=false + warning on network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND api.anthropic.com')) as unknown as typeof fetch;
    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'k' },
      logger: silentLogger,
    });
    expect(result.applied).toBe(false);
    expect(result.warning).toContain('ENOTFOUND');
  });

  it('returns applied=false when the response contains no text content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [] }),
      text: async () => '',
    }) as unknown as typeof fetch;
    const result = await refineWithLlm({
      spec: baseSpec(),
      fetchImpl,
      env: { ANTHROPIC_API_KEY: 'k' },
      logger: silentLogger,
    });
    expect(result.applied).toBe(false);
    expect(result.warning).toContain('no text content');
  });
});
