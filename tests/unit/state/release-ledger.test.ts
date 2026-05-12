import { describe, expect, it } from 'vitest';

import {
  emptyLedger,
  mergePublisherOutput,
  parseLedger,
  recomputeOverallStatus,
  serializeLedger,
  targetsToRun,
} from '../../../src/state/release-ledger.js';
import type { PublisherOutput } from '../../../src/schemas/publisher-output.schema.js';

function out(
  target: string,
  status: PublisherOutput['status'],
  overrides: Partial<PublisherOutput> = {},
): PublisherOutput {
  return {
    target,
    status,
    target_url: `https://example.invalid/${target}`,
    version_published: status === 'failed' ? null : '1.0.0',
    duration_ms: 1000,
    attempts: 1,
    dry_run: false,
    ...overrides,
  };
}

const NOW = '2026-05-12T18:00:00.000Z';

describe('emptyLedger', () => {
  it('returns a valid ledger with no targets, status=in_progress', () => {
    const l = emptyLedger('ead-factory', '1.0.0', NOW);
    expect(l.targets).toEqual({});
    expect(l.status).toBe('in_progress');
    expect(l.started_at).toBe(NOW);
  });
});

describe('mergePublisherOutput', () => {
  it('records a first attempt for a never-seen target', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'run-1', NOW);
    expect(l.targets.npm?.status).toBe('succeeded');
    expect(l.targets.npm?.attempts).toHaveLength(1);
    expect(l.targets.npm?.attempts[0]?.attempt).toBe(1);
    expect(l.targets.npm?.attempts[0]?.pipeline_run_id).toBe('run-1');
  });

  it('appends a new attempt and bumps the attempt counter on retry', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('cline', 'failed', { error: { message: 'rate limit', cause: 'x', action: 'y' } }), 'run-1', NOW);
    l = mergePublisherOutput(l, out('cline', 'succeeded'), 'run-2', '2026-05-12T19:00:00.000Z');
    expect(l.targets.cline?.attempts).toHaveLength(2);
    expect(l.targets.cline?.attempts[1]?.attempt).toBe(2);
    expect(l.targets.cline?.attempts[0]?.status).toBe('failed');
    expect(l.targets.cline?.attempts[1]?.status).toBe('succeeded');
    expect(l.targets.cline?.status).toBe('succeeded');
  });

  it('IDEMPOTENCY INVARIANT: once a target is succeeded, a subsequent failed attempt does NOT downgrade the status', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'run-1', NOW);
    // Simulate a spurious re-run that gets a 500 from npm:
    l = mergePublisherOutput(l, out('npm', 'failed'), 'run-2', '2026-05-12T19:00:00.000Z');
    expect(l.targets.npm?.status).toBe('succeeded');
    expect(l.targets.npm?.attempts).toHaveLength(2);
    expect(l.targets.npm?.attempts[1]?.status).toBe('failed');
  });

  it('drops dry-run failures (do not pollute the durable ledger)', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'failed', { dry_run: true }), 'run-1', NOW);
    expect(l.targets.npm).toBeUndefined();
  });

  it('records succeeded dry-run outputs (engineers want to know a dry-run validated)', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded', { dry_run: true }), 'run-1', NOW);
    expect(l.targets.npm?.status).toBe('succeeded');
  });

  it('captures error message into the attempt history when status=failed', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(
      l,
      out('cline', 'failed', { error: { message: 'rate limit on bot account', cause: 'x', action: 'y' } }),
      'run-1',
      NOW,
    );
    expect(l.targets.cline?.attempts[0]?.error_message).toBe('rate limit on bot account');
  });
});

describe('targetsToRun', () => {
  it('returns ALL targets for a fresh ledger', () => {
    const l = emptyLedger('ead-factory', '1.0.0', NOW);
    const all = targetsToRun(l);
    expect(all).toContain('npm');
    expect(all).toContain('docker-hub');
    expect(all).toContain('cline');
    expect(all.length).toBeGreaterThan(5);
  });

  it('skips succeeded targets', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'run-1', NOW);
    l = mergePublisherOutput(l, out('docker-hub', 'skipped'), 'run-1', NOW);
    const remaining = targetsToRun(l);
    expect(remaining).not.toContain('npm');
    expect(remaining).not.toContain('docker-hub');
    expect(remaining).toContain('cline');
  });

  it('retries failed targets (they ARE in the run list)', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('cline', 'failed'), 'run-1', NOW);
    expect(targetsToRun(l)).toContain('cline');
  });

  it('respects the filter argument (used for /retry-publish?step=X)', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'run-1', NOW);
    expect(targetsToRun(l, ['cline'])).toEqual(['cline']);
    // Even with the filter, an already-succeeded target inside the filter is still skipped.
    expect(targetsToRun(l, ['npm', 'cline'])).toEqual(['cline']);
  });
});

describe('recomputeOverallStatus', () => {
  it('returns in_progress when there are no targets yet', () => {
    expect(recomputeOverallStatus(emptyLedger('e', '1', NOW))).toBe('in_progress');
  });

  it('returns complete when every target is succeeded or skipped', () => {
    let l = emptyLedger('e', '1', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'r', NOW);
    l = mergePublisherOutput(l, out('docker-hub', 'skipped'), 'r', NOW);
    expect(recomputeOverallStatus(l)).toBe('complete');
  });

  it('returns failed when every recorded target is failed', () => {
    let l = emptyLedger('e', '1', NOW);
    l = mergePublisherOutput(l, out('npm', 'failed'), 'r', NOW);
    l = mergePublisherOutput(l, out('cline', 'failed'), 'r', NOW);
    expect(recomputeOverallStatus(l)).toBe('failed');
  });

  it('returns partial when results are mixed', () => {
    let l = emptyLedger('e', '1', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'r', NOW);
    l = mergePublisherOutput(l, out('cline', 'failed'), 'r', NOW);
    expect(recomputeOverallStatus(l)).toBe('partial');
  });
});

describe('parse + serialize round-trip', () => {
  it('serializes deterministically and parses back equal', () => {
    let l = emptyLedger('ead-factory', '1.0.0', NOW);
    l = mergePublisherOutput(l, out('npm', 'succeeded'), 'r1', NOW);
    const serialized = serializeLedger(l);
    expect(serialized.endsWith('\n')).toBe(true);
    const reparsed = parseLedger(serialized);
    expect(reparsed).toEqual(l);

    // Determinism: same input → same bytes.
    const again = serializeLedger(reparsed);
    expect(again).toBe(serialized);
  });
});
