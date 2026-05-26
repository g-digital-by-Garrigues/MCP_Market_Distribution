import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  validateVersionCoherence,
  type VersionCoherenceReport,
} from '../../../src/validators/validate-version-coherence.js';

// A tmp packageDir factory — each test gets a fresh isolated dir we can write
// fixture files into. tests/fixtures/<mcp>/ would be too noisy for the wide
// matrix this validator needs to cover.

async function mkTmp(prefix = 'validate-version-coherence-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(dir: string, name: string, content: unknown): Promise<void> {
  await fs.writeFile(path.join(dir, name), JSON.stringify(content, null, 2), 'utf8');
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

let tmp: string;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('validateVersionCoherence — happy path (all files coherent)', () => {
  beforeEach(async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
  });

  it('returns hasMismatch=false when every present file matches', async () => {
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(false);
    expect(report.mismatchedFiles).toEqual([]);
    expect(report.checks.filter((c) => c.status === 'match')).toHaveLength(2);
  });
});

describe('validateVersionCoherence — single-file mismatches', () => {
  it('detects mismatch in package.json#version', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.1.0' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(true);
    expect(report.mismatchedFiles).toEqual(['package.json']);
    const pkgCheck = report.checks.find((c) => c.file === 'package.json');
    expect(pkgCheck?.status).toBe('mismatch');
    expect(pkgCheck?.found).toBe('1.1.0');
    expect(pkgCheck?.expected).toBe('1.2.3');
  });

  it('detects mismatch in server.json#version (the ead-enterprise-suite v1.1.0 case)', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.1.0' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.0.0' });
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.1.0' });
    expect(report.hasMismatch).toBe(true);
    expect(report.mismatchedFiles).toEqual(['server.json']);
    const srvCheck = report.checks.find((c) => c.file === 'server.json');
    expect(srvCheck?.found).toBe('1.0.0');
    expect(srvCheck?.status).toBe('mismatch');
  });

  it('detects mismatch in smithery.yaml when a version: line is present', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    await writeFile(tmp, 'smithery.yaml', 'version: 1.0.0\nname: mcp-foo\n');
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(true);
    expect(report.mismatchedFiles).toEqual(['smithery.yaml']);
  });

  it('detects mismatch in install-blocks/*.md when a @version pin diverges', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    await writeFile(tmp, 'install-blocks/claude-desktop.md',
      'Run: `npx -y @example/mcp-foo@1.1.0`\n');
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(true);
    expect(report.mismatchedFiles).toContain('install-blocks/claude-desktop.md');
  });
});

describe('validateVersionCoherence — multi-file mismatch (lists all)', () => {
  it('reports every mismatched file when more than one diverges', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.0.0' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.0.0' });
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(true);
    expect(report.mismatchedFiles).toEqual(['package.json', 'server.json']);
    expect(report.checks.filter((c) => c.status === 'mismatch')).toHaveLength(2);
  });

  it('a mix of matches and mismatches is reported per-file', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.0.0' });
    await writeFile(tmp, 'install-blocks/cline.md',
      '```json\n{"args":["-y","@example/mcp-foo@1.2.3"]}\n```\n');
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(true);
    expect(report.mismatchedFiles).toEqual(['server.json']);
    expect(report.checks.find((c) => c.file === 'package.json')?.status).toBe('match');
    expect(report.checks.find((c) => c.file === 'install-blocks/cline.md')?.status).toBe('match');
  });
});

describe('validateVersionCoherence — absent (soft-skip) behavior', () => {
  it('treats a missing package.json as absent, not mismatch', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(false);
    const pkgCheck = report.checks.find((c) => c.file === 'package.json');
    expect(pkgCheck?.status).toBe('absent');
    expect(pkgCheck?.found).toBeNull();
  });

  it('treats a smithery.yaml without a version: line as absent (soft pass)', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    await writeFile(tmp, 'smithery.yaml',
      '# generated by generate-smithery-yaml.ts\nconfigSchema:\n  $schema: https://...\n');
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(false);
    const smCheck = report.checks.find((c) => c.file === 'smithery.yaml');
    expect(smCheck?.status).toBe('absent');
  });

  it('treats install-blocks without @version pins as absent (current v1 default)', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    await writeFile(tmp, 'install-blocks/claude-desktop.md',
      '```json\n{"args":["-y","mcp-foo"]}\n```\n');  // no @version
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(false);
    // No install-block check entry generated when no pin is found
    expect(report.checks.filter((c) => c.file.startsWith('install-blocks/'))).toHaveLength(0);
  });
});

describe('validateVersionCoherence — schema invariants', () => {
  it('result is JSON-serializable', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    const cloned = JSON.parse(JSON.stringify(report)) as VersionCoherenceReport;
    expect(cloned.packageDir).toBe(report.packageDir);
    expect(cloned.hasMismatch).toBe(report.hasMismatch);
  });

  it('every check carries the expected version (no drift across the report)', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    for (const c of report.checks) {
      expect(c.expected).toBe('1.2.3');
    }
  });

  it('multi-pin install block reports each distinct version once', async () => {
    tmp = await mkTmp();
    await writeJson(tmp, 'package.json', { name: 'mcp-foo', version: '1.2.3' });
    await writeJson(tmp, 'server.json', { name: 'io.example/foo', version: '1.2.3' });
    // Two different versions in the same file — both should be flagged (both mismatch).
    await writeFile(tmp, 'install-blocks/multi.md',
      'Old: `@example/mcp-foo@1.0.0`\nNew: `@example/mcp-foo@1.1.0`\n');
    const report = await validateVersionCoherence({ packageDir: tmp, expectedVersion: '1.2.3' });
    expect(report.hasMismatch).toBe(true);
    const ibChecks = report.checks.filter((c) => c.file === 'install-blocks/multi.md');
    expect(ibChecks).toHaveLength(2);
    expect(ibChecks.map((c) => c.found).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});
