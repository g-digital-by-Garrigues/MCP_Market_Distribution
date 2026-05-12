import { safeStableStringify } from '../utils/stable-stringify.js';
import {
  emptyLedger,
  releaseLedgerSchema,
  type ReleaseLedger,
  type ReleaseLedgerAttempt,
  type ReleaseLedgerTargetEntry,
} from '../schemas/release-ledger.schema.js';
import type { PublisherOutput } from '../schemas/publisher-output.schema.js';
import { TRACK_A_TARGET_IDS, TRACK_B_TARGET_IDS } from '../schemas/target-ids.js';

// Story 4.8: pure functions that drive the orphan-branch state ledger.
// The git read/write side-effects live in CLI shims (read-ledger /
// write-ledger) so this module stays unit-testable without disk or
// network.

const ALL_TARGETS = [...TRACK_A_TARGET_IDS, ...TRACK_B_TARGET_IDS];

export function parseLedger(raw: string): ReleaseLedger {
  return releaseLedgerSchema.parse(JSON.parse(raw));
}

export function serializeLedger(ledger: ReleaseLedger): string {
  // safeStableStringify gives us byte-equality across runs — critical
  // for git diffs to be minimal and easy to review on the orphan branch.
  return safeStableStringify(ledger) + '\n';
}

// Merge a PublisherOutput into the ledger as a new attempt for that
// target. Pure function — never throws on unknown targets (we record
// them, since the ledger is the durable record and the canonical-target
// list may evolve faster than this code).
export function mergePublisherOutput(
  ledger: ReleaseLedger,
  output: PublisherOutput,
  pipelineRunId: string,
  nowIso: string,
): ReleaseLedger {
  if (output.status === 'failed' && output.dry_run) {
    // Dry-run failures don't belong in the durable ledger — they're
    // local validation feedback, not state we should remember.
    return ledger;
  }

  const previous = ledger.targets[output.target];
  const attempt: ReleaseLedgerAttempt = {
    attempt: (previous?.attempts.length ?? 0) + 1,
    at: nowIso,
    status: output.status,
    target_url: output.target_url,
    duration_ms: output.duration_ms,
    pipeline_run_id: pipelineRunId,
    ...(output.error?.message ? { error_message: output.error.message } : {}),
  };

  // Once a target reaches 'succeeded' or 'skipped' we never overwrite
  // that — a subsequent failed re-attempt is recorded as history but
  // the top-level `status` stays at succeeded. This is the idempotency
  // invariant Story 4.8's AC depends on.
  const isTerminalSuccess = previous?.status === 'succeeded' || previous?.status === 'skipped';
  const newStatus = isTerminalSuccess ? previous!.status : output.status;

  const newEntry: ReleaseLedgerTargetEntry = {
    status: newStatus,
    target_url: isTerminalSuccess ? previous!.target_url : output.target_url,
    version_published: isTerminalSuccess
      ? previous!.version_published
      : output.version_published,
    last_attempt_at: nowIso,
    attempts: [...(previous?.attempts ?? []), attempt],
  };

  return {
    ...ledger,
    updated_at: nowIso,
    targets: { ...ledger.targets, [output.target]: newEntry },
  };
}

// Aggregate the per-target slots into the overall release status. Called
// by the write-ledger CLI after all PublisherOutputs are merged.
export function recomputeOverallStatus(ledger: ReleaseLedger): ReleaseLedger['status'] {
  const targets = Object.values(ledger.targets);
  if (targets.length === 0) return 'in_progress';
  const terminal = targets.filter((t) => t.status === 'succeeded' || t.status === 'skipped');
  const failed = targets.filter((t) => t.status === 'failed');
  const pending = targets.filter((t) => t.status === 'pending');
  if (pending.length > 0) return 'in_progress';
  if (failed.length === 0) return 'complete';
  if (terminal.length === 0) return 'failed';
  return 'partial';
}

// Read by the ledger-read CLI to decide which targets to skip on a
// retry. A target is "needs run" if:
//   - it doesn't exist in the ledger yet (first attempt)
//   - or its status is 'failed' (terminal-non-success → retry)
//   - or its status is 'pending' (interrupted run)
// A target is "skip" if status is 'succeeded' or 'skipped'.
export function targetsToRun(
  ledger: ReleaseLedger,
  /** Optional filter — only consider these targets (used when /retry-publish?step=X). */
  filter?: readonly string[],
): readonly string[] {
  const candidates = filter ?? ALL_TARGETS;
  return candidates.filter((id) => {
    const entry = ledger.targets[id];
    if (!entry) return true;
    return entry.status !== 'succeeded' && entry.status !== 'skipped';
  });
}

export { emptyLedger };
