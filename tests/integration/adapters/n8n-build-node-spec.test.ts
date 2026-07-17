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

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const MULTI_TOOL_STUB = path.join(REPO_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-multi-tool.mjs');

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
    // Default: a realistic email-password MCP plus an MCP-server runtime var that
    // must NOT reach the n8n credential (exercises the allowlist).
    const envVars = opts.envVars ?? [
      { name: 'MCP_AUTH_EMAIL', description: 'Account email for the test backend.', isSecret: false, isRequired: true },
      { name: 'MCP_AUTH_PASSWORD', description: 'Account password for the test backend.', isSecret: true, isRequired: true },
      { name: 'MCP_HTTP_HOST', description: 'MCP server HTTP bind host.', isSecret: false, isRequired: false },
    ];
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
    const annotations: Record<string, string> = {
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

      // Exposing MCP_AUTH_EMAIL makes this a user-facing product → session-login-or-token
      // (a User Key exchanged for a session JWT, or email/password login).
      expect(spec.authStyle).toBe('session-login-or-token');
      // Credentials are the allowlisted auth fields only; the MCP_HTTP_HOST
      // server-runtime var is dropped.
      expect(spec.credentials.map((c) => c.propName).sort()).toEqual(['email', 'password']);
      const pw = spec.credentials.find((c) => c.envName === 'MCP_AUTH_PASSWORD')!;
      expect(pw.isSecret).toBe(true);
      expect(pw.displayName).toBe('Auth Password');
      expect(spec.credentials.find((c) => c.envName === 'MCP_AUTH_EMAIL')!.displayName).toBe('Auth Email');
      expect(spec.credentials.some((c) => c.envName === 'MCP_HTTP_HOST')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('detects generic OAuth2 client_credentials (MCP_SVC_*) and builds the right credential surface', async () => {
    // The generator generalized the hardcoded OKTA_* trio to a provider-agnostic
    // MCP_SVC_* set. detectAuthStyle must recognize MCP_SVC_TOKEN_URL and the
    // credential form must expose the four auth vars — never the introspect URL
    // (inbound bearer validation) or transport config.
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
      expect(spec.credentials.map((c) => c.envName).sort()).toEqual([
        'MCP_SVC_CLIENT_ID', 'MCP_SVC_CLIENT_SECRET', 'MCP_SVC_SCOPE', 'MCP_SVC_TOKEN_URL',
      ]);
      // camelCase prop names the template reads (creds.mcpSvc*).
      expect(spec.credentials.map((c) => c.propName).sort()).toEqual([
        'mcpSvcClientId', 'mcpSvcClientSecret', 'mcpSvcScope', 'mcpSvcTokenUrl',
      ]);
      const secret = spec.credentials.find((c) => c.envName === 'MCP_SVC_CLIENT_SECRET')!;
      expect(secret.isSecret).toBe(true);
      expect(secret.displayName).toBe('Client Secret');
      expect(spec.credentials.find((c) => c.envName === 'MCP_SVC_TOKEN_URL')!.displayName).toBe('OAuth Token URL');
      // Introspect URL is server config (inbound), not a node credential; transport too.
      expect(spec.credentials.some((c) => c.envName === 'MCP_SVC_INTROSPECT_URL')).toBe(false);
      expect(spec.credentials.some((c) => c.envName === 'MCP_HTTP_HOST')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('email + MCP_SVC_* together → session-login-or-token, NOT oauth2 (user-facing wins)', async () => {
    // GoCertius / EAD Enterprise Suite expose BOTH a user email/password surface AND a
    // service-account trio (for their own server-side use). An n8n user signs in as
    // themselves, so the email surface must win. Regression: the old detectAuthStyle
    // keyed on MCP_SVC_TOKEN_URL first and mis-detected these as oauth2, which broke
    // every saved credential (Invalid URL — empty mcpSvcTokenUrl).
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: [
        { name: 'MCP_AUTH_EMAIL', description: 'Account email.', isSecret: false, isRequired: true },
        { name: 'MCP_AUTH_PASSWORD', description: 'Account password.', isSecret: true, isRequired: true },
        { name: 'MCP_SVC_TOKEN_URL', description: 'Service-account token endpoint (server-side).', isSecret: false, isRequired: false },
        { name: 'MCP_SVC_CLIENT_ID', description: 'Service-account client id.', isSecret: false, isRequired: false },
        { name: 'MCP_SVC_CLIENT_SECRET', description: 'Service-account client secret.', isSecret: true, isRequired: false },
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

      expect(spec.authStyle).toBe('session-login-or-token');
      // Surface = email + password. NO mcpSvc* leaks in.
      expect(spec.credentials.map((c) => c.propName).sort()).toEqual(['email', 'password']);
      expect(spec.credentials.some((c) => c.propName.startsWith('mcpSvc'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('exposes MCP_AUTH_USER_KEY as the secret userKey credential (Epic 14)', async () => {
    // The real gocertius / ead-enterprise-suite surface after the E14 propagation:
    // email + password + user key, alongside the server's own service-account trio.
    // The node must offer both sign-in flows and still drop the MCP_SVC_* and
    // OpenID server config. MCP_AUTH_USER_KEY carries no `# isSecret:` guarantee
    // from every generator, so the _KEY$ suffix rule must mark it secret anyway.
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      envVars: [
        { name: 'MCP_AUTH_EMAIL', description: 'Account email.', isSecret: false, isRequired: false },
        { name: 'MCP_AUTH_PASSWORD', description: 'Account password.', isSecret: true, isRequired: false },
        { name: 'MCP_AUTH_USER_KEY', description: 'Long-lived user key, exchanged for a session token.', isRequired: false },
        { name: 'MCP_SVC_TOKEN_URL', description: 'Service-account token endpoint (server-side).', isSecret: false, isRequired: false },
        { name: 'MCP_OPENID_ISSUER', description: 'OpenID issuer (server config).', isSecret: false, isRequired: false },
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

      expect(spec.authStyle).toBe('session-login-or-token');
      expect(spec.credentials.map((c) => c.propName).sort()).toEqual(['email', 'password', 'userKey']);
      const key = spec.credentials.find((c) => c.envName === 'MCP_AUTH_USER_KEY')!;
      expect(key.propName).toBe('userKey');
      expect(key.displayName).toBe('User Key');
      expect(key.isSecret).toBe(true);
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
});
