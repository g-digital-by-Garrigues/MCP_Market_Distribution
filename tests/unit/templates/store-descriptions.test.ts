import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import yaml from 'js-yaml';

// Tests for the marketplace submission templates that ship with the pipeline.
// Origin: the 2026-05-26 audit at
// _bmad-output/research/mcp-submission-patterns-audit-2026-05-26.md found
// that 0 of 38 of our marketplace submissions had landed because the rendered
// bodies were off-template (Cline + Docker MCP Catalog reviewers triage by
// adherence to their respective templates).
//
// These tests pin the SHIPPING template files (not synthetic test fixtures)
// to the structure each marketplace expects. If a future template change
// breaks adherence, these tests fail — preventing the audit class of bug
// from recurring.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TPL_DIR = path.join(REPO_ROOT, 'templates', 'store-descriptions');

async function render(file: string, data: Record<string, unknown>): Promise<string> {
  const tpl = await fs.readFile(path.join(TPL_DIR, file), 'utf8');
  return Handlebars.compile(tpl, { noEscape: true })(data);
}

const SAMPLE_DATA = {
  mcp_name: 'sample-mcp',
  version: '1.2.3',
  description: 'Sample MCP — a one-line description.',
  npm_package_name: '@g-digital/mcp-sample',
  docker_image_name: 'gdigital/sample-mcp',
  license: 'MIT',
  repo_url: 'https://github.com/example/sample-mcp',
  logo_url: 'https://unpkg.com/@g-digital/mcp-sample@1.2.3/assets/logo-400x400.png',
  icon_url: 'https://unpkg.com/@g-digital/mcp-sample@1.2.3/assets/logo-400x400.png',
  pipeline_run_id: 'run-1',
  environment_variables: [
    { name: 'MCP_AUTH_EMAIL', description: 'Account email' },
    { name: 'MCP_AUTH_PASSWORD', description: 'Account password' },
  ],
};

describe('cline-issue.hbs — Cline Marketplace official template adherence', () => {
  it('renders the four required ### sections in order', async () => {
    const body = await render('cline-issue.hbs', SAMPLE_DATA);
    const idxRepo = body.indexOf('### GitHub Repository URL');
    const idxLogo = body.indexOf('### Logo Image');
    const idxTest = body.indexOf('### Installation Testing');
    const idxAdditional = body.indexOf('### Additional Information');
    expect(idxRepo).toBeGreaterThanOrEqual(0);
    expect(idxLogo).toBeGreaterThan(idxRepo);
    expect(idxTest).toBeGreaterThan(idxLogo);
    expect(idxAdditional).toBeGreaterThan(idxTest);
  });

  it('ticks BOTH Installation Testing checkboxes (not unticked)', async () => {
    const body = await render('cline-issue.hbs', SAMPLE_DATA);
    expect(body).toContain('- [x] The server installs via the documented `npx` / Docker commands and has been tested end-to-end');
    expect(body).toContain('- [x] The server is stable and in production use');
    // Negative assertion — there must be no unticked Installation Testing boxes.
    // (We allow unrelated `[ ]` in code blocks but the two test checkboxes
    // specifically must be ticked.)
    expect(body).not.toMatch(/- \[ ] The server installs/);
    expect(body).not.toMatch(/- \[ ] The server is stable/);
  });

  it('embeds a cline_mcp_settings.json install block with the npm package name', async () => {
    const body = await render('cline-issue.hbs', SAMPLE_DATA);
    expect(body).toContain('cline_mcp_settings.json');
    expect(body).toContain('"command": "npx"');
    expect(body).toContain('"@g-digital/mcp-sample"');
    expect(body).toContain('"sample-mcp"');
  });

  it('renders each environment variable as a JSON env entry', async () => {
    const body = await render('cline-issue.hbs', SAMPLE_DATA);
    expect(body).toContain('"MCP_AUTH_EMAIL"');
    expect(body).toContain('"MCP_AUTH_PASSWORD"');
  });

  it('credits the maintainer + license at the end', async () => {
    const body = await render('cline-issue.hbs', SAMPLE_DATA);
    expect(body).toContain('MIT');
    expect(body).toMatch(/g-digital by Garrigues/i);
  });
});

describe('docker-mcp-catalog/pr-body.hbs — Docker MCP Registry official template adherence', () => {
  it('renders the three required ## sections in order', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    const idxInfo = body.indexOf('## MCP Server Information');
    const idxReq = body.indexOf('## Basic Requirements');
    const idxChk = body.indexOf('## Submitter Checklist');
    expect(idxInfo).toBeGreaterThanOrEqual(0);
    expect(idxReq).toBeGreaterThan(idxInfo);
    expect(idxChk).toBeGreaterThan(idxReq);
  });

  it('populates Server Name / Repository URL / Brief Description in MCP Server Information', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    expect(body).toContain('**Server Name:** sample-mcp');
    expect(body).toContain('**Repository URL:** https://github.com/example/sample-mcp');
    expect(body).toContain('**Brief Description:** Sample MCP');
  });

  it('ticks all 6 Basic Requirements checkboxes', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    const ticked = body.match(/- \[x] \*\*Open Source|MCP Compliant|Active Development|Docker Artifact|Documentation|Security Contact\*\*/g);
    // Simpler: count distinct ticked items by leading label.
    expect(body).toContain('- [x] **Open Source**');
    expect(body).toContain('- [x] **MCP Compliant**');
    expect(body).toContain('- [x] **Active Development**');
    expect(body).toContain('- [x] **Docker Artifact**');
    expect(body).toContain('- [x] **Documentation**');
    expect(body).toContain('- [x] **Security Contact**');
  });

  it('ticks all 5 Submitter Checklist items including CI validation + Docker build + Google form', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    expect(body).toContain('- [x] This server meets the basic requirements listed above');
    expect(body).toContain('- [x] I understand this will undergo automated and manual review');
    expect(body).toContain('- [x] This server passes our release CI');
    expect(body).toContain('is built (multi-stage) and pushed to Docker Hub with build provenance');
    expect(body).toContain('Test credentials shared via [this form]');
    expect(body).toContain('https://forms.gle/6Lw3nsvu2d6nFg8e6');
  });

  it('references the npm package and Docker Hub image in Additional Details', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    expect(body).toContain('npmjs.com/package/@g-digital/mcp-sample');
    expect(body).toContain('hub.docker.com/r/gdigital/sample-mcp');
  });

  it('declares the license explicitly in Basic Requirements', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    expect(body).toMatch(/MIT license/i);
  });

  it('embeds the pipeline run id as an HTML comment for traceability without polluting reader output', async () => {
    const body = await render('docker-mcp-catalog/pr-body.hbs', SAMPLE_DATA);
    expect(body).toMatch(/<!-- pipeline-run-id: run-1 -->/);
  });
});


