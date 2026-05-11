import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureSkillBundle,
  SKILL_BUNDLE_GLOB,
} from '../../src/generators/ensure-skill-bundle.js';

interface NpmPackJsonEntry {
  files: Array<{ path: string }>;
}

describe('skill bundle ↔ npm pack --dry-run', () => {
  let fixture: string;

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-bundle-pack-'));
  });

  afterEach(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
  });

  it('npm pack --dry-run includes every .claude/commands/**/*.md file once the bundle glob is in package.json#files', async () => {
    const basePkg = {
      name: '@g-digital/mcp-evidence-manager',
      version: '1.0.0',
      description: 'Test fixture',
      license: 'MIT',
      private: false,
      main: 'index.js',
      files: ['index.js'],
    };
    const { packageJson } = ensureSkillBundle({ packageJson: basePkg });

    await fs.writeFile(
      path.join(fixture, 'package.json'),
      JSON.stringify(packageJson, null, 2),
      'utf8',
    );
    await fs.writeFile(path.join(fixture, 'index.js'), "module.exports = {};\n", 'utf8');
    await fs.mkdir(path.join(fixture, '.claude', 'commands'), { recursive: true });
    await fs.writeFile(
      path.join(fixture, '.claude', 'commands', 'create-internal-evidence.md'),
      '# create-internal-evidence\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(fixture, '.claude', 'commands', 'create-signature-request.md'),
      '# create-signature-request\n',
      'utf8',
    );

    const raw = execSync('npm pack --dry-run --json', {
      cwd: fixture,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const parsed = JSON.parse(raw) as NpmPackJsonEntry[];
    const files = (parsed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, '/'));

    expect(packageJson.files).toContain(SKILL_BUNDLE_GLOB);
    expect(files).toContain('.claude/commands/create-internal-evidence.md');
    expect(files).toContain('.claude/commands/create-signature-request.md');
  }, 30_000);
});
