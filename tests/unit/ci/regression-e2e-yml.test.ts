import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import yaml from 'js-yaml';

/**
 * Two invariants of the regression sweep, both added 2026-09-02 (action A6 of the
 * Epic 17 retrospective).
 *
 * 1. It stays SCHEDULED. This sweep is the only thing that reads the source repos'
 *    .distribution.yaml, so generation-side drift is invisible without it. It was
 *    `pull_request` + `workflow_dispatch` only, and nothing ran between 2026-07-22 and
 *    2026-09-02 — during which `logo_svg_dark_path` took prep/bump/publish down for all
 *    three products, unseen.
 * 2. It stays DRY-RUN. That matters much more now that a cron fires it unattended: this
 *    workflow calls publish.yml three times with `secrets: inherit`, so a `dry_run: false`
 *    slipping in would publish to npm every Monday morning with nobody watching.
 */
const REGRESSION_YML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'regression-e2e.yml',
);

interface RegressionWorkflow {
  on: {
    pull_request: { branches: string[] };
    workflow_dispatch: null;
    schedule: Array<{ cron: string }>;
  };
  jobs: Record<string, { with?: Record<string, unknown> }>;
}

describe('.github/workflows/regression-e2e.yml', () => {
  let parsed: RegressionWorkflow;
  beforeAll(async () => {
    parsed = yaml.load(await fs.readFile(REGRESSION_YML, 'utf8')) as RegressionWorkflow;
  });

  it('runs on a schedule, not only on pull_request and manual dispatch', () => {
    expect(parsed.on.schedule).toBeDefined();
    expect(parsed.on.schedule.length).toBeGreaterThan(0);
    // A cron with a fixed minute and hour: `* * * * *`-style wildcards would hammer the
    // publishers hourly with secrets in scope.
    for (const entry of parsed.on.schedule) {
      expect(entry.cron).toMatch(/^\d+ \d+ /);
    }
  });

  it('keeps every publish.yml call in dry-run — a cron must never publish', () => {
    const callers = Object.values(parsed.jobs).filter(
      (job) => job.with !== undefined && 'dry_run' in job.with,
    );
    // Three per-MCP sweeps today; the assertion is on all of them, whatever the count.
    expect(callers.length).toBeGreaterThanOrEqual(3);
    for (const job of callers) {
      expect(job.with!.dry_run).toBe(true);
    }
  });
});