// Story 18.4 (FR62): the two machine-read catalog files. Until this story the
// only coverage of tools.json.hbs / server.yaml.hbs was a unit-test STUB
// ('{"tools": []}'), so nothing ever rendered them — and both produced
// unparseable output for all three products in production. These render the
// SHIPPING templates through the helpers the publisher registers privately
// (publish-docker-mcp-catalog.ts), and assert the parse + a byte-identical
// round-trip of every authored string.
describe('docker-mcp-catalog/tools.json.hbs + server.yaml.hbs — machine-valid, byte-identical', () => {
  // Mirrors the private environment in publish-docker-mcp-catalog.ts. Kept a
  // local instance so registering these helpers cannot leak into the default
  // Handlebars used by the rest of the suite.
  const hb = Handlebars.create();
  hb.registerHelper('json', (value: unknown) => new hb.SafeString(JSON.stringify(value)));
  hb.registerHelper('yamlScalar', (value: unknown) => new hb.SafeString(JSON.stringify(String(value ?? ''))));

  async function renderCatalog(file: string, data: Record<string, unknown>): Promise<string> {
    const tpl = await fs.readFile(path.join(TPL_DIR, 'docker-mcp-catalog', file), 'utf8');
    return hb.compile(tpl, { noEscape: true })(data);
  }

  // Every character class the real emitted contract carries, in one payload:
  // a literal double quote, the enum/markdown pipe, a colon-space, an em dash
  // and a hash (a YAML comment introducer after a space).
  const HOSTILE_TOOLS = [
    {
      name: 'evidence_get',
      description: 'Get evidence. Status: (COMPLETED|IN_PROCESS|ERROR) — poll until terminal. # not a comment',
    },
    {
      name: 'notification_certificate_list',
      description: 'List certificates of type "SENT"; anything else: rejected.',
    },
  ];
  const HOSTILE_ENV = [
    {
      name: 'MCP_AUTH_USER_KEY',
      example: 'uk_live_xxx | rotate me',
      description: 'User Key: long-lived, "secret", exchanged for a session token — see the portal. # keep private',
    },
    { name: 'MCP_API_BASE_URL', example: 'https://api.example.com', description: 'Base URL of the REST API.' },
  ];
  const HOSTILE_DESCRIPTION =
    'MCP server for GoCertius: certified evidence, "sealed" dossiers and notices — Digital Trust.';
  const CATALOG_DATA = {
    ...SAMPLE_DATA,
    description: HOSTILE_DESCRIPTION,
    tools: HOSTILE_TOOLS,
    environment_variables: HOSTILE_ENV,
  };

  it('tools.json parses and every tool name + description round-trips byte-identically', async () => {
    const out = await renderCatalog('tools.json.hbs', CATALOG_DATA);
    const parsed = JSON.parse(out) as { tools: Array<{ name: string; description: string }> };
    expect(parsed.tools).toEqual(HOSTILE_TOOLS);
  });

  it('server.yaml parses and the server + env-var descriptions round-trip byte-identically', async () => {
    const out = await renderCatalog('server.yaml.hbs', CATALOG_DATA);
    const doc = yaml.load(out) as {
      name: string;
      description: string;
      config: { env: Array<{ name: string; example: string; description: string }> };
    };
    // yaml.load happily accepts a document whose FIRST mapping is fine and
    // fails later, so assert the values, not merely that the call returned.
    expect(doc.name).toBe('sample-mcp');
    expect(doc.description).toBe(HOSTILE_DESCRIPTION);
    expect(doc.config.env).toEqual(HOSTILE_ENV);
  });

  it('an unencoded interpolation is what the parse gate exists for (the pre-18.4 shape)', async () => {
    // Renders the OLD template shape against the same data: proof the fix is
    // load-bearing and the gate in publish-docker-mcp-catalog.ts is not decorative.
    const legacy = hb.compile(
      '{\n  "tools": [\n{{#each tools}}\n    {\n      "name": "{{name}}",\n      "description": "{{description}}"\n    }{{#unless @last}},{{/unless}}\n{{/each}}\n  ]\n}\n',
      { noEscape: true },
    )(CATALOG_DATA);
    expect(() => JSON.parse(legacy)).toThrow();
    const legacyYaml = hb.compile('description: {{description}}\n', { noEscape: true })(CATALOG_DATA);
    expect(() => yaml.load(legacyYaml)).toThrow();
  });
});
