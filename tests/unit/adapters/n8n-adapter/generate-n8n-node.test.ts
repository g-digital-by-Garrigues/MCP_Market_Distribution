import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateN8nNode } from '../../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import type { N8nNodeSpec } from '../../../../src/adapters/n8n-adapter/types.js';

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
    author: 'g-digital by Garrigues',
    operations: [
      {
        name: 'get_widget',
        displayName: 'Get Widget',
        description: 'Fetch a widget by id.',
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
        envName: 'TEST_API_KEY',
        displayName: 'Test Api Key',
        isSecret: true,
        description: 'API key for the test backend.',
      },
      {
        envName: 'TEST_BASE_URL',
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
    expect(result.filesWritten.sort((a, b) => a.localeCompare(b))).toEqual([
      'credentials/MultiToolApi.credentials.ts',
      'index.ts',
      'nodes/MultiTool/MultiTool.node.ts',
      'package.json',
      'README.md',
      'tsconfig.json',
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
    expect(pkg.scripts.build).toContain('dist');
    expect(pkg.devDependencies.copyfiles).toBeDefined();
  });

  it('package.json declares the source MCP as a dependency with matching version + n8n loader hints', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const pkg = JSON.parse(await fs.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
      n8n: { credentials: string[]; nodes: string[] };
    };
    expect(pkg.name).toBe('@g-digital/n8n-nodes-multi-tool');
    expect(pkg.version).toBe('1.0.0');
    expect(pkg.dependencies['@g-digital/mcp-multi-tool']).toBe('1.0.0');
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
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

  it("node.ts inherits process.env before applying credentials so NODE_EXTRA_CA_CERTS reaches the spawned MCP (corp TLS regression)", async () => {
    // Without process.env propagation the spawned source MCP runs with
    // ONLY the credential fields as env, so any HTTPS call from inside
    // the MCP fails on corp TLS-inspected networks with "self-signed
    // certificate in certificate chain". Discovered while testing
    // create_signature_request against EAD Factory in n8n self-hosted
    // behind PaloAlto + GarriguesRootCA inspection.
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    // process.env loop must precede the credentials loop so credentials
    // shadow any host env collisions (this is the contract; without it,
    // a leaky env var would override the user's credential value).
    const envLoopIdx = node.indexOf('for (const [k, v] of Object.entries(process.env))');
    const credLoopIdx = node.indexOf('for (const key of Object.keys(credentials))');
    expect(envLoopIdx).toBeGreaterThan(-1);
    expect(credLoopIdx).toBeGreaterThan(-1);
    expect(envLoopIdx).toBeLessThan(credLoopIdx);
  });

  it('node.ts imports IDataObject from n8n-workflow and casts the MCP response to it (TS2322 regression #26043958622)', async () => {
    // Layer 2 compile gate caught a TS2322 in dry-run #26043958622:
    // `Record<string, unknown>` is not assignable to n8n-workflow's
    // IDataObject. The generator now imports IDataObject and casts the
    // callTool response through `as unknown as IDataObject` so n8n
    // accepts the data into INodeExecutionData.json.
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    // Import added to the n8n-workflow line.
    expect(node).toMatch(/import\s*\{[\s\S]*?IDataObject[\s\S]*?\}\s*from\s*'n8n-workflow'/);
    // Cast lands on the callTool response, NOT the old Record form.
    expect(node).toContain('as unknown as IDataObject');
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

  it('node.ts flags usableAsTool:true + codex.categories so n8n AI Agents auto-discover the node (Story 5.8)', async () => {
    // Without `usableAsTool: true` n8n's CLI does NOT auto-generate the
    // virtual `<Name>Tool` sibling, so the node is invisible to AI Agent
    // nodes. codex.categories surfaces it under the AI panel in the
    // workflow builder. Both are the Option A path validated in Story
    // 5.8 research — Hugo's feedback was that v1.0.5 was "bastante tonto"
    // for the EAD Factory domain; this flag unlocks the AI-driven flow
    // without needing a hand-authored sibling .node.ts file.
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const node = await fs.readFile(
      path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
      'utf8',
    );
    expect(node).toContain('usableAsTool: true');
    expect(node).toContain("categories: ['AI', 'Langchain']");
  });

  it('package.json peer-deps n8n-workflow >=1.79.0 (the version that ships usableAsTool — Story 5.8)', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const pkg = JSON.parse(await fs.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.peerDependencies['n8n-workflow']).toBe('>=1.79.0');
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

  it('index.ts re-exports both classes', async () => {
    await generateN8nNode({ spec: sampleSpec(), outputDir });
    const idx = await fs.readFile(path.join(outputDir, 'index.ts'), 'utf8');
    expect(idx).toContain("export { MultiTool } from './nodes/MultiTool/MultiTool.node'");
    expect(idx).toContain("export { MultiToolApi } from './credentials/MultiToolApi.credentials'");
  });

  it('clean=true wipes leftover files in the output dir before re-rendering', async () => {
    const stale = path.join(outputDir, 'stale.txt');
    await fs.writeFile(stale, 'leftover');
    await generateN8nNode({ spec: sampleSpec(), outputDir, clean: true });
    await expect(fs.stat(stale)).rejects.toThrow();
  });
});
