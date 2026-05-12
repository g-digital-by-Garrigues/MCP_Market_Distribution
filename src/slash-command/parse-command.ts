import { isValidTargetId, type TargetId } from '../schemas/target-ids.js';

// Story 4.9: pure parser for the PR-comment slash-command grammar.
//
// Canonical forms accepted:
//   /retry-publish
//   /retry-publish?step=<target-id>            # retry just one target
//   /retry-publish?track=<a|b>                 # retry all targets in a track
//   /retry-publish?track=<a|b>&bump=<patch|minor|major>
//
// Returns null on any syntax violation, unknown step ID, or unrecognised
// flag — the dispatcher (Story 4.10) treats null as "post a usage-syntax
// reply, take no action". Keeping the parser strict means there's a
// single visible failure mode for typos rather than partial actions.

export type RetryTrack = 'a' | 'b';
export type RetryBump = 'patch' | 'minor' | 'major';

export interface RetryCommand {
  command: 'retry-publish';
  step: TargetId | null;
  track: RetryTrack | null;
  bump: RetryBump | null;
}

const BUMP_VALUES: ReadonlySet<RetryBump> = new Set(['patch', 'minor', 'major']);
const TRACK_VALUES: ReadonlySet<RetryTrack> = new Set(['a', 'b']);

export function parseCommand(commentBody: string): RetryCommand | null {
  // The comment may have leading/trailing whitespace or be embedded in a
  // longer message. We only match a slash-command at the START of the
  // first non-blank line, so a comment whose body is "thanks!
  // /retry-publish" doesn't accidentally trigger.
  const firstLine = commentBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (firstLine === undefined) return null;

  if (!firstLine.startsWith('/retry-publish')) return null;

  // Must be exactly /retry-publish or /retry-publish?<params>. No trailing
  // garbage on the same line (so "/retry-publish nope" is invalid).
  const rest = firstLine.slice('/retry-publish'.length);
  if (rest === '') {
    return { command: 'retry-publish', step: null, track: null, bump: null };
  }
  if (!rest.startsWith('?')) return null;

  const query = rest.slice(1);
  if (query === '') return null;

  // Parse k=v pairs. Reject unknown keys; reject duplicate keys.
  const seen = new Set<string>();
  const result: RetryCommand = { command: 'retry-publish', step: null, track: null, bump: null };
  for (const pair of query.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) return null;
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === 'step') {
      if (!isValidTargetId(value)) return null;
      result.step = value;
    } else if (key === 'track') {
      if (!TRACK_VALUES.has(value as RetryTrack)) return null;
      result.track = value as RetryTrack;
    } else if (key === 'bump') {
      if (!BUMP_VALUES.has(value as RetryBump)) return null;
      result.bump = value as RetryBump;
    } else {
      // Unknown flag.
      return null;
    }
  }

  // `bump` is only meaningful alongside `track`. Reject `?bump=patch`
  // without `track=` to avoid ambiguity about which targets to bump.
  if (result.bump !== null && result.track === null) return null;
  // `step` and `track` are mutually exclusive — they conflict on the
  // dispatcher side (pick one or the other).
  if (result.step !== null && result.track !== null) return null;

  return result;
}

export function formatUsageMessage(): string {
  return [
    `**Usage:** the supported slash-commands are:`,
    ``,
    `- \`/retry-publish\` — retry every failed target from the most recent run`,
    `- \`/retry-publish?step=<target-id>\` — retry one target (e.g. \`step=cline\`)`,
    `- \`/retry-publish?track=a\` or \`?track=b\` — retry all targets in one track`,
    `- \`/retry-publish?track=a&bump=<patch|minor|major>\` — retry with a version bump`,
    ``,
    `Valid step IDs: \`npm\`, \`docker-hub\`, \`mcp-publisher\`, \`smithery\`, \`docker-mcp-catalog\`, \`cline\`, \`mcpso\`, \`n8n\`, \`make-rom\`.`,
  ].join('\n');
}
