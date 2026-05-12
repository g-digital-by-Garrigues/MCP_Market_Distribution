import process from 'node:process';

// Shared contract for the workflow-wide dry-run flag (Story 2.9 / FR40).
//
// `dry_run` is surfaced two ways into composite actions:
//   1. As an explicit input (`dry_run: 'true' | 'false'`) on every Track A / B
//      publisher action — that's how we test publishers in isolation.
//   2. As `DRY_RUN` env var set by publish.yml's `setup` job — so any helper
//      script (idempotency check, state ledger writer, PR commenter) can read
//      it without rewiring inputs.
//
// Every state-changing call site must consult `dryRunEnabled()` before doing
// anything externally visible: `npm publish`, `docker push`, `mcp-publisher
// publish`, `gh pr comment`, `git push` of release-state ledger, etc. The
// gate jobs (Layers 1/2/3) DO run normally in dry-run mode — the point of a
// dry-run is to confirm "would this release succeed", which requires the
// gates to actually execute.

export const DRY_RUN_STATUS_HEADER = '**Status: DRY RUN**';

export interface DryRunSource {
  /** Composite-action input — typically `'true' | 'false' | ''`. */
  readonly input?: string | undefined;
  /** Env var fallback — read by helper scripts not invoked through an action. */
  readonly env?: string | undefined;
}

// Parsing rule: any of the strings GitHub Actions can produce for a boolean
// input ("true" / "True" / "TRUE") count as on; anything else (empty,
// "false", "0", undefined) counts as off. We never throw — a malformed input
// degrades to "off" so a typo can't silently turn off the dry-run protection
// (other way around would be the dangerous failure mode).
export function parseDryRunFlag(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function dryRunEnabled(source: DryRunSource = {}): boolean {
  // Explicit input takes precedence over the env fallback so a composite
  // action can override the workflow-wide setting if it needs to (we don't
  // currently use that, but it keeps the contract honest).
  if (source.input !== undefined && source.input !== '') {
    return parseDryRunFlag(source.input);
  }
  if (source.env !== undefined) {
    return parseDryRunFlag(source.env);
  }
  return false;
}

/** Read the workflow-wide dry-run flag from the ambient process env. */
export function dryRunFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseDryRunFlag(env.DRY_RUN);
}

export interface DryRunGuardOptions {
  /** Human-readable name of the call site, used in the log event payload. */
  readonly callSite: string;
  /** Source of the flag — defaults to the ambient env. */
  readonly source?: DryRunSource;
  /** Optional structured logger; defaults to a no-op so unit tests stay quiet. */
  readonly onSkip?: (event: { call_site: string; reason: 'dry_run' }) => void;
}

// Wrap any state-changing function in a guard so call sites don't repeat the
// `if (dryRun) return placeholder` boilerplate. If dry-run is on, we call
// `onSkip` (typically the structured logger) and return the placeholder
// without invoking `fn`.
export async function runUnlessDryRun<T>(
  fn: () => Promise<T>,
  placeholder: T,
  options: DryRunGuardOptions,
): Promise<T> {
  if (dryRunEnabled(options.source ?? { env: process.env.DRY_RUN })) {
    options.onSkip?.({ call_site: options.callSite, reason: 'dry_run' });
    return placeholder;
  }
  return fn();
}
