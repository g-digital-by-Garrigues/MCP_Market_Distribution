import { spawnSync } from 'node:child_process';
import process from 'node:process';

export interface CreateReleaseTagOptions {
  version: string;
  summaryLines: readonly string[];
  cwd?: string;
}

export interface CreateReleaseTagResult {
  tagName: string;
  message: string;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

function buildMessage(tagName: string, summaryLines: readonly string[]): string {
  const header = `Release ${tagName}`;
  if (summaryLines.length === 0) return header;
  return `${header}\n\n${summaryLines.join('\n')}\n`;
}

function tagExists(cwd: string, tagName: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tagName}`], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

export function createReleaseTag(opts: CreateReleaseTagOptions): CreateReleaseTagResult {
  const { version, summaryLines, cwd = process.cwd() } = opts;

  if (!SEMVER_RE.test(version)) {
    throw new Error(
      `version '${version}' is not valid semver (expected MAJOR.MINOR.PATCH, optionally followed by -pre or +build).`,
    );
  }

  const tagName = `v${version}`;
  const message = buildMessage(tagName, summaryLines);

  if (tagExists(cwd, tagName)) {
    throw new Error(
      `Tag ${tagName} already exists. Choose a new version or delete the old tag first.`,
    );
  }

  const create = spawnSync('git', ['tag', '-a', tagName, '--file=-'], {
    cwd,
    input: message,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (create.status !== 0) {
    const stderr = create.stderr?.toString().trim() ?? '';
    throw new Error(
      `git tag -a ${tagName} failed (exit ${create.status ?? 'null'}): ${stderr || 'unknown error'}`,
    );
  }

  return { tagName, message };
}
