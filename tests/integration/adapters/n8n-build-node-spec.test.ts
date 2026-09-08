import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import {
  buildN8nNodeSpec,
  BuildN8nNodeSpecError,
} from '../../../src/adapters/n8n-adapter/build-node-spec.js';
import { generateN8nNode } from '../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import { POST_E18_ENV_VARS } from '../../fixtures/env-sets/post-e18-user-key.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const MULTI_TOOL_STUB = path.join(REPO_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-multi-tool.mjs');
// Story 18.4: >= 8 REST tools spanning the real resource prefixes, incl. the
// three emitted id_verification_* names and a deliberate unroutable offender.
const RESOURCES_STUB = path.join(REPO_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-resources.mjs');

interface SetupOpts {
  mcpName: string;
  /** Extra fields merged into the .distribution.yaml fixture. */
  distributionOverrides?: Record<string, unknown>;
  /** When omitted, server.json is written with two environmentVariables. */
  /** `isSecret` is optional so a fixture can exercise the name-suffix secret rule. */
  envVars?: Array<{ name: string; description: string; isSecret?: boolean; isRequired: boolean }>;
  /** When false, no server.json is written so we can exercise the missing-file branch. */
  writeServerJson?: boolean;
  /** When false, no src/tools/*.ts REST annotations are written, so every tool
   * is a non-REST stub (exercises the omit-stub branch). */
  writeToolAnnotations?: boolean;
  /**
   * Story 18.4: the `// n8n-http:` annotations to write, keyed by tool name.
   * Defaults to the three widget tools of server-multi-tool.mjs. A tool the stub
   * advertises but this map omits stays a non-REST STUB and never enters
   * `operations` — which is how a test drops one tool from the fixture.
   */
  toolAnnotations?: Record<string, string>;
}

async function setupFixture(opts: SetupOpts): Promise<{
  repoRoot: string;
  packageDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-adapter-spec-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', opts.mcpName);
  await fs.mkdir(packageDir, { recursive: true });

  const distribution = {
    distribution_schema_version: 1,
    reverse_dns_name: `io.github.test/${opts.mcpName}`,
    npm_scope: '@g-digital',
    npm_package_name: `@g-digital/mcp-${opts.mcpName}`,
    docker_image_name: `gdigital/${opts.mcpName}`,
    n8n_adapter_target_name: `n8n-nodes-${opts.mcpName}`,
    license: 'MIT',
    credential_help_url: 'https://example.com',
    target_overrides: {},
    ...(opts.distributionOverrides ?? {}),
  };
  await fs.writeFile(path.join(packageDir, '.distribution.yaml'), yaml.dump(distribution));
  // Minimal mcp-pipeline.yaml so the loader's parent registry parses.
  const registry = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps: { [opts.mcpName]: { repo_url: 'https://github.com/test/test-mcp' } },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(registry));

  if (opts.writeServerJson !== false) {
    // Default: the real post-Epic-18 emitted contract (one User Key credential, a
    // required non-secret base URL, the inbound-introspection MCP_SVC_* trio and the
    // transport tail). MCP_HTTP_HOST is the allowlist canary — it is in the real
    // contract and must never reach the n8n credential.
    const envVars = opts.envVars ?? POST_E18_ENV_VARS;
    const serverJson = {
      $schema: 'https://example.com/server.schema.json',
      name: distribution.reverse_dns_name,
      description: 'A test multi-tool MCP.',
      version: '1.0.0',
      repository: { source: 'github', url: 'https://github.com/test/test-mcp' },
      packages: [
        {
          identifier: distribution.npm_package_name,
          registryType: 'npm',
          transport: { type: 'stdio' },
          version: '1.0.0',
          environmentVariables: envVars,
        },
      ],
    };
    await fs.writeFile(path.join(packageDir, 'server.json'), JSON.stringify(serverJson, null, 2));
  }

  // REST annotations for the stub MCP's tools so they are REST-capable
  // operations (not omitted as non-REST stubs). The adapter reads the
  // `// n8n-http: METHOD /path` header from src/tools/<tool>.ts.
  if (opts.writeToolAnnotations !== false) {
    const toolsDir = path.join(packageDir, 'src', 'tools');
    await fs.mkdir(toolsDir, { recursive: true });
    const annotations: Record<string, string> = opts.toolAnnotations ?? {
      get_widget: '// n8n-http: GET /widgets/{widget_id}',
      list_widgets: '// n8n-http: GET /widgets',
      submit_widget: '// n8n-http: POST /widgets',
    };
    for (const [tool, header] of Object.entries(annotations)) {
      await fs.writeFile(path.join(toolsDir, `${tool}.ts`), `${header}\nexport {};\n`);
    }
  }

  return {
    repoRoot,
    packageDir,
    cleanup: async () => fs.rm(repoRoot, { recursive: true, force: true }),
  };
}

describe('buildN8nNodeSpec (integration with stub MCP)', () => {
  it('Story 13.3: manager_api_base_paths → per-operation base prefix (one credential, many managers)', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      distributionOverrides: {
        // Both managers declared; the stub's ops classify as 'signature', so only the
        // signature prefix is applied and none get the evidence prefix (discrimination).
        manager_api_base_paths: { evidence: '/digital-trust', signature: '/signature-manager' },
      },
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      const prefixes = Object.fromEntries(
        (spec.operationBasePrefix ?? []).map((e) => [e.operation, e.prefix]),
      );
      // Every stub op resolves to the signature manager → its prefix; none get evidence's.
      expect(prefixes['get_widget']).toBe('/signature-manager');
      expect(prefixes['list_widgets']).toBe('/signature-manager');
      expect(prefixes['submit_widget']).toBe('/signature-manager');
      expect(Object.values(prefixes)).not.toContain('/digital-trust');
    } finally {
      await cleanup();
    }
  });

  it('Story 13.3: no manager_api_base_paths → no operationBasePrefix (single-API product unchanged)', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({ mcpName: 'multi-tool' });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      expect(spec.operationBasePrefix).toBeUndefined();
      // Story 13.4: single-API product keeps plain operation labels (no manager initials).
      expect(spec.operations.find((o) => o.name === 'get_widget')?.displayName).toBe('Get Widget');
    } finally {
      await cleanup();
    }
  });

  it('Story 13.4: multi-manager product prefixes operation labels with manager initials', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      distributionOverrides: {
        manager_api_base_paths: { evidence: '/digital-trust', signature: '/signature-manager' },
      },
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      // Stub ops classify as the signature manager → 'SM' prefix, manager word dropped.
      expect(spec.operations.find((o) => o.name === 'get_widget')?.displayName).toBe('SM Get Widget');
      expect(spec.operations.find((o) => o.name === 'list_widgets')?.displayName).toBe('SM List Widgets');
      expect(spec.operations.find((o) => o.name === 'submit_widget')?.displayName).toBe('SM Submit Widget');
    } finally {
      await cleanup();
    }
  });

  it('Story 13.6: query_param_style flows to the spec (flat / default undefined)', async () => {
    const flat = await setupFixture({
      mcpName: 'multi-tool',
      distributionOverrides: { query_param_style: 'flat' },
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot: flat.repoRoot, packageDir: flat.packageDir, mcpName: 'multi-tool',
        version: '1.0.0', inspectorCommand: process.execPath, inspectorArgs: [MULTI_TOOL_STUB], inspectorTimeoutMs: 10_000,
      });
      expect(spec.queryParamStyle).toBe('flat');
    } finally {
      await flat.cleanup();
    }
    const def = await setupFixture({ mcpName: 'multi-tool' });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot: def.repoRoot, packageDir: def.packageDir, mcpName: 'multi-tool',
        version: '1.0.0', inspectorCommand: process.execPath, inspectorArgs: [MULTI_TOOL_STUB], inspectorTimeoutMs: 10_000,
      });
      expect(spec.queryParamStyle).toBeUndefined();
    } finally {
      await def.cleanup();
    }
  });

  it('builds a spec with one operation per tool from the multi-tool stub', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({ mcpName: 'multi-tool' });
    try {
      const { spec, unsupportedNotes } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      // High-level shape.
      expect(spec.packageName).toBe('@g-digital/n8n-nodes-multi-tool');
      expect(spec.version).toBe('1.0.0');
      expect(spec.className).toBe('MultiTool');
      expect(spec.displayName).toBe('Multi Tool');
      expect(spec.nodeName).toBe('multi-tool');

      // One operation per stubbed tool.
      const opNames = spec.operations.map((o) => o.name).sort();
      expect(opNames).toEqual(['get_widget', 'list_widgets', 'submit_widget']);

      // get_widget operation has the required widget_id property tagged for its scope.
      const getWidget = spec.operations.find((o) => o.name === 'get_widget')!;
      expect(getWidget.properties).toHaveLength(1);
      expect(getWidget.properties[0]).toMatchObject({
        name: 'widget_id',
        type: 'string',
        required: true,
        showForOperation: 'get_widget',
      });

      // list_widgets has 3 props with the right types + numberConstraints.
      const listWidgets = spec.operations.find((o) => o.name === 'list_widgets')!;
      const pageSize = listWidgets.properties.find((p) => p.name === 'page_size')!;
      expect(pageSize.type).toBe('number');
      expect(pageSize.numberConstraints).toEqual({
        minValue: 1,
        maxValue: 100,
        numberPrecision: 0,
      });
      const sort = listWidgets.properties.find((p) => p.name === 'sort')!;
      expect(sort.type).toBe('options');
      expect(sort.options).toEqual([
        { name: 'Asc', value: 'asc' },
        { name: 'Desc', value: 'desc' },
      ]);

      // submit_widget has nested object → 'json' + diagnostic note.
      // Story 13.2b (FR52): metadata is optional and non-conditional → tier 4, so it
      // lives in the Additional Fields collection rather than top-level.
      const submitWidget = spec.operations.find((o) => o.name === 'submit_widget')!;
      expect(submitWidget.properties.some((p) => p.name === 'metadata')).toBe(false);
      const metadata = submitWidget.additionalFields!.find((p) => p.name === 'metadata')!;
      expect(metadata.type).toBe('json');
      expect(unsupportedNotes.some((n) => n.includes("'metadata'"))).toBe(true);

      // Epic 18: declaring MCP_AUTH_USER_KEY makes this a user-facing product with a
      // single upstream credential → 'user-key'.
      expect(spec.authStyle).toBe('user-key');
      // Credentials are the allowlisted auth fields only; the MCP_HTTP_HOST
      // server-runtime var, the MCP_SVC_* introspection trio and MCP_API_BASE_URL
      // are all dropped (the base URL has its own template-emitted property).
      expect(spec.credentials.map((c) => c.propName)).toEqual(['userKey']);
      const key = spec.credentials.find((c) => c.envName === 'MCP_AUTH_USER_KEY')!;
      expect(key.displayName).toBe('User Key');
      expect(key.isSecret).toBe(true);
      // AC4: requiredness comes from the declared contract, not from secrecy.
      expect(key.isRequired).toBe(true);
      // AC3: the description is the authored text PLUS the credential-help suffix
      // that generate-environment-variables appends to every secret.
      expect(key.description).toBe(
        'Long-lived GoCertius user key, exchanged automatically for a short-lived session token. Use it for headless or automated access instead of an account password. (See https://www.gocertius.io for credential acquisition.)',
      );
      // AC5: MCP_API_BASE_URL is declared required → the template-emitted baseUrl
      // property renders required, without becoming a second credential field.
      expect(spec.baseUrlRequired).toBe(true);
      expect(spec.credentials.some((c) => c.envName === 'MCP_HTTP_HOST')).toBe(false);
      expect(spec.credentials.some((c) => c.envName === 'MCP_API_BASE_URL')).toBe(false);
      expect(spec.credentials.some((c) => c.envName.startsWith('MCP_SVC_'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('detects generic OAuth2 client_credentials (MCP_SVC_*) and emits NO env-derived credential props (Epic 16: extends oAuth2Api)', async () => {
    // The generator generalized the hardcoded OKTA_* trio to a provider-agnostic
    // MCP_SVC_* set. detectAuthStyle must recognize MCP_SVC_TOKEN_URL. Epic 16: the
    // credential now extends n8n's oAuth2Api, so Client ID / Client Secret / Access
    // Token URL / Scope come from the base type — build-node-spec emits an EMPTY
    // credentials list (no mcpSvc* custom props), and never the introspect URL or
    // transport config.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: [
        { name: 'MCP_SVC_TOKEN_URL', description: 'OAuth2 token endpoint.', isSecret: false, isRequired: true },
        { name: 'MCP_SVC_CLIENT_ID', description: 'OAuth2 client id.', isSecret: false, isRequired: true },
        { name: 'MCP_SVC_CLIENT_SECRET', description: 'OAuth2 client secret.', isSecret: true, isRequired: true },
        { name: 'MCP_SVC_SCOPE', description: 'OAuth2 scope.', isSecret: false, isRequired: false },
        { name: 'MCP_SVC_INTROSPECT_URL', description: 'Inbound bearer introspection (server config).', isSecret: false, isRequired: false },
        { name: 'MCP_HTTP_HOST', description: 'MCP server HTTP bind host.', isSecret: false, isRequired: false },
      ],
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      expect(spec.authStyle).toBe('oauth2-client-credentials');
      // Epic 16: no env-derived credential props — the oAuth2Api base owns the OAuth
      // fields; the template renders only baseUrl + hidden grantType/authentication.
      expect(spec.credentials).toEqual([]);
      // Epic 16: OAuth2 credentials must follow n8n's naming convention
      // (@n8n/community-nodes/cred-class-oauth2-naming) or the linter rejects them.
      expect(spec.credentialClassName).toMatch(/OAuth2Api$/);
      expect(spec.credentialParamName).toContain('OAuth2');
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('user key + MCP_SVC_CLIENT_* (no MCP_SVC_TOKEN_URL) → user-key, NOT oauth2 (user-facing wins)', async () => {
    // GoCertius / EAD Enterprise Suite declare BOTH a user-key surface AND an
    // MCP_SVC_CLIENT_ID/SECRET pair — the latter are the server's own resource-server
    // credentials for INBOUND token introspection, not an n8n sign-in. They are also
    // members of the oauth2 allowlist, so they stay out of the form only because
    // MCP_SVC_TOKEN_URL (the sole oauth2 discriminator) is absent. Replaces the
    // Epic 14 email-vs-MCP_SVC precedence test, whose premise (MCP_AUTH_EMAIL) was
    // deleted upstream in Epic 18.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: [
        { name: 'MCP_AUTH_USER_KEY', description: 'Long-lived user key.', isSecret: true, isRequired: true },
        { name: 'MCP_SVC_CLIENT_ID', description: 'Introspection client id (server-side).', isSecret: false, isRequired: false },
        { name: 'MCP_SVC_CLIENT_SECRET', description: 'Introspection client secret (server-side).', isSecret: true, isRequired: false },
        { name: 'MCP_SVC_INTROSPECT_URL', description: 'Inbound bearer introspection (server config).', isSecret: false, isRequired: false },
      ],
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      expect(spec.authStyle).toBe('user-key');
      // Surface = the User Key alone. NO mcpSvc* leaks in.
      expect(spec.credentials.map((c) => c.propName)).toEqual(['userKey']);
      expect(spec.credentials.some((c) => c.propName.startsWith('mcpSvc'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('exposes MCP_AUTH_USER_KEY as the secret, required userKey credential (Epic 18)', async () => {
    // The real gocertius / ead-enterprise-suite surface after the E18 propagation:
    // one User Key, alongside the server's own inbound-introspection trio and the
    // transport tail. Everything that is not the User Key must be dropped.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: POST_E18_ENV_VARS,
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      expect(spec.authStyle).toBe('user-key');
      expect(spec.credentials.map((c) => c.propName)).toEqual(['userKey']);
      const key = spec.credentials.find((c) => c.envName === 'MCP_AUTH_USER_KEY')!;
      expect(key.propName).toBe('userKey');
      expect(key.displayName).toBe('User Key');
      // The declared `# isSecret: true` alone is enough here — the _KEY$ suffix rule
      // is a separate fail-closed backstop and must not be what carries this.
      expect(key.isSecret).toBe(true);
      expect(key.isRequired).toBe(true);
      // Server config never reaches the credential form (fail-closed allowlist).
      expect(spec.credentials.some((c) => c.envName.startsWith('MCP_OPENID'))).toBe(false);
      expect(spec.credentials.some((c) => c.envName.startsWith('MCP_SVC'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('omits non-REST stub operations from the node and emits a diagnostic note', async () => {
    // Annotate only 2 of the 3 tools; submit_widget has no REST endpoint.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      writeToolAnnotations: false,
    });
    try {
      const toolsDir = path.join(packageDir, 'src', 'tools');
      await fs.mkdir(toolsDir, { recursive: true });
      await fs.writeFile(path.join(toolsDir, 'get_widget.ts'), '// n8n-http: GET /widgets/{widget_id}\nexport {};\n');
      await fs.writeFile(path.join(toolsDir, 'list_widgets.ts'), '// n8n-http: GET /widgets\nexport {};\n');
      // submit_widget.ts intentionally absent → non-REST stub → omitted.

      const { spec, unsupportedNotes } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      const opNames = spec.operations.map((o) => o.name).sort();
      expect(opNames).toEqual(['get_widget', 'list_widgets']);
      expect(spec.operations.some((o) => o.name === 'submit_widget')).toBe(false);
      expect(unsupportedNotes.some((n) => n.includes('submit_widget') && n.includes('OMITTED'))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("throws BuildN8nNodeSpecError(stage='server_json') when server.json is absent", async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      writeServerJson: false,
    });
    try {
      await expect(
        buildN8nNodeSpec({
          repoRoot,
          packageDir,
          mcpName: 'multi-tool',
          version: '1.0.0',
          inspectorCommand: process.execPath,
          inspectorArgs: [MULTI_TOOL_STUB],
          inspectorTimeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ name: 'BuildN8nNodeSpecError', stage: 'server_json' });
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("throws BuildN8nNodeSpecError(stage='launch') when the MCP command does not exist", async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({ mcpName: 'multi-tool' });
    try {
      await expect(
        buildN8nNodeSpec({
          repoRoot,
          packageDir,
          mcpName: 'multi-tool',
          version: '1.0.0',
          inspectorCommand: 'node',
          inspectorArgs: ['/does/not/exist/server.js'],
          inspectorTimeoutMs: 10_000,
        }),
      ).rejects.toBeInstanceOf(BuildN8nNodeSpecError);
    } finally {
      await cleanup();
    }
  }, 30_000);
  // ── Epic 18 / FR61 ────────────────────────────────────────────────────────
  // The emitted contract for GoCertius / EAD Enterprise Suite collapsed to ONE
  // upstream credential (MCP_AUTH_USER_KEY). These pin the three things that
  // silently broke: detection keyed on a variable that no longer exists, the
  // fall-through default that produced a credential with zero auth fields, and
  // the ever-present temptation to mint a second base-URL property.

  it('throws BuildN8nNodeSpecError when NO auth discriminator is declared (FR61: fail loudly, never fall through)', async () => {
    // The E18 regression in one test: goc/suite stopped declaring MCP_AUTH_EMAIL,
    // detection fell through to 'email-password', the allowlist intersected the
    // declared set to [] and the pipeline shipped a credential form with no
    // authentication fields at all — 8/8 on the gate.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: [
        { name: 'MCP_HTTP_HOST', description: 'MCP server HTTP bind host.', isSecret: false, isRequired: false },
        { name: 'PORT', description: 'HTTP port in hosted mode.', isSecret: false, isRequired: false },
      ],
    });
    try {
      const promise = buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      await expect(promise).rejects.toBeInstanceOf(BuildN8nNodeSpecError);
      await expect(promise).rejects.toMatchObject({
        name: 'BuildN8nNodeSpecError',
        stage: 'server_json',
      });
      const err = await promise.then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err!.message).toContain('MCP_AUTH_USER_KEY');
      expect(err!.message).toContain('MCP_SVC_TOKEN_URL');
      expect(err!.message).toContain('OKTA_TOKEN_URL');
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('Epic 18: the post-propagation contract yields exactly one credential property — userKey', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: POST_E18_ENV_VARS,
    });
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      expect(spec.credentials.map((c) => c.propName)).toEqual(['userKey']);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('MCP_API_BASE_URL never becomes a credential property — the credential has exactly one base URL', async () => {
    // Permanent guardrail. MCP_API_BASE_URL is declared and REQUIRED in the emitted
    // contract, but the template already renders a `baseUrl` property; adding the env
    // var to the allowlist would mint a second, unread `mcpApiBaseUrl` field.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: POST_E18_ENV_VARS,
    });
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-baseurl-'));
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      expect(spec.credentials.every((c) => c.envName !== 'MCP_API_BASE_URL')).toBe(true);
      expect(spec.credentials.some((c) => c.propName === 'mcpApiBaseUrl')).toBe(false);

      await generateN8nNode({ spec, outputDir });
      const credSrc = await fs.readFile(
        path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
        'utf8',
      );
      expect(credSrc.match(/name: 'baseUrl'/g)).toHaveLength(1);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
      await cleanup();
    }
  }, 30_000);
});


// Story 18.4 (AC3/AC4/AC5): resource routing is a contract, not a guess.
describe('buildN8nNodeSpec — resource routing and auto-id (Story 18.4)', () => {
  // Every advertised tool of server-resources.mjs, annotated as a real REST
  // operation. `widget_frobnicate` is the deliberate offender.
  const ALL_ANNOTATIONS: Record<string, string> = {
    case_file_create: '// n8n-http: POST /case-files',
    evidence_get: '// n8n-http: GET /evidences/{evidenceId}',
    notification_request_status: '// n8n-http: GET /notifications/{notificationRequestId}/status',
    id_verification_video_create: '// n8n-http: POST /id-verifications/video',
    id_verification_list: '// n8n-http: GET /users/{userId}/id-verifications',
    id_verification_contract_url: '// n8n-http: GET /id-verifications/{verificationId}/contract-url',
    signature_participant_create: '// n8n-http: POST /signature-requests/{requestId}/participants',
    signature_request_create: '// n8n-http: POST /signature-requests',
    widget_frobnicate: '// n8n-http: POST /widgets/{widget_id}/frobnicate',
  };
  // The same set minus the offender: an un-annotated tool is a non-REST STUB and
  // is omitted from `operations` entirely, so this is the clean 8-operation node.
  const CLEAN_ANNOTATIONS = Object.fromEntries(
    Object.entries(ALL_ANNOTATIONS).filter(([name]) => name !== 'widget_frobnicate'),
  );

  async function buildResourcesSpec(annotations: Record<string, string>) {
    const fixture = await setupFixture({
      mcpName: 'resources',
      toolAnnotations: annotations,
    });
    try {
      return await buildN8nNodeSpec({
        repoRoot: fixture.repoRoot,
        packageDir: fixture.packageDir,
        mcpName: 'resources',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [RESOURCES_STUB],
        inspectorTimeoutMs: 10_000,
      });
    } finally {
      await fixture.cleanup();
    }
  }

  it('AC5: an operation that matches no prefix and is not signature-shaped FAILS the build', async () => {
    // Was a note pushed onto unsupportedNotes, which nothing in src/ ever reads
    // (.adapter-build.json#unsupported_notes has no consumer). profile_get sat
    // under the Signature dropdown for a whole release cycle because of it.
    // FR59 house rule: a check that cannot be acted on is not a check.
    await expect(buildResourcesSpec(ALL_ANNOTATIONS)).rejects.toThrow(BuildN8nNodeSpecError);
    const err = await buildResourcesSpec(ALL_ANNOTATIONS).catch((e: unknown) => e as BuildN8nNodeSpecError);
    expect(err).toBeInstanceOf(BuildN8nNodeSpecError);
    expect((err as BuildN8nNodeSpecError).stage).toBe('tools_list');
    expect((err as BuildN8nNodeSpecError).message).toContain('widget_frobnicate');
    expect((err as BuildN8nNodeSpecError).message).toContain('detectResource');
    // Only the offender is named — the eight legitimate operations are not.
    expect((err as BuildN8nNodeSpecError).message).not.toContain('signature_participant_create');
  }, 30_000);

  it('AC3: the three id_verification_* tools get their own Identity Verification resource', async () => {
    const { spec } = await buildResourcesSpec(CLEAN_ANNOTATIONS);
    expect(spec.operations).toHaveLength(8);
    const idv = spec.resources?.find((r) => r.value === 'idVerification');
    expect(idv, 'idVerification resource missing — the tools fell back to Signature').toBeDefined();
    expect(idv!.displayName).toBe('Identity Verification');
    expect(idv!.operations.map((o) => o.name).sort()).toEqual([
      'id_verification_contract_url',
      'id_verification_list',
      'id_verification_video_create',
    ]);
    // And they are no longer sitting under Signature.
    const signature = spec.resources?.find((r) => r.value === 'signature');
    expect(signature!.operations.map((o) => o.name)).toEqual([
      'signature_participant_create',
      'signature_request_create',
    ]);
    // Story 15.3 (FR60): the dropdown is alphabetical by display name, and
    // resources[0].value is the node's default Resource.
    expect(spec.resources!.map((r) => r.displayName)).toEqual(
      [...spec.resources!.map((r) => r.displayName)].sort((a, b) => a.localeCompare(b, 'en')),
    );
    expect(spec.resources![0]!.value).toBe('caseFile');
  }, 30_000);

  it('AC4: the auto-generated participant id is the participantId, plus a role-specific alias', async () => {
    const { spec } = await buildResourcesSpec(CLEAN_ANNOTATIONS);
    const autoIds = Object.fromEntries(
      (spec.autoIdOutputFields ?? []).map((e) => [e.operation, e.fieldName]),
    );
    // The contract: "the id you generated IS the participantId, and it is the
    // signatoryId if you passed role SIGNATORY or the validatorId if you passed
    // role VALIDATOR". Naming it signatoryId unconditionally was wrong for two
    // of the three roles.
    expect(autoIds['signature_participant_create']).toBe('participantId');
    // id_verification_video_create returns 201 with no body, so the generated
    // UUID is the only handle a workflow ever gets; the contract calls it
    // verificationId (and id_verification_contract_url's path param is that).
    expect(autoIds['id_verification_video_create']).toBe('verificationId');

    const roleRule = (spec.autoIdRoleFields ?? []).find(
      (r) => r.operation === 'signature_participant_create',
    );
    expect(roleRule).toBeDefined();
    expect(roleRule!.param).toBe('role');
    // OBSERVER deliberately maps to nothing: the contract names no field for it.
    expect(roleRule!.byValue).toEqual({ SIGNATORY: 'signatoryId', VALIDATOR: 'validatorId' });
  }, 30_000);
});
