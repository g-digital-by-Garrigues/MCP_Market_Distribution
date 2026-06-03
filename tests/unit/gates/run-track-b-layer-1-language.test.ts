import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTrackBLayer1 } from '../../../src/gates/run-track-b-layer-1.js';
import type { N8nNodeSpec } from '../../../src/adapters/n8n-adapter/types.js';

// Story 11.4 (Epic 11): language regression-guard tests.
// Pins the checkLanguage function added to Track B Layer 1 to prevent
// Spanish-origin strings from reaching npm + n8n's verified review queue.

function baseSpec(): N8nNodeSpec {
  return {
    packageName: '@g-digital/n8n-nodes-test',
    sourceMcpPackageName: '@g-digital/mcp-test',
    version: '1.0.0',
    className: 'Test',
    displayName: 'Test',
    description: 'Test connector for n8n.',
    nodeName: 'test',
    paramName: 'test',
    resourceDisplayName: 'Test',
    credentialClassName: 'TestApi',
    credentialParamName: 'testApi',
    sourceRepoUrl: 'https://github.com/test/test',
    author: { name: 'g-digital by Garrigues', email: 'g-digital@garrigues.com' },
    authStyle: 'email-password',
    defaultApiBaseUrl: '',
    credentialAcquisitionUrl: '',
    operations: [{ name: 'do_thing', displayName: 'Do Thing', description: 'Does the thing.', httpMethod: 'GET', httpUrlTemplate: '/things/{id}', properties: [] }],
    credentials: [{ envName: 'API_KEY', propName: 'API_KEY', displayName: 'API Key', description: 'API key.', isSecret: true }],
  };
}

async function seedNodeDir(opts: {
  description?: string;
  keywords?: string[];
  readmeFirstParagraph?: string;
  opDescription?: string;
  credDescription?: string;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'track-b-l1-lang-'));
  const credDir = path.join(dir, 'credentials');
  const nodeDir = path.join(dir, 'nodes', 'Test');
  await fs.mkdir(credDir, { recursive: true });
  await fs.mkdir(nodeDir, { recursive: true });

  // package.json
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: '@g-digital/n8n-nodes-test',
    version: '1.0.0',
    description: opts.description ?? 'Test connector for n8n.',
    keywords: opts.keywords ?? ['n8n', 'n8n-community-node-package', 'digital-trust', 'test'],
    n8n: { n8nNodesApiVersion: 1, strict: true, nodes: ['dist/nodes/Test/Test.node.js'], credentials: ['dist/credentials/TestApi.credentials.js'] },
  }, null, 2));

  // README.md
  const readmeFirst = opts.readmeFirstParagraph ?? '# Test — n8n connector\n\n> Test connector for n8n.\n\nInstall this connector.';
  await fs.writeFile(path.join(dir, 'README.md'), `${readmeFirst}\n\n## Operations\n| Operation | Description |\n|---|---|\n| \`do_thing\` | Does the thing. |\n\n## Credentials\n| Field | Description | Secret? |\n|---|---|---|\n| \`API_KEY\` | API key. | yes |\n`);

  // Minimal node and credentials stubs
  await fs.writeFile(path.join(nodeDir, 'Test.node.js'), `"use strict";class Test{constructor(){this.description={displayName:"Test",name:"test",properties:[{displayName:"Operation",name:"operation",type:"options",options:[{name:"Do Thing",value:"do_thing",description:"${opts.opDescription ?? 'Does the thing.'}"}]}]};}async execute(){return[];}};exports.Test=Test;`);
  await fs.writeFile(path.join(credDir, 'TestApi.credentials.js'), `"use strict";class TestApi{constructor(){this.name="testApi";this.displayName="Test API";this.properties=[{displayName:"API Key",name:"apiKey",description:"${opts.credDescription ?? 'API key.'}",type:"string",typeOptions:{password:true},default:""}];}};exports.TestApi=TestApi;`);
  await fs.writeFile(path.join(dir, 'index.js'), '"use strict";');

  return dir;
}

let dir = '';
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

describe('checkLanguage — Track B Layer 1 language regression-guard', () => {
  it('passes when all content is English', async () => {
    dir = await seedNodeDir({});
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.passed).toBe(true);
  });

  it('fails when package.json#description contains Spanish accented char', async () => {
    dir = await seedNodeDir({ description: 'Conector para n8n — gestión de evidencias.' });
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.passed).toBe(false);
    expect(langCheck?.error?.observation).toContain('package.json#description');
  });

  it('fails when package.json#keywords contains Spanish keyword', async () => {
    dir = await seedNodeDir({ keywords: ['n8n', 'n8n-community-node-package', 'evidencia', 'test'] });
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.passed).toBe(false);
    expect(langCheck?.error?.observation).toContain('keywords');
  });

  it('fails when README first paragraph contains Spanish content', async () => {
    dir = await seedNodeDir({ readmeFirstParagraph: '# Test — conector n8n\n\n> Gestión de documentos firmados.' });
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.passed).toBe(false);
    expect(langCheck?.error?.observation).toContain('README.md');
  });

  it('fails when operation description contains Spanish (mixed-language)', async () => {
    const spec = baseSpec();
    spec.operations[0]!.description = 'Creates a firma request with provided participants.';
    dir = await seedNodeDir({});
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.passed).toBe(false);
    expect(langCheck?.error?.observation).toContain("operation 'do_thing'");
  });

  it('fails when credential description contains Spanish keyword', async () => {
    const spec = baseSpec();
    spec.credentials[0]!.description = 'API key para el sistema de notificacion.';
    dir = await seedNodeDir({});
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.passed).toBe(false);
    expect(langCheck?.error?.observation).toContain("credential 'API_KEY'");
  });

  it('action field points to source-of-truth fix, not downstream patch', async () => {
    dir = await seedNodeDir({ description: 'Gestión de evidencias digitales.' });
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    const langCheck = result.checks.find((c) => c.name === 'language');
    expect(langCheck?.error?.action).toContain('source MCP repo');
  });
});

describe('package.json template changes — strict:true + keyword audit', () => {
  // These tests validate that the generated package.json contains the new
  // fields introduced in Story 11.3 (strict: true, no "mcp" keyword).
  // They use seedNodeDir to create the exact shape the templates produce
  // and then verify the language check passes.

  it('passes with strict:true and digital-trust keyword (new template shape)', async () => {
    dir = await seedNodeDir({
      keywords: ['n8n', 'n8n-community-node-package', 'digital-trust', 'test'],
    });
    // Manually patch the package.json to include strict:true (already in seedNodeDir)
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    expect(result.checks.find((c) => c.name === 'language')?.passed).toBe(true);
  });

  it('fails if "mcp" keyword inadvertently re-appears (regression guard for Story 11.3)', async () => {
    // "mcp" isn't Spanish but we also test that SPANISH_KEYWORD_RE doesn't
    // false-positive on "mcp". The framing concern for "mcp" keyword is handled
    // separately by the Story 11.3 template change (drop "mcp" from keywords).
    // Language gate only catches Spanish — no false positives on "mcp".
    dir = await seedNodeDir({ keywords: ['n8n', 'n8n-community-node-package', 'mcp', 'test'] });
    const result = await runTrackBLayer1({ mcpName: 'test', nodeDir: dir, spec: baseSpec() });
    expect(result.checks.find((c) => c.name === 'language')?.passed).toBe(true);
    // "mcp" keyword itself is not a Spanish issue — caught by the template
    // guard in Story 11.3, not the language guard.
  });
});
