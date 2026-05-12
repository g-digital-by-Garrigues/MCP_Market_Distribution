import { z } from 'zod';

// Story 4.8: per-release state ledger persisted to the `releases/state`
// orphan branch (created by Story 3.9's init-state-branch).
//
//   File path: releases/state/<mcp_name>/<version>.json
//
// Each release run reads this file at the start of the workflow to know
// which targets are already at status='succeeded' (those get skipped on
// retry) and writes back at the end of the workflow with the merged
// per-target attempt history.
//
// The schema is intentionally a superset of PublisherOutputSchema's
// per-target fields so the merge is a simple "copy the latest run's
// outputs into the ledger's per-target slot" operation.

const targetAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  at: z.string(), // ISO 8601 UTC
  status: z.enum(['succeeded', 'failed', 'skipped']),
  target_url: z.string().url(),
  duration_ms: z.number().int().nonnegative(),
  pipeline_run_id: z.string().min(1),
  error_message: z.string().optional(),
});

const targetEntrySchema = z.object({
  status: z.enum(['succeeded', 'failed', 'skipped', 'pending']),
  target_url: z.string().url().nullable(),
  version_published: z.string().nullable(),
  last_attempt_at: z.string(),
  attempts: z.array(targetAttemptSchema),
});

export const releaseLedgerSchema = z.object({
  mcp_name: z.string().min(1),
  version: z.string().min(1),
  // overall status of the release across all targets — the final-report
  // job updates this when it knows the aggregate
  status: z.enum(['in_progress', 'complete', 'partial', 'failed']),
  started_at: z.string(),
  updated_at: z.string(),
  // Per-target slots; keyed by canonical target ID from
  // src/schemas/target-ids.ts. Missing keys mean "never attempted".
  targets: z.record(targetEntrySchema),
}).strict();

export type ReleaseLedger = z.infer<typeof releaseLedgerSchema>;
export type ReleaseLedgerTargetEntry = z.infer<typeof targetEntrySchema>;
export type ReleaseLedgerAttempt = z.infer<typeof targetAttemptSchema>;

export function emptyLedger(mcpName: string, version: string, nowIso: string): ReleaseLedger {
  return {
    mcp_name: mcpName,
    version,
    status: 'in_progress',
    started_at: nowIso,
    updated_at: nowIso,
    targets: {},
  };
}
