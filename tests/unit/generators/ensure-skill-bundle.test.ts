import { describe, expect, it } from 'vitest';
import {
  ensureSkillBundle,
  SKILL_BUNDLE_GLOB,
} from '../../../src/generators/ensure-skill-bundle.js';

describe('ensureSkillBundle — pure logic', () => {
  it('adds the skill glob to a package.json that has no files array', () => {
    const result = ensureSkillBundle({
      packageJson: { name: 'foo', version: '1.0.0' },
    });
    expect(result.added).toEqual([SKILL_BUNDLE_GLOB]);
    expect((result.packageJson.files as string[]).includes(SKILL_BUNDLE_GLOB)).toBe(true);
  });

  it('appends to an existing files array without dropping existing entries', () => {
    const result = ensureSkillBundle({
      packageJson: { files: ['dist/', 'README.md'] },
    });
    expect(result.added).toEqual([SKILL_BUNDLE_GLOB]);
    expect(result.packageJson.files).toEqual(['dist/', 'README.md', SKILL_BUNDLE_GLOB]);
  });

  it('is idempotent when the skill glob is already present', () => {
    const pkg = { files: ['dist/', SKILL_BUNDLE_GLOB] };
    const result = ensureSkillBundle({ packageJson: pkg });
    expect(result.added).toEqual([]);
    expect(result.packageJson).toBe(pkg);
  });

  it('adds extraGlobs alongside the skill glob when requested', () => {
    const result = ensureSkillBundle({
      packageJson: { files: ['dist/'] },
      extraGlobs: ['assets/**/*.png'],
    });
    expect(result.added).toEqual([SKILL_BUNDLE_GLOB, 'assets/**/*.png']);
    expect(result.packageJson.files).toEqual([
      'dist/',
      SKILL_BUNDLE_GLOB,
      'assets/**/*.png',
    ]);
  });

  it("doesn't mutate the input package.json when no changes are needed", () => {
    const pkg = { name: 'foo', files: [SKILL_BUNDLE_GLOB] };
    ensureSkillBundle({ packageJson: pkg });
    expect(pkg.files).toEqual([SKILL_BUNDLE_GLOB]);
  });

  it('ignores non-string entries in the existing files array', () => {
    const result = ensureSkillBundle({
      packageJson: { files: ['dist/', 42, null, 'README.md'] },
    });
    expect(result.packageJson.files).toEqual(['dist/', 'README.md', SKILL_BUNDLE_GLOB]);
  });
});
