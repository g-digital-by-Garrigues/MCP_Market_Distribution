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
  envVars?: Array<{ name: string; description: string; isSecret: boolean; isRequired: boolean }>;
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
      const submitWidget = spec.operations.find((o) => o.name === 'submit_widget')!;
      const metadata = submitWidget.properties.find((p) => p.name === 'metadata')!;
      expect(metadata.type).toBe('json');
      expect(unsupportedNotes.some((n) => n.includes("'metadata'"))).toBe(true);

      // Credentials are the allowlisted auth fields only — the MCP_HTTP_HOST
      // server-runtime var is dropped (allowlist, not denylist).
      expect(spec.credentials.map((c) => c.envName).sort()).toEqual(['MCP_AUTH_EMAIL', 'MCP_AUTH_PASSWORD']);
      const pw = spec.credentials.find((c) => c.envName === 'MCP_AUTH_PASSWORD')!;
      expect(pw.isSecret).toBe(true);
      expect(pw.displayName).toBe('Auth Password');
      expect(spec.credentials.find((c) => c.envName === 'MCP_AUTH_EMAIL')!.displayName).toBe('Auth Email');
      expect(spec.credentials.some((c) => c.envName === 'MCP_HTTP_HOST')).toBe(false);
      expect(spec.authStyle).toBe('email-password');
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
