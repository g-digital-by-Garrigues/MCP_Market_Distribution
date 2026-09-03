import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import yaml from 'js-yaml';

/**
 * Guards the dependabot config added 2026-09-03, after 45 security alerts (2 critical,
 * 17 high) sat unread on the default branch because nothing consumed the alert feed.
 *
 * Two things must stay true:
 *   1. both ecosystems this repo actually has (npm-via-pnpm, GitHub Actions) are
 *      covered — deleting one silently returns us to the previous state;
 *   2. the n8n scanner stays excluded — its version is a gate-policy decision that has
 *      to be re-measured against a known-bad tree, not a reflex bump.
 */
const DEPENDABOT_YML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'dependabot.yml',
);

interface Update {
  'package-ecosystem': string;
  directory: string;
  schedule: { interval: string };
  ignore?: Array<{ 'dependency-name': string }>;
  groups?: Record<string, unknown>;
}

interface DependabotConfig {
  version: number;
  updates: Update[];
}

describe('.github/dependabot.yml', () => {
  let parsed: DependabotConfig;
  beforeAll(async () => {
    parsed = yaml.load(await fs.readFile(DEPENDABOT_YML, 'utf8')) as DependabotConfig;
  });

  it('covers both ecosystems this repo has: npm (pnpm) and github-actions', () => {
    expect(parsed.version).toBe(2);
    const ecosystems = parsed.updates.map((u) => u['package-ecosystem']).sort();
    expect(ecosystems).toEqual(['github-actions', 'npm']);
    for (const u of parsed.updates) expect(u.directory).toBe('/');
  });

  it('runs on a schedule, and groups routine bumps so a Monday is one PR per ecosystem', () => {
    for (const u of parsed.updates) {
      expect(u.schedule.interval).toBe('weekly');
      expect(u.groups, `${u['package-ecosystem']} has no groups`).toBeDefined();
    }
  });

  it('leaves the n8n scanner to a deliberate, re-measured bump — never a reflex one', () => {
    const npm = parsed.updates.find((u) => u['package-ecosystem'] === 'npm')!;
    const ignored = (npm.ignore ?? []).map((i) => i['dependency-name']);
    expect(ignored).toContain('@n8n/scan-community-package');
  });
});
