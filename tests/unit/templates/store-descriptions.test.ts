import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

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
