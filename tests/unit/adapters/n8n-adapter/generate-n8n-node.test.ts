import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateN8nNode } from '../../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import type { N8nNodeSpec } from '../../../../src/adapters/n8n-adapter/types.js';

/** Split a rendered markdown table row on UNESCAPED pipes, trimming each cell. */
function splitMarkdownRow(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function sampleSpec(): N8nNodeSpec {
  return {
    packageName: '@g-digital/n8n-nodes-multi-tool',
    sourceMcpPackageName: '@g-digital/mcp-multi-tool',
    version: '1.0.0',
    className: 'MultiTool',
    displayName: 'Multi Tool',
    description: 'A test multi-tool MCP node.',
    nodeName: 'multi-tool',
    paramName: 'multiTool',
    resourceDisplayName: 'Multi Tool',
    credentialClassName: 'MultiToolApi',
    credentialParamName: 'multiToolApi',
    sourceRepoUrl: 'https://github.com/test/test-mcp',
    author: { name: 'g-digital by Garrigues', email: 'g-digital@garrigues.com' },
    authStyle: 'email-password',
    defaultApiBaseUrl: '',
    credentialAcquisitionUrl: '',
    operations: [
      {
        name: 'get_widget',
        displayName: 'Get Widget',
        description: 'Fetch a widget by id.',
        httpMethod: 'GET',
        httpUrlTemplate: '/widgets/{widget_id}',
        properties: [
          {
            name: 'widget_id',
            displayName: 'Widget Id',
            type: 'string',
            default: '',
            description: 'Widget identifier.',
            required: true,
            showForOperation: 'get_widget',
          },
        ],
      },
      {
        name: 'list_widgets',
        displayName: 'List Widgets',
        description: 'List widgets.',
        httpMethod: 'GET',
        httpUrlTemplate: '/widgets',
        properties: [
          {
            name: 'page_size',
            displayName: 'Page Size',
            type: 'number',
            default: 25,
            numberConstraints: { minValue: 1, maxValue: 100, numberPrecision: 0 },
            showForOperation: 'list_widgets',
          },
          {
            name: 'sort',
            displayName: 'Sort',
            type: 'options',
            default: 'desc',
            options: [
              { name: 'asc', value: 'asc' },
              { name: 'desc', value: 'desc' },
            ],
            showForOperation: 'list_widgets',
          },
        ],
      },
    ],
    credentials: [
      {
        envName: 'TEST_API_KEY', propName: 'TEST_API_KEY',
        displayName: 'Test Api Key',
        isSecret: true,
        description: 'API key for the test backend.',
      },
      {
        envName: 'TEST_BASE_URL', propName: 'TEST_BASE_URL',
        displayName: 'Test Base Url',
        isSecret: false,
        description: 'Base URL of the test backend.',
      },
    ],
  };
}

describe('generateN8nNode', () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-gen-'));
  });
  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('writes the canonical n8n community-node file tree', async () => {
    const result = await generateN8nNode({ spec: sampleSpec(), outputDir });
    // The list is locale-sorted so uppercase 'README.md' lands between
    // 'package.json' and 'tsconfig.json' (not first as ASCII would have
    // it). Test assertion follows the actual locale-aware ordering.
    // mcp-server-entry.ts removed in Story 12.2 (Epic 12) — REST-direct architecture
    expect(result.filesWritten.sort((a, b) => a.localeCompare(b))).toEqual([
      'credentials/MultiToolApi.credentials.ts',
      'index.ts',
      'nodes/MultiTool/MultiTool.node.json',
      'nodes/MultiTool/MultiTool.node.ts',
      'package.json',
      'README.md',
      'tsconfig.json',
      'tsup.config.ts',
    ]);
    // Every file actually exists on disk.
    for (const rel of result.filesWritten) {
      const stat = await fs.stat(path.join(outputDir, rel));
      expect(stat.isFile()).toBe(true);
    }
  });

  it('copies the source logo into nodes/<Class>/icon.png when iconBundled + sourceLogoAbsPath are set', async () => {
    // Without the icon n8n renders a generic box in the catalogue.
    // The generator must (a) copy the source logo into the conventional
    // location, (b) include it in filesWritten so the release report
    // surfaces it, and (c) the template emits `icon: 'file:icon.png'`
    // on the node description (asserted in the node-class test below).
    const tmpLogo = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-logo-'));
    const logoPath = path.join(tmpLogo, 'logo.png');
    await fs.writeFile(logoPath, 'PNG-stub-bytes');
    try {
      const spec = sampleSpec();
      spec.iconBundled = true;
      const result = await generateN8nNode({ spec, outputDir, sourceLogoAbsPath: logoPath });
      expect(result.filesWritten).toContain('nodes/MultiTool/icon.png');
      const copied = await fs.stat(path.join(outputDir, 'nodes', 'MultiTool', 'icon.png'));
      expect(copied.isFile()).toBe(true);
    } finally {
      await fs.rm(tmpLogo, { recursive: true, force: true });
    }
  });

  it("node.ts emits `icon: 'file:icon.png'` when iconBundled=true (so n8n's catalogue renders the brand)", async () => {
    const spec = sampleSpec();
    spec.iconBundled = true;
    await generateN8nNode({ spec, outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain("icon: 'file:icon.png'");
  });

  it("node.ts OMITS the icon field when iconBundled is unset (no logo shipped by the source MCP)", async () => {
    const spec = sampleSpec();
    // iconBundled left undefined.
    await generateN8nNode({ spec, outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).not.toContain("icon: 'file:icon.png'");
  });

  it("package.json adds copyfiles devDep + build script copies .png assets into dist", async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const pkg = JSON.parse(await fs.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // tsc emits .ts → .js only; the icon PNG needs an explicit copy
    // step so it lands at dist/nodes/<Class>/icon.png where n8n's
    // `file:icon.png` resolver looks for it post-install.
    expect(pkg.scripts.build).toContain('copyfiles');
    expect(pkg.scripts.build).toContain('nodes/**/*.png');
    // n8n review 2026-07: SVG icons must also land in dist.
    expect(pkg.scripts.build).toContain('nodes/**/*.svg');
    expect(pkg.scripts.build).toContain('credentials/**/*.svg');
    expect(pkg.scripts.build).toContain('dist');
    expect(pkg.devDependencies.copyfiles).toBeDefined();
  });

  it("ships icon.svg (not icon.png) and emits file:icon.svg when iconFile is icon.svg (n8n review 2026-07)", async () => {
    const tmpLogo = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-logo-svg-'));
    const logoPath = path.join(tmpLogo, 'logo.svg');
    await fs.writeFile(logoPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    try {
      const spec = sampleSpec();
      spec.iconBundled = true;
      spec.iconFile = 'icon.svg';
      const result = await generateN8nNode({ spec, outputDir, sourceLogoAbsPath: logoPath });
      // Copied to BOTH the node and the credential dir under the svg name.
      expect(result.filesWritten).toContain('nodes/MultiTool/icon.svg');
      expect(result.filesWritten).toContain('credentials/icon.svg');
      expect(result.filesWritten).not.toContain('nodes/MultiTool/icon.png');
      // Templates reference the svg.
      const node = await fs.readFile(path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'), 'utf8');
      const cred = await fs.readFile(path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'), 'utf8');
      expect(node).toContain("icon: 'file:icon.svg'");
      expect(node).not.toContain("icon: 'file:icon.png'");
      expect(cred).toContain("icon = 'file:icon.svg' as const;");
    } finally {
      await fs.rm(tmpLogo, { recursive: true, force: true });
    }
  });

  it('package.json has zero runtime deps (n8n Verified) and no source-MCP devDep (REST-direct, Epic 12)', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const pkg = JSON.parse(await fs.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      n8n: { credentials: string[]; nodes: string[]; strict: boolean };
    };
    expect(pkg.name).toBe('@g-digital/n8n-nodes-multi-tool');
    expect(pkg.version).toBe('1.0.0');
    // n8n Verified requires zero runtime dependencies.
    expect(Object.keys(pkg.dependencies)).toEqual([]);
    // REST-direct: source MCP + SDK are no longer bundled; no devDep for them.
    expect(pkg.devDependencies['@g-digital/mcp-multi-tool']).toBeUndefined();
    expect(pkg.devDependencies['@modelcontextprotocol/sdk']).toBeUndefined();
    // peerDependencies.n8n-workflow must be '*' (n8n verified requirement, Epic 12 Story 12.2)
    expect(pkg.peerDependencies['n8n-workflow']).toBe('*');
    // n8n.strict required by the n8n-nodes-starter scaffold (Story 11.3)
    expect(pkg.n8n.strict).toBe(true);
    expect(pkg.n8n.nodes).toEqual(['dist/nodes/MultiTool/MultiTool.node.js']);
    expect(pkg.n8n.credentials).toEqual(['dist/credentials/MultiToolApi.credentials.js']);
  });

  it('node.ts declares the right description.name + lists every operation in the Operation dropdown', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain('export class MultiTool implements INodeType');
    expect(node).toContain("name: 'multiTool'");
    expect(node).toContain("credentials: [{ name: 'multiToolApi', required: true }]");
    // Operation dropdown contains both tools.
    expect(node).toContain("value: 'get_widget'");
    expect(node).toContain("value: 'list_widgets'");
    // Operation-scoped property defines the right displayOptions show.
    expect(node).toContain("displayOptions: { show: { operation: ['get_widget'] } }");
    expect(node).toContain("displayOptions: { show: { operation: ['list_widgets'] } }");
    // numberConstraints surfaces typeOptions.
    expect(node).toContain('"minValue":1');
    expect(node).toContain('"maxValue":100');
    // OPERATION_PROPERTY_NAMES table is emitted at the bottom.
    expect(node).toContain("'get_widget': ['widget_id']");
    expect(node).toContain("'list_widgets': ['page_size', 'sort']");
  });

  it("node.ts REST-direct: uses fetch() for auth, no process.env, no spawned subprocess (Epic 12 REST-direct)", async () => {
    // REST-direct architecture (ADR 0008): the node calls /session or
    // OKTA_TOKEN_URL directly via fetch(), then calls the REST API.
    // There is no subprocess spawn, no process.env propagation.
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    // Auth via fetch() to /session endpoint (email-password authStyle)
    expect(node).toContain("fetch(`${baseUrl}/session`");
    // No subprocess / MCP spawn
    expect(node).not.toContain('StdioClientTransport');
    expect(node).not.toContain('child_process');
    expect(node).not.toContain('process.env');
    // OPERATION_META table present
    expect(node).toContain('OPERATION_META');
  });

  it('node.ts imports IDataObject from n8n-workflow and uses it for the API response (REST-direct, Epic 12)', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    // IDataObject import still present (REST-direct uses it for out.push)
    expect(node).toMatch(/import\s*\{[\s\S]*?IDataObject[\s\S]*?\}\s*from\s*'n8n-workflow'/);
    // REST-direct casts the fetch response to IDataObject
    expect(node).toContain('as IDataObject');
    expect(node).not.toContain('as Record<string, unknown>');
  });

  it("node.ts JSON.stringify-encodes strings with quotes so they don't break TS", async () => {
    const spec = sampleSpec();
    spec.description = `A "tricky" description's edge case`;
    await generateN8nNode({ spec, outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    // JSON.stringify wraps with double quotes + escapes internal ones.
    expect(node).toContain('"A \\"tricky\\" description\'s edge case"');
  });

  it('node.ts flags usableAsTool:true and keeps codex categories in the .node.json codex file, not inline (Story 5.8 + n8n Creator Portal review)', async () => {
    // Without `usableAsTool: true` n8n's CLI does NOT auto-generate the
    // virtual `<Name>Tool` sibling, so the node is invisible to AI Agent
    // nodes — that flag is the Option A path validated in Story 5.8
    // research (Hugo's feedback was that v1.0.5 was "bastante tonto" for
    // the EAD Factory domain; this flag unlocks the AI-driven flow
    // without a hand-authored sibling .node.ts file).
    //
    // The n8n Creator Portal E2E review rejected the inline
    // `codex: { categories: [...] }` on the node description: when a
    // dedicated `.node.json` codex file ships alongside the node, the
    // inline codex property is a duplicate/conflict. categories must live
    // only in the codex file, so node.ts must NOT carry an inline codex.
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain('usableAsTool: true');
    expect(node).not.toContain('codex:');
    // categories now live exclusively in the codex file.
    const codex = JSON.parse(
      await fs.readFile(path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.json'), 'utf8'),
    ) as { categories: string[] };
    expect(codex.categories).toContain('Utility');
  });

  it('package.json peer-deps n8n-workflow is "*" (n8n Verified requirement per scan-community-package, Epic 12)', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const pkg = JSON.parse(await fs.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.peerDependencies['n8n-workflow']).toBe('*');
    // devDep also bumped so `tsc` sees the `usableAsTool` field on
    // INodeTypeDescription — older typings don't expose it.
    expect(pkg.devDependencies['n8n-workflow']).toBe('^1.79.0');
  });

  it('README.md documents the AI Agent usage path so users know to wire the node to an AI Agent (Story 5.8)', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const readme = await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');
    expect(readme).toContain('AI Agent');
    expect(readme).toContain('usableAsTool');
  });

  it('credentials.ts marks the secret field with typeOptions.password and lists every env var', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const creds = await fs.readFile(
      path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
      'utf8',
    );
    expect(creds).toContain('export class MultiToolApi implements ICredentialType');
    expect(creds).toContain("name = 'multiToolApi'");
    // Secret field carries typeOptions password.
    expect(creds).toMatch(/name: 'TEST_API_KEY'[\s\S]+typeOptions: { password: true }/);
    // Non-secret one does not get typeOptions.
    expect(creds).toContain("name: 'TEST_BASE_URL'");
    const tbu = creds.indexOf("name: 'TEST_BASE_URL'");
    const slice = creds.slice(tbu, tbu + 250);
    expect(slice).not.toContain('typeOptions');
  });

  it('README.md lists every operation and credential field', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const readme = await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');
    expect(readme).toContain('| `get_widget` |');
    expect(readme).toContain('| `list_widgets` |');
    expect(readme).toContain('| `TEST_API_KEY` |');
    expect(readme).toContain('npm install @g-digital/n8n-nodes-multi-tool');
  });

  it('README.md escapes a literal pipe in a table cell so the row keeps exactly two columns (Story 18.4, FR62)', async () => {
    // The emitted descriptions document enum states inline
    // ('COMPLETED|IN_PROCESS|ERROR'). Spliced raw into the 2-column
    // Operations table that becomes a 5-cell row and every markdown
    // renderer drops the surplus — the published connector README has been
    // truncating those sentences. mdCell encodes for the cell; the inverse
    // restores the authored bytes (no truncation, no substitution).
    const base = sampleSpec();
    const spec: N8nNodeSpec = {
      ...base,
      operations: [
        { ...base.operations[0]!, description: 'Returns status (A|B).' },
      ],
      credentials: [
        {
          envName: 'TEST_API_KEY',
          displayName: 'Test API Key',
          propName: 'testApiKey',
          isSecret: true,
          description: 'Key for env A|B.',
        },
      ],
    };
    await generateN8nNode({ spec, outputDir });
    const readme = await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');

    const opRow = readme.split('\n').find((l) => l.startsWith('| `get_widget` |'))!;
    expect(opRow).toBeDefined();
    expect(opRow).toContain('Returns status (A\\|B).');
    // The claim that matters: two cells, not five. A toContain on the
    // escaped string alone passes on a row broken somewhere else.
    expect(splitMarkdownRow(opRow)).toEqual(['`get_widget`', 'Returns status (A\\|B).']);

    const credRow = readme.split('\n').find((l) => l.startsWith('| `TEST_API_KEY` |'))!;
    expect(credRow).toBeDefined();
    // Four cells since Story 18.1 gave the table a Required? column: name,
    // description, required, secret. This fixture declares no isRequired, so
    // the escaped pipe must still land in cell 2 and not shift the flags.
    expect(splitMarkdownRow(credRow)).toEqual(['`TEST_API_KEY`', 'Key for env A\\|B.', 'no', 'yes']);
  });

  it('index.ts re-exports both classes', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const idx = await fs.readFile(path.join(outputDir, 'index.ts'), 'utf8');
    expect(idx).toContain("export { MultiTool } from './nodes/MultiTool/MultiTool.node.js'");
    expect(idx).toContain("export { MultiToolApi } from './credentials/MultiToolApi.credentials.js'");
  });

  it('clean=true wipes leftover files in the output dir before re-rendering', async () => {
    const stale = path.join(outputDir, 'stale.txt');
    await fs.writeFile(stale, 'leftover');
    await generateN8nNode({ spec: sampleSpec(), outputDir, clean: true });
    await expect(fs.stat(stale)).rejects.toThrow();
  });
});

