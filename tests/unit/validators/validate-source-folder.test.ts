import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSourceFolder } from '../../../src/validators/validate-source-folder.js';

const EXPECTED_MCP_NAME = 'io.github.g-digital-by-Garrigues/ead-factory';

async function createTempFolder(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'validate-source-folder-'));
}

async function writeFiles(
  folder: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(folder, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}

async function seedHappyFolder(
  folder: string,
  overrides: Record<string, string | null> = {},
): Promise<void> {
  const defaults: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: '@g-digital/mcp-ead-factory',
        version: '1.0.0',
        mcpName: EXPECTED_MCP_NAME,
      },
      null,
      2,
    ),
    LICENSE: 'MIT License — copyright (c) g-digital.\n',
    '.env.example': '# Example env vars\nFOO=bar\n',
    'README.md': '# ead-factory\n\nAn MCP for evidence handling.\n',
  };
  const merged: Record<string, string | null> = { ...defaults, ...overrides };
  const toWrite: Record<string, string> = {};
  for (const [name, content] of Object.entries(merged)) {
    if (content !== null) {
      toWrite[name] = content;
    }
  }
  await writeFiles(folder, toWrite);
}

describe('validateSourceFolder', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await createTempFolder();
  });

  afterEach(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });

  it('happy path: all required elements present → hasMissing=false', async () => {
    await seedHappyFolder(folder);
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    expect(report.hasMissing).toBe(false);
    expect(report.checks.every((c) => c.status === 'present')).toBe(true);
    expect(report.checks).toHaveLength(5);
  });

  it('missing package.json: flagged with remediation; dependent mcpName check also flagged', async () => {
    await seedHappyFolder(folder, { 'package.json': null });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    expect(report.hasMissing).toBe(true);
    const pkg = report.checks.find((c) => c.name === 'package.json');
    expect(pkg?.status).toBe('missing');
    expect(pkg?.remediation).toContain('Create a package.json');
    const marker = report.checks.find((c) => c.name === 'package.json:mcpName');
    expect(marker?.status).toBe('missing');
    expect(marker?.remediation).toContain(EXPECTED_MCP_NAME);
  });

  it('missing mcpName field: remediation includes the expected value derived from reverse_dns_name', async () => {
    await seedHappyFolder(folder, {
      'package.json': JSON.stringify({ name: 'foo', version: '1.0.0' }, null, 2),
    });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const marker = report.checks.find((c) => c.name === 'package.json:mcpName');
    expect(marker?.status).toBe('missing');
    expect(marker?.remediation).toContain(EXPECTED_MCP_NAME);
    expect(marker?.remediation).toContain('reverse_dns_name');
  });

  it('wrong mcpName value: remediation includes both the current and expected values', async () => {
    await seedHappyFolder(folder, {
      'package.json': JSON.stringify(
        { name: 'foo', version: '1.0.0', mcpName: 'wrong.namespace/foo' },
        null,
        2,
      ),
    });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const marker = report.checks.find((c) => c.name === 'package.json:mcpName');
    expect(marker?.status).toBe('missing');
    expect(marker?.remediation).toContain('wrong.namespace/foo');
    expect(marker?.remediation).toContain(EXPECTED_MCP_NAME);
  });

  it('missing LICENSE: flagged with the list of accepted filenames', async () => {
    await seedHappyFolder(folder, { LICENSE: null });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const license = report.checks.find((c) => c.name === 'LICENSE');
    expect(license?.status).toBe('missing');
    expect(license?.remediation).toContain('LICENSE.md');
    expect(report.hasMissing).toBe(true);
  });

  it('accepts LICENSE.md as an alternate LICENSE filename', async () => {
    await seedHappyFolder(folder, { LICENSE: null });
    await writeFiles(folder, { 'LICENSE.md': 'MIT' });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const license = report.checks.find((c) => c.name === 'LICENSE');
    expect(license?.status).toBe('present');
  });

  it('missing .env.example: flagged', async () => {
    await seedHappyFolder(folder, { '.env.example': null });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const env = report.checks.find((c) => c.name === '.env.example');
    expect(env?.status).toBe('missing');
    expect(report.hasMissing).toBe(true);
  });

  it('missing README: flagged', async () => {
    await seedHappyFolder(folder, { 'README.md': null });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const readme = report.checks.find((c) => c.name === 'README');
    expect(readme?.status).toBe('missing');
    expect(report.hasMissing).toBe(true);
  });

  it('fully empty folder: every check is missing', async () => {
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    expect(report.hasMissing).toBe(true);
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((c) => c.status === 'missing')).toBe(true);
    for (const check of report.checks) {
      expect(check.remediation).toBeDefined();
    }
  });

  it('malformed package.json: flagged with parse error in remediation', async () => {
    await seedHappyFolder(folder, { 'package.json': '{ this is not valid json' });
    const report = await validateSourceFolder({
      folder,
      expectedMcpName: EXPECTED_MCP_NAME,
    });
    const pkg = report.checks.find((c) => c.name === 'package.json');
    expect(pkg?.status).toBe('missing');
    expect(pkg?.remediation).toContain('not valid JSON');
  });
});
