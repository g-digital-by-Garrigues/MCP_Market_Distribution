import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import yaml from 'js-yaml';

/**
 * Story 13.10: guards the deliberate choices in the PR-verification workflow.
 *
 * Every assertion here corresponds to a decision recorded in ci.yml's header comment.
 * They exist because the plausible-looking "tidy-up" of each one silently removes the
 * protection: pinning the checkout to main is exactly the defect this workflow was
 * written to fix, a paths filter deadlocks a required check, and copying
 * regression-e2e.yml's permissions block would hand PR-authored code this repo's
 * publishing identity.
 */
const CI_YML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'ci.yml',
);

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  name: string;
  'runs-on': string;
  'timeout-minutes'?: number;
  steps: Step[];
}

interface CiWorkflow {
  name: string;
  on: { pull_request: null; push?: { branches: string[] } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

describe('.github/workflows/ci.yml', () => {
  let raw: string;
  /**
   * `raw` minus comment lines. The distinction matters: ci.yml's header *documents* the
   * traps it avoids ("never pull_request_target"), so a regex over the whole file
   * reports a violation that is really a warning against itself. Assert on what runs.
   */
  let body: string;
  let parsed: CiWorkflow;
  let job: Job;
  let steps: Step[];
  beforeAll(async () => {
    raw = await fs.readFile(CI_YML, 'utf8');
    body = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    parsed = yaml.load(raw) as CiWorkflow;
    const verify = parsed.jobs.verify;
    expect(verify, 'ci.yml must define a `verify` job').toBeDefined();
    job = verify!;
    steps = job.steps;
  });

  it('triggers on pull_request with NO paths filter — a path-filtered required check deadlocks PRs that match no path', () => {
    expect(Object.keys(parsed.on)).toContain('pull_request');
    // `pull_request:` with no value parses to null; any object here would mean someone
    // added paths/paths-ignore/branches filters.
    expect(parsed.on.pull_request).toBeNull();
  });

  it('also runs on push to main, so pipeline code is verified after a merge too', () => {
    expect(parsed.on.push?.branches).toEqual(['main']);
  });

  it('checks out the PR head, NOT main: the checkout step carries no `with` block', () => {
    const checkout = steps.find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout).toBeDefined();
    // publish.yml pins `repository:` + `ref: main` on all 24 of its checkouts, which is
    // why a PR was never verified against its own code. A bare checkout on a
    // pull_request event resolves to the PR's merge ref.
    expect(checkout!.with).toBeUndefined();
  });

  it('grants read-only permissions and references no secrets', () => {
    expect(parsed.permissions).toEqual({ contents: 'read' });
    // `actions: write` makes GitHub reject a pull_request workflow at startup with no
    // log; anything else here would expose credentials to PR-authored code.
    expect(Object.keys(parsed.on)).not.toContain('pull_request_target');
    expect(body).not.toMatch(/secrets\./);
    expect(body).not.toMatch(/pull_request_target/);
  });

  it('sets up pnpm BEFORE setup-node, or setup-node cannot resolve its pnpm cache', () => {
    const usesList = steps.map((s) => s.uses ?? '');
    const pnpmIdx = usesList.findIndex((u) => u.startsWith('pnpm/action-setup@'));
    const nodeIdx = usesList.findIndex((u) => u.startsWith('actions/setup-node@'));
    expect(pnpmIdx).toBeGreaterThanOrEqual(0);
    expect(nodeIdx).toBeGreaterThan(pnpmIdx);
  });

  it('pins pnpm to package.json#packageManager — pnpm 10+ ignores pnpm.neverBuiltDependencies', async () => {
    const pkgRaw = await fs.readFile(path.resolve(path.dirname(CI_YML), '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { packageManager: string };
    const declared = pkg.packageManager.replace('pnpm@', '');
    const setup = steps.find((s) => (s.uses ?? '').startsWith('pnpm/action-setup@'));
    expect(String(setup!.with!.version)).toBe(declared);
  });

  it('runs typecheck, tests and lint as separate named steps', () => {
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('pnpm run typecheck');
    expect(runs).toContain('pnpm run test');
    expect(runs).toContain('pnpm run lint');
    // Separate steps, not one chained command: the failing check must be identifiable
    // from the job's step list alone.
    expect(steps.filter((s) => (s.run ?? '').includes('pnpm run typecheck'))).toHaveLength(1);
    expect(steps.filter((s) => (s.run ?? '').includes('pnpm run lint'))).toHaveLength(1);
  });

  it('installs with --frozen-lockfile so a dependency change must land with its lockfile', () => {
    const install = steps.find((s) => (s.run ?? '').includes('pnpm install'));
    expect(install!.run).toContain('--frozen-lockfile');
  });

  it('fails a run that verified nothing: the test count is asserted, not assumed', () => {
    const guard = steps.find((s) => (s.run ?? '').includes('numTotalTests'));
    expect(guard).toBeDefined();
    // The gate this repo shipped for a year returned `passed: true` from a catch block.
    // A green CI run that executed zero tests is the same failure at a different layer.
    expect(guard!.run).toContain('exit 1');
    const tests = steps.find((s) => (s.run ?? '').includes('pnpm run test'));
    expect(tests!.run).toContain('--reporter=json');
  });

  it('bounds the job so a hung child process cannot burn the default 360 minutes', () => {
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
  });

  it('cancels superseded runs per ref, and never keys concurrency on pull_request.number', () => {
    expect(parsed.concurrency['cancel-in-progress']).toBe(true);
    expect(parsed.concurrency.group).toContain('github.ref');
    // An empty pull_request.number on non-PR events caused real startup_failure runs
    // in this repo (documented in regression-e2e.yml).
    expect(parsed.concurrency.group).not.toContain('pull_request.number');
  });
});