// Story 16.1/16.2 (Epic 16): the service-account (oauth2-client-credentials) style
// adopts n8n's native oAuth2Api instead of fetching a token by hand.
describe('generateN8nNode — oauth2-client-credentials → native oAuth2Api (Epic 16)', () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-gen-oauth-'));
  });
  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  function oauthSpec(): N8nNodeSpec {
    // build-node-spec emits NO env-derived credential props for this style;
    // clientId/clientSecret/accessTokenUrl/scope come from the oAuth2Api base.
    return { ...sampleSpec(), authStyle: 'oauth2-client-credentials', credentials: [], defaultApiBaseUrl: 'https://api.example.com' };
  }

  it('AC1: credential extends oAuth2Api with clientCredentials, keeps baseUrl, drops mcpSvc* and the manual test block', async () => {
    await generateN8nNode({ spec: oauthSpec(), outputDir });
    const cred = await fs.readFile(
      path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
      'utf8',
    );
    expect(cred).toContain("extends = ['oAuth2Api']");
    expect(cred).toContain("name: 'grantType'");
    expect(cred).toContain("default: 'clientCredentials'");
    expect(cred).toMatch(/name: 'authentication'[\s\S]*?default: 'body'/);
    expect(cred).toContain("name: 'baseUrl'");
    // Epic 18 AC5: EAD Factory declares MCP_API_BASE_URL `# isRequired: false`, so
    // baseUrlRequired is unset and the baseUrl property renders exactly as before —
    // no `required:` line, not even a whitespace-only one.
    expect(cred).not.toContain('required: true');
    expect(cred).toMatch(/name: 'baseUrl',\n\s*type: 'string',\n\s*default: 'https:\/\/api\.example\.com',/);
    // No leaked service-config props; no hand-rolled token-endpoint test.
    expect(cred).not.toContain('mcpSvc');
    expect(cred).not.toContain('ICredentialTestRequest');
  });

  it('AC2: node routes REST calls through httpRequestWithAuthentication and has no manual token fetch', async () => {
    await generateN8nNode({ spec: oauthSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain('httpRequestWithAuthentication');
    expect(node).toContain("'multiToolApi'");
    // The manual client_credentials grant and the bearer header are gone.
    expect(node).not.toContain("grant_type: 'client_credentials'");
    expect(node).not.toContain('mcpSvcTokenUrl');
  });
});

