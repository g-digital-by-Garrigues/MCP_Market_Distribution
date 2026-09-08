import { promises as fs } from 'node:fs';
import path from 'node:path';

// Story 18.7 (Epic 18): the authored release note, and the two surfaces it feeds.
//
// Before this module there was NO release-notes surface at all: `gh release list`
// on 2026-09-07 returned nothing for GoCertius and EAD Enterprise Suite, and EAD
// Factory's newest Release was v1.0.11 (2026-05-21) against npm's 1.3.1. A
// breaking change therefore reached its users only as an npm version number.
//
// A hand-written note cannot live in the published `README.md` either: prep
// assembles that file from the generator-owned `README.template.md` and
// overwrites it wholesale on every run (`prep-mcp.ts`), so anything added by
// hand is destroyed on the next release.
//
// So the note lives in the SOURCE repo at `.github/RELEASE_NOTES.md`, written on
// the bump branch and therefore present at the tag the pipeline clones.
// `.github/` is `distribution:`-owned in each repo's `.artifact-owners.yaml`,
// which is why the file sits there and not at the repo root — that file ends
// `unlisted: forbidden`, so a new root file would be a contract violation.
//
// ONE authored file feeds TWO surfaces:
//   - the whole text, minus the two marker lines, is the GitHub Release body;
//   - the span between the markers is the connector README's
//     "Upgrading from 1.x" section.
// The marker idiom is our own (`README_MARKER_INSTALL` / `README_MARKER_ENV` in
// `src/generators/generate-readme.ts`).
//
// `src/utils/` is the deliberate home: the neutral layer both the adapters and
// the generators already depend on, exactly as Story 18.5 reasoned when it
// hoisted `read-emitted-env-defaults.ts` here.
//
// FR62: this parser NEVER falls back to invented text. Anything it cannot honour
// byte-for-byte is a hard error, surfaced by `src/ci/check-release-notes.ts` in
// the `setup` job — before any publisher runs.

/** Where the authored note lives, relative to the MCP source repo root. */
export const RELEASE_NOTES_REL_PATH = '.github/RELEASE_NOTES.md';

/** Opening marker of the span the n8n connector README renders. */
export const N8N_UPGRADE_START = '<!-- N8N_UPGRADE -->';

/** Closing marker of the span the n8n connector README renders. */
export const N8N_UPGRADE_END = '<!-- /N8N_UPGRADE -->';

/**
 * A release note that exists but cannot be honoured as authored.
 *
 * Deliberately NOT a `BuildN8nNodeSpecError`: that class's `stage` union
 * (`tools_list` | `server_json` | `distribution_config` | `launch`) describes
 * none of these failures, and widening it would ripple into the tests that
 * assert on `stage`.
 */
export class ReleaseNotesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseNotesError';
  }
}

export interface ParsedReleaseNotes {
  /** The whole authored text with the two marker lines removed. GitHub Release body. */
  body: string;
  /**
   * The text between the markers, boundary-trimmed. Rendered as the connector
   * README's "Upgrading from 1.x" section. `undefined` when the note carries no
   * markers at all — a server-only note is legal, the connector then renders
   * no section.
   */
  n8nUpgrade?: string;
  /** First non-blank line, trimmed. Used to detect a stale note at the wrong version. */
  firstLine: string;
}

// A level-1 or level-2 ATX heading inside the span would break the connector
// README's outline: the section is emitted under `## Upgrading from 1.x`, so
// anything shallower than `###` escapes it. `###` and deeper are fine.
const SHALLOW_HEADING_RE = /^ {0,3}#{1,2}(\s|$)/;

function countLines(lines: readonly string[], marker: string): number {
  return lines.filter((l) => l.trim() === marker).length;
}

/**
 * Parse an authored release note. Pure — no fs, no network, no rewriting.
 *
 * Throws `ReleaseNotesError` when the markers are unbalanced or out of order,
 * when the delimited span is blank, or when the span carries an ATX heading of
 * level 1 or 2.
 */
export function parseReleaseNotes(raw: string): ParsedReleaseNotes {
  const lines = raw.split('\n');

  const startCount = countLines(lines, N8N_UPGRADE_START);
  const endCount = countLines(lines, N8N_UPGRADE_END);

  if (startCount > 1 || endCount > 1) {
    throw new ReleaseNotesError(
      `Release note carries ${startCount} '${N8N_UPGRADE_START}' and ${endCount} ` +
        `'${N8N_UPGRADE_END}' marker lines. Exactly one of each (or neither) is allowed.`,
    );
  }

  if (startCount !== endCount) {
    throw new ReleaseNotesError(
      `Release note has an unbalanced marker pair: ` +
        `${startCount} '${N8N_UPGRADE_START}' and ${endCount} '${N8N_UPGRADE_END}'. ` +
        `Both markers must be present, each on its own line.`,
    );
  }

  const firstLine = lines.find((l) => l.trim() !== '')?.trim() ?? '';

  if (startCount === 0) {
    // A server-only note. Legal: the connector simply renders no section.
    return { body: raw, firstLine };
  }

  const startIdx = lines.findIndex((l) => l.trim() === N8N_UPGRADE_START);
  const endIdx = lines.findIndex((l) => l.trim() === N8N_UPGRADE_END);

  if (endIdx < startIdx) {
    throw new ReleaseNotesError(
      `Release note closes the n8n span before it opens it: ` +
        `'${N8N_UPGRADE_END}' is on line ${endIdx + 1}, '${N8N_UPGRADE_START}' on line ${startIdx + 1}.`,
    );
  }

  const spanLines = lines.slice(startIdx + 1, endIdx);
  const n8nUpgrade = spanLines.join('\n').trim();

  if (n8nUpgrade === '') {
    throw new ReleaseNotesError(
      `The '${N8N_UPGRADE_START}' span is blank. Either write the n8n upgrade section ` +
        `or remove both marker lines — an empty span is not a way to say "nothing to add".`,
    );
  }

  const offending = spanLines.find((l) => SHALLOW_HEADING_RE.test(l));
  if (offending !== undefined) {
    throw new ReleaseNotesError(
      `The n8n span carries a level-1/level-2 heading, which would break the connector ` +
        `README's outline (the span is rendered under '## Upgrading from 1.x'). ` +
        `Use '###' or deeper. Offending line: ${offending.trim()}`,
    );
  }

  const body = lines.filter((_, i) => i !== startIdx && i !== endIdx).join('\n');

  return { body, n8nUpgrade, firstLine };
}

/**
 * Read and parse `<packageDir>/.github/RELEASE_NOTES.md`.
 *
 * An ABSENT file resolves `undefined` — it is not an error at read time. That
 * distinction matters: the n8n adapter must keep generating for a product with
 * no note (EAD Factory), while a real publish is failed early and loudly by
 * `src/ci/check-release-notes.ts`. Every read error other than ENOENT is
 * rethrown: an unreadable note is not the same as an absent one.
 */
export async function readReleaseNotes(packageDir: string): Promise<ParsedReleaseNotes | undefined> {
  const file = path.join(packageDir, RELEASE_NOTES_REL_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseReleaseNotes(raw);
}
