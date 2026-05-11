import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReleaseTag } from '../../../src/state/create-release-tag.js';

async function makeTempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-tag-'));
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`);
    }
  };
  run(['init', '--initial-branch=main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test User']);
  run(['config', 'commit.gpgsign', 'false']);
  run(['config', 'tag.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  return dir;
}

function gitTagShow(cwd: string, tagName: string): string {
  const result = spawnSync('git', ['tag', '-l', '--format=%(contents)', tagName], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git tag show failed: ${result.stderr?.toString()}`);
  }
  return result.stdout?.toString() ?? '';
}

function gitListTags(cwd: string): string[] {
  const result = spawnSync('git', ['tag', '-l'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return (result.stdout?.toString() ?? '').split('\n').filter(Boolean);
}

describe('createReleaseTag', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempRepo();
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('creates an annotated v<semver> tag at HEAD with the release-summary message', () => {
    const result = createReleaseTag({
      version: '1.0.0',
      summaryLines: [
        'server.json (npm: @g-digital/mcp-evidence-manager@1.0.0)',
        'smithery.yaml',
        'README.md',
      ],
      cwd: repo,
    });

    expect(result.tagName).toBe('v1.0.0');
    expect(gitListTags(repo)).toContain('v1.0.0');

    const annotation = gitTagShow(repo, 'v1.0.0');
    expect(annotation).toContain('Release v1.0.0');
    expect(annotation).toContain('server.json (npm: @g-digital/mcp-evidence-manager@1.0.0)');
    expect(annotation).toContain('smithery.yaml');
    expect(annotation).toContain('README.md');
  });

  it('creates an annotated tag even when summaryLines is empty', () => {
    createReleaseTag({ version: '0.1.0', summaryLines: [], cwd: repo });
    expect(gitListTags(repo)).toContain('v0.1.0');
    const annotation = gitTagShow(repo, 'v0.1.0');
    expect(annotation.trim()).toBe('Release v0.1.0');
  });

  it('throws a remediation-named error when the tag already exists', () => {
    createReleaseTag({ version: '1.0.0', summaryLines: [], cwd: repo });
    expect(() =>
      createReleaseTag({ version: '1.0.0', summaryLines: ['retry'], cwd: repo }),
    ).toThrow(
      /Tag v1\.0\.0 already exists\. Choose a new version or delete the old tag first\./,
    );
  });

  it('does not overwrite the original tag annotation on the duplicate-rejection path', () => {
    createReleaseTag({ version: '1.0.0', summaryLines: ['original line'], cwd: repo });
    try {
      createReleaseTag({ version: '1.0.0', summaryLines: ['overwritten'], cwd: repo });
    } catch {
      // expected
    }
    const annotation = gitTagShow(repo, 'v1.0.0');
    expect(annotation).toContain('original line');
    expect(annotation).not.toContain('overwritten');
  });

  it('throws when version is not valid semver', () => {
    expect(() =>
      createReleaseTag({ version: 'not-a-version', summaryLines: [], cwd: repo }),
    ).toThrow(/valid semver/);
  });

  it('accepts pre-release and build-metadata versions', () => {
    createReleaseTag({ version: '1.0.0-rc.1', summaryLines: [], cwd: repo });
    createReleaseTag({ version: '1.0.0+build.42', summaryLines: [], cwd: repo });
    const tags = gitListTags(repo);
    expect(tags).toContain('v1.0.0-rc.1');
    expect(tags).toContain('v1.0.0+build.42');
  });
});
