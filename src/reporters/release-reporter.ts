import type { PublisherOutput } from '../schemas/publisher-output.schema.js';
import { DRY_RUN_STATUS_HEADER } from '../ci/dry-run.js';

// Story 3.5: deterministic release-report markdown generator.
//
// Consumed by:
//   - Story 3.7's final-report job (writes the result to
//     _bmad-output/release-reports/<mcp>-<version>.md AND posts as PR
//     comment via the Story 3.6 upserter).
//   - Story 4.7 extends this with the partial-publish detail block.
//
// Determinism is the key invariant: identical inputs MUST produce
// byte-identical output so fixture-based tests can pin the format and
// catch accidental drift. Order rows alphabetically; never include
// wall-clock timestamps unless explicitly passed via `generated_at`
// (which tests can pin to a fixed Date).

export interface ReleaseReportMetadata {
  /** Pipeline-internal MCP id (kebab-case). Used in the title and the stable marker. */
  readonly mcp_name: string;
  /** Semver (no leading 'v'). */
  readonly version: string;
  /** Correlation id propagated through the run. */
  readonly pipeline_run_id: string;
  /** Direct link to the GH Actions workflow run that produced this report. */
  readonly workflow_run_url: string;
}

export interface GenerateReleaseReportInput {
  readonly outputs: readonly PublisherOutput[];
  readonly metadata: ReleaseReportMetadata;
}

export type ReleaseStatus = 'complete' | 'partial' | 'failed' | 'dry-run';

export function classifyReleaseStatus(outputs: readonly PublisherOutput[]): ReleaseStatus {
  if (outputs.length === 0) return 'failed';
  // If EVERY output is a dry-run, render as DRY RUN — that's the marker
  // the runbook tells engineers to look for.
  if (outputs.every((o) => o.dry_run)) return 'dry-run';
  const failed = outputs.filter((o) => o.status === 'failed').length;
  const succeededOrSkipped = outputs.filter(
    (o) => o.status === 'succeeded' || o.status === 'skipped',
  ).length;
  if (failed === 0) return 'complete';
  if (succeededOrSkipped === 0) return 'failed';
  return 'partial';
}

function statusBadge(row: PublisherOutput): string {
  switch (row.status) {
    case 'succeeded':
      return '✅ succeeded';
    case 'skipped':
      // `skipped` overloads two distinct end states in the schema:
      //   1. Intentional skip — publisher never ran (smithery in v1.0,
      //      or any target with version_published === null). Render as
      //      "⏭ skipped" so the reader sees this target was deliberately
      //      not exercised this release.
      //   2. Idempotency hit — the target ALREADY had the requested
      //      version when the publisher started, so it had nothing new
      //      to do. version_published is set to the live version.
      //      Render as "♻️ already-published" so engineers don't
      //      mistakenly think the target was missed; the desired end
      //      state (version live on the target) was reached.
      // mcp-publisher in particular trips the idempotency path whenever
      // a retry runs after the first attempt put the version in the
      // registry — caught while inspecting ead-factory v1.0.5 + v1.0.6
      // reports where mcp-publisher kept appearing as "skipped" despite
      // the registry showing isLatest=true for both releases.
      return row.version_published ? '♻️ already-published' : '⏭ skipped';
    case 'failed':
      return '❌ failed';
  }
}

function headerStatusLine(
  status: ReleaseStatus,
  outputs: readonly PublisherOutput[],
): string {
  switch (status) {
    case 'complete':
      return '**Status:** ✅ Complete';
    case 'failed':
      return '**Status:** ❌ Failed';
    case 'partial': {
      const ok = outputs.filter((o) => o.status === 'succeeded' || o.status === 'skipped').length;
      return `**Status:** ⚠️ Partial (${ok} of ${outputs.length} targets succeeded)`;
    }
    case 'dry-run':
      return DRY_RUN_STATUS_HEADER;
  }
}

/** Stable marker used by the PR-comment upserter (Story 3.6) to update in place. */
export function releaseReportMarker(mcpName: string, version: string): string {
  return `<!-- release-report:${mcpName}-v${version} -->`;
}

export function generateReleaseReport(input: GenerateReleaseReportInput): string {
  const { outputs, metadata } = input;
  const status = classifyReleaseStatus(outputs);

  // Alphabetical-by-target row order, deterministic regardless of the
  // order publishers happened to finish. Use a copy so we don't mutate
  // the caller's array.
  const rows = [...outputs].sort((a, b) => a.target.localeCompare(b.target));

  const lines: string[] = [];

  lines.push(releaseReportMarker(metadata.mcp_name, metadata.version));
  lines.push('');
  lines.push(`# Release ${metadata.mcp_name}-v${metadata.version}`);
  lines.push('');
  lines.push(headerStatusLine(status, outputs));
  lines.push('');
  lines.push(`[Workflow run](${metadata.workflow_run_url})`);
  lines.push('');
  lines.push('| target | status | target_url | duration_ms |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(
      `| ${row.target} | ${statusBadge(row)} | ${row.target_url} | ${row.duration_ms} |`,
    );
  }
  lines.push('');

  // Story 4.7: failure detail block. We render this for any partial OR
  // fully-failed release so engineers see the cause + remediation inline
  // without clicking out to the workflow logs. Each failed row gets a
  // 4-line subsection matching the AC: Error / Cause / Retry / Manual.
  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const row of failed) {
      lines.push(`### ${row.target}`);
      lines.push('');
      lines.push(`- **Error:** ${row.error?.message ?? '(no error message)'}`);
      lines.push(`- **Cause:** ${row.error?.cause ?? '(no cause attached)'}`);
      lines.push(`- **Retry:** \`/retry-publish?step=${row.target}\``);
      lines.push(`- **Manual:** ${row.error?.action ?? '(no manual remediation attached)'}`);
      lines.push('');
    }
  }

  lines.push('## Notes');
  lines.push('');
  lines.push(
    `_Generated by g-digital MCP Distribution System • run [${metadata.pipeline_run_id}](${metadata.workflow_run_url})_`,
  );
  // Trailing newline — every text file in the repo ends with one (NFR-R1).
  return lines.join('\n') + '\n';
}