describe('generateN8nNode — user-key credential imports (n8n review 2026-07)', () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-gen-session-'));
  });
  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  function sessionSpec(): N8nNodeSpec {
    // gocertius / ead-enterprise-suite after Epic 18: ONE credential field. The
    // credential uses a PROGRAMMATIC test (testAuth in the node) — it renders NO
    // declarative `test: ICredentialTestRequest`.
    return {
      ...sampleSpec(),
      authStyle: 'user-key',
      baseUrlRequired: true,
      credentials: [
        { envName: 'MCP_AUTH_USER_KEY', propName: 'userKey', displayName: 'User Key', isSecret: true, isRequired: true },
      ],
    };
  }

  it('does NOT import ICredentialTestRequest (no declarative test is rendered — testAuth is programmatic)', async () => {
    await generateN8nNode({ spec: sessionSpec(), outputDir });
    const cred = await fs.readFile(
      path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
      'utf8',
    );
    // The n8n scanner flagged this as an unused IMPORT in v1.5.0/v1.6.0 — assert on
    // the import statement itself, not comment mentions (the user-key comment
    // legitimately names the type when explaining why there is no test).
    const importBlock = cred.match(/import \{([\s\S]*?)\} from 'n8n-workflow';/)?.[1] ?? '';
    expect(importBlock).not.toContain('ICredentialTestRequest');
    // And there is genuinely no declarative test that would need it.
    expect(cred).not.toMatch(/test:\s*ICredentialTestRequest/);
    // The programmatic test lives in the node, wired via testedBy.
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain('testAuth');
  });

  it('Epic 18 AC3/AC4: the credential is exactly baseUrl + a required, masked userKey', async () => {
    await generateN8nNode({ spec: sessionSpec(), outputDir });
    const cred = await fs.readFile(
      path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
      'utf8',
    );
    // Exactly two properties, and only one base URL.
    expect(cred.match(/name: '[a-zA-Z][a-zA-Z0-9]*'/g)).toEqual(["name: 'baseUrl'", "name: 'userKey'"]);
    expect(cred).toMatch(/name: 'userKey'[\s\S]*?typeOptions: \{ password: true \},\n\s*required: true,/);
    // AC5: MCP_API_BASE_URL is declared required for these products, so the
    // template-emitted baseUrl property renders required too.
    expect(cred).toMatch(/name: 'baseUrl',\n\s*type: 'string',\n\s*required: true,/);
    // The retired flow leaves no trace in the form.
    expect(cred).not.toContain("name: 'email'");
    expect(cred).not.toContain("name: 'password'");
    expect(cred).not.toContain('mcpSvc');
  });

  it('Epic 18 AC4: an optional credential field renders WITHOUT required:', async () => {
    // Requiredness comes from the emitted contract, never inferred from secrecy.
    const spec: N8nNodeSpec = {
      ...sessionSpec(),
      baseUrlRequired: false,
      credentials: [
        { envName: 'MCP_AUTH_USER_KEY', propName: 'userKey', displayName: 'User Key', isSecret: true, isRequired: false },
      ],
    };
    await generateN8nNode({ spec, outputDir });
    const cred = await fs.readFile(
      path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
      'utf8',
    );
    expect(cred).toContain("name: 'userKey'");
    expect(cred).toContain('typeOptions: { password: true }');
    expect(cred).not.toContain('required: true');
  });

  it('Epic 18 AC6: the user-key node has no email/password read and no POST /session fallthrough', async () => {
    await generateN8nNode({ spec: sessionSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).not.toContain('creds.email');
    expect(node).not.toContain('creds.password');
    expect(node).not.toContain('Auth Email');
    expect(node).not.toContain('fetch(`${baseUrl}/session`');
    // The single-flow guard replaced the two two-flow guards.
    expect(node).toContain('A User Key is required.');
    expect(node).not.toContain('Configure exactly one auth flow');
    // Retained behaviour.
    expect(node).toContain("testedBy: 'testAuth'");
    expect(node).toContain('Base URL is empty.');
    expect(node).toContain('/user-keys/session');
    expect(node).toContain('User Keys are enabled');
    expect(node).toContain('The User Key exchange returned no session token.');
    // 401 re-mint-and-replay.
    expect(node).toMatch(/apiRes\.status === 401[\s\S]*?bearer = await obtainBearer\(\)/);
    // obtainBearer is unconditional now (no vacuous `if (userKey)` wrapper left).
    expect(node).not.toMatch(/const obtainBearer[\s\S]{0,120}if \(userKey\) \{/);
  });

  it('email-password still imports ICredentialTestRequest (it DOES render a declarative test)', async () => {
    // Guards the other direction: the fix must not strip the import where it is used.
    await generateN8nNode({ spec: sampleSpec(), outputDir }); // sampleSpec is email-password
    const cred = await fs.readFile(
      path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
      'utf8',
    );
    const importBlock = cred.match(/import \{([\s\S]*?)\} from 'n8n-workflow';/)?.[1] ?? '';
    expect(importBlock).toContain('ICredentialTestRequest');
    expect(cred).toMatch(/test:\s*ICredentialTestRequest/);
  });
  it('renders resource-scoped operation copy byte-identically to the spec (FR62, Story 18.3)', async () => {
    // The resource+operation two-level dropdown is the ONE surface the deleted
    // LLM refine pass never reached: build-node-spec pushes the SAME operation
    // objects into `resources` that live in the flat `operations` array, and
    // applyRefinement rebuilt `operations` as fresh objects while copying
    // `resources` by spread — so the resource branch kept the authored text by
    // accident. Now that the pass is gone the correctness is intentional, and
    // this pins it. Without this test the suite would cover only the flat
    // branch (the integration fidelity test's fixture has 3 operations, below
    // the 8-operation threshold at which `resources` is computed at all).
    const base = sampleSpec();
    const widgetOps = base.operations;
    const spec: N8nNodeSpec = {
      ...base,
      resources: [
        {
          displayName: 'Widget',
          value: 'widget',
          operations: widgetOps,
        },
        {
          displayName: 'Dossier',
          value: 'dossier',
          operations: [
            {
              name: 'dossier_seal',
              displayName: 'Seal Dossier',
              // Same re-encode canaries as the integration fixture: em dash,
              // backticked field reference, literal double quotes.
              description:
                'Seal the dossier identified by `ID` — irreversible. Do NOT seal until every "INTERNAL" file has been uploaded.',
              httpMethod: 'POST',
              httpUrlTemplate: '/dossiers/{dossier_id}/seal',
              properties: [],
            },
          ],
        },
      ],
    };

    await generateN8nNode({ spec, outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );

    // The resource branch rendered, not the flat one.
    expect(node).toContain("displayName: 'Resource'");
    expect(node).toContain("show: { resource: ['dossier'] }");

    for (const resource of spec.resources!) {
      expect(node).toContain(`{ name: ${JSON.stringify(resource.displayName)}, value: '${resource.value}' }`);
      for (const op of resource.operations) {
        expect(node).toContain(`description: ${JSON.stringify(op.description)}`);
        expect(node).toContain(`name: ${JSON.stringify(op.displayName)}`);
        expect(node).toContain(`action: ${JSON.stringify(op.displayName)}`);
      }
    }
    // And the node class description is the spec's, verbatim.
    expect(node).toContain(`description: ${JSON.stringify(spec.description)}`);
  });

  it('injects the role-specific alias for an auto-generated participant id (Story 18.4, AC4)', async () => {
    // The emitted contract: "the id you generated IS the participantId, and it
    // is the signatoryId if you passed role SIGNATORY or the validatorId if you
    // passed role VALIDATOR". Calling it signatoryId unconditionally was wrong
    // for two of the three roles; OBSERVER gets nothing, because the contract
    // names no field for it.
    const base = sampleSpec();
    const spec: N8nNodeSpec = {
      ...base,
      autoIdOutputFields: [
        { operation: 'signature_participant_create', fieldName: 'participantId' },
        { operation: 'id_verification_video_create', fieldName: 'verificationId' },
      ],
      autoIdRoleFields: [
        {
          operation: 'signature_participant_create',
          param: 'role',
          byValue: { SIGNATORY: 'signatoryId', VALIDATOR: 'validatorId' },
        },
      ],
    };
    await generateN8nNode({ spec, outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain("'signature_participant_create': 'participantId'");
    expect(node).toContain("'id_verification_video_create': 'verificationId'");
    // The role map, and the execute()-time injection that reads it.
    expect(node).toContain(
      `'signature_participant_create': { param: 'role', byValue: {"SIGNATORY":"signatoryId","VALIDATOR":"validatorId"} }`,
    );
    expect(node).toContain('const roleRule = AUTO_ID_ROLE_FIELD[operation];');
    // Own-property lookup: `role` is caller-supplied, so an unguarded index into a
    // plain object literal would resolve 'constructor'/'toString' via Object.prototype.
    expect(node).toContain("const roleKey = String(body[roleRule.param] ?? '');");
    expect(node).toContain('Object.prototype.hasOwnProperty.call(roleRule.byValue, roleKey)');
    // OBSERVER is not a KEY in the map — no invented field. (It is named in the
    // explanatory comment above the map, which is why this targets the literal.)
    expect(node).not.toContain('"OBSERVER"');
    // And the pre-18.4 mis-naming is gone.
    expect(node).not.toContain("'signature_participant_create': 'signatoryId'");
  });

  it('emits NO AUTO_ID_ROLE_FIELD at all for a product with no role-aware operation', async () => {
    // The table and the execute()-time lookup are emitted together or not at all.
    // An always-empty map plus a dead branch is not free: EAD Factory's oauth2
    // render must stay byte-identical across Epic 18, and shipping 17 lines of
    // permanently-inert code into it is exactly the regression this pins.
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).not.toContain('AUTO_ID_ROLE_FIELD');
    expect(node).not.toContain('roleRule');
    // And no blank-line scar where the block used to be: the sibling table runs
    // straight into the next section.
    expect(node).toContain('};\n\n// HTTP metadata per operation');
  });
});
