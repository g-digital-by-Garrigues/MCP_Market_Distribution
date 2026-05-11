import { describe, expect, it } from 'vitest';
import { determineNextVersion } from '../../../src/generators/determine-next-version.js';

const FROM = '1.2.3';

describe('determineNextVersion — Conventional Commits analysis', () => {
  it('returns patch from a fix: commit', () => {
    const result = determineNextVersion({
      commits: ['fix: handle null in parser'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('patch');
    expect(result.nextVersion).toBe('1.2.4');
    expect(result.source).toBe('conventional-commits');
  });

  it('returns minor from a feat: commit', () => {
    const result = determineNextVersion({
      commits: ['feat: add retry-dispatch slash command'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('minor');
    expect(result.nextVersion).toBe('1.3.0');
    expect(result.source).toBe('conventional-commits');
  });

  it('returns major when a commit body contains BREAKING CHANGE', () => {
    const message =
      'refactor: rewrite publisher contract\n\nBREAKING CHANGE: publisher output schema renamed';
    const result = determineNextVersion({
      commits: [message],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('major');
    expect(result.nextVersion).toBe('2.0.0');
    expect(result.source).toBe('conventional-commits');
  });

  it('returns major when the commit header uses the ! shorthand', () => {
    const result = determineNextVersion({
      commits: ['feat!: drop support for Node 18'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('major');
    expect(result.nextVersion).toBe('2.0.0');
  });

  it('picks the highest bump when commits are mixed', () => {
    const result = determineNextVersion({
      commits: [
        'fix: typo in error message',
        'feat: add new generator',
        'chore: bump deps',
      ],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('minor');
    expect(result.nextVersion).toBe('1.3.0');
  });

  it("returns 'none' (no version change) when no releasable commits are present", () => {
    const result = determineNextVersion({
      commits: ['chore: tidy imports', 'docs: update README', 'test: add edge case'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('none');
    expect(result.nextVersion).toBe(FROM);
    expect(result.source).toBe('no-change');
  });

  it("returns 'none' for an empty commit list", () => {
    const result = determineNextVersion({ commits: [], currentVersion: FROM });
    expect(result.bump).toBe('none');
    expect(result.nextVersion).toBe(FROM);
  });

  it('accepts scoped headers like feat(scope):', () => {
    const result = determineNextVersion({
      commits: ['feat(slash-command): parse author from event payload'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('minor');
  });
});

describe('determineNextVersion — PR label override precedence', () => {
  it('bump:patch label overrides a feat-derived minor', () => {
    const result = determineNextVersion({
      commits: ['feat: new generator'],
      prLabels: ['bump:patch'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('patch');
    expect(result.nextVersion).toBe('1.2.4');
    expect(result.source).toBe('label-override');
    expect(result.appliedLabel).toBe('bump:patch');
    expect(result.detectedBumpFromCommits).toBe('minor');
    expect(result.explanation).toContain("'bump:patch'");
  });

  it('bump:minor label overrides a fix-derived patch', () => {
    const result = determineNextVersion({
      commits: ['fix: edge case'],
      prLabels: ['bump:minor', 'other-unrelated-label'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('minor');
    expect(result.nextVersion).toBe('1.3.0');
    expect(result.source).toBe('label-override');
    expect(result.appliedLabel).toBe('bump:minor');
  });

  it('bump:major label overrides a fix-derived patch', () => {
    const result = determineNextVersion({
      commits: ['fix: tiny typo'],
      prLabels: ['bump:major'],
      currentVersion: FROM,
    });
    expect(result.bump).toBe('major');
    expect(result.nextVersion).toBe('2.0.0');
    expect(result.source).toBe('label-override');
    expect(result.appliedLabel).toBe('bump:major');
  });

  it('when multiple bump labels are present, major > minor > patch', () => {
    const result = determineNextVersion({
      commits: ['chore: nothing releasable'],
      prLabels: ['bump:patch', 'bump:minor', 'bump:major'],
      currentVersion: FROM,
    });
    expect(result.appliedLabel).toBe('bump:major');
    expect(result.bump).toBe('major');
  });

  it('an unrecognized bump:* label is ignored and commits drive the result', () => {
    const result = determineNextVersion({
      commits: ['feat: shiny new thing'],
      prLabels: ['bump:rolling'],
      currentVersion: FROM,
    });
    expect(result.source).toBe('conventional-commits');
    expect(result.bump).toBe('minor');
    expect(result.appliedLabel).toBeUndefined();
  });
});

describe('determineNextVersion — input validation', () => {
  it('throws a descriptive error when currentVersion is not valid semver', () => {
    expect(() =>
      determineNextVersion({ commits: ['feat: x'], currentVersion: 'v1.2.3' }),
    ).toThrow(/valid semver/);
  });
});
