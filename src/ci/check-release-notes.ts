import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  N8N_UPGRADE_END,
  N8N_UPGRADE_START,
  RELEASE_NOTES_REL_PATH,
  ReleaseNotesError,
  parseReleaseNotes,
} from '../utils/release-notes.js';

// Story 18.7 (AC7): the release note is REQUIRED on every real publish, and the
// requirement is enforced in `setup` — before npm, Docker Hub, the registry,
// Smithery or n8n has done anything.
//
// Why fail-closed, and why here:
//   - Epic 15's rule: a gate that cannot verify must fail. An OPTIONAL surface
//     is a surface that stays empty — the evidence is that on 2026-09-07 there
//     were ZERO GitHub Releases on GoCertius and EAD Enterprise Suite, and EAD
//     Factory's newest was v1.0.11 (2026-05-21) against npm's 1.3.1.
//   - `prep-mcp` swallows adapter failures in a non-fatal try/catch, so a
//     ReleaseNotesError during a local prep only prints a warning. Nothing
//     swallows it in `setup`.
//   - Failing in the `github-release` job instead would fail AFTER everything
//     has already been published — unfixable without a version bump.
//
// This is a SEPARATE module from validate-version-coherence.ts on purpose: that
// validator's contract is "absent = soft pass", which is the exact opposite of
// what this one has to do.
//
// It doubles as the body emitter for the `github-release` job (`--emit-body`),
// so the text that reaches the GitHub Release goes through the same parser that
// approved it — no second, drifting implementation of "strip the markers".

export interface ReleaseNotesCheckReport {
  packageDir: string;
  expectedVersion: string;
  /** Path checked, relative to packageDir. */
  notesPath: string;
  present: boolean;
  /** True when the file parsed cleanly (markers balanced, span usable). */
  parsed: boolean;
  /** First non-blank line, or null when absent/unparseable. */
  firstLine: string | null;
  /** True when the first non-blank line names `v<expectedVersion>`. */
  namesVersion: boolean;
  /** True when the note carries an `<!-- N8N_UPGRADE -->` span. */
  hasN8nUpgrade: boolean;
  ok: boolean;
  /** Human-readable reasons `ok` is false. Empty when ok. */
  problems: string[];
}

/**
 * Match `v<version>` on a boundary, never as a substring.
 *
 * `firstLine.includes('v2.0.0')` is true of `# v2.0.0-rc.1` and of `# v2.0.0.1`,
 * so a left-behind release-candidate note would have shipped as the GA release
 * body AND as the connector README's "Upgrading from 1.x" section — the exact
 * stale-note failure this check exists to catch.
 *
 * The trailing class blocks the two ways a longer version extends this one:
 * an extra digit/letter (`v1.2.30` for 1.2.3) and a semver pre-release or build
 * suffix (`v2.0.0-rc.1`, `v2.0.0+build.5`). A trailing `.` is deliberately NOT
 * blocked: `# Product v2.0.0.` is a legitimate title, and `v1.2.3.4` is not a
 * version anyone publishes.
 */
export function firstLineNamesVersion(firstLine: string, expectedVersion: string): boolean {
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![0-9A-Za-z])v${escaped}(?![0-9A-Za-z+-])`).test(firstLine);
}

/** A note that satisfies every rule, ready to paste. Four lines is a legal note. */
export function minimalNote(version: string): string {
  return [
    `# v${version}`,
    '',
    'One line on what changed, for the people who have to decide whether to upgrade.',
    '',
    N8N_UPGRADE_START,
    'Nothing to do in n8n beyond upgrading the community node.',
    N8N_UPGRADE_END,
    '',
  ].join('\n');
}

export async function checkReleaseNotes(
  packageDir: string,
  expectedVersion: string,
): Promise<ReleaseNotesCheckReport> {
  const base: ReleaseNotesCheckReport = {
    packageDir,
    expectedVersion,
    notesPath: RELEASE_NOTES_REL_PATH,
    present: false,
    parsed: false,
    firstLine: null,
    namesVersion: false,
    hasN8nUpgrade: false,
    ok: false,
    problems: [],
  };

  let raw: string;
  try {
    raw = await fs.readFile(path.join(packageDir, RELEASE_NOTES_REL_PATH), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...base,
        problems: [`No release note at ${RELEASE_NOTES_REL_PATH}. Every real publish needs one.`],
      };
    }
    return {
      ...base,
      present: true,
      problems: [`Could not read ${RELEASE_NOTES_REL_PATH}: ${(err as Error).message}`],
    };
  }

  let parsedNotes;
  try {
    parsedNotes = parseReleaseNotes(raw);
  } catch (err) {
    if (err instanceof ReleaseNotesError) {
      return { ...base, present: true, problems: [err.message] };
    }
    throw err;
  }

  // The stale-note failure mode: a 1.9.0 note that rode along to the 2.0.0 tag.
  // Checked against the FIRST non-blank line only — that is the title, and a
  // note that mentions an older version further down (a "since v1.9.0" line) is
  // legitimate.
  const namesVersion = firstLineNamesVersion(parsedNotes.firstLine, expectedVersion);
  const problems: string[] = [];
  if (!namesVersion) {
    problems.push(
      `The note's first line does not name v${expectedVersion}: ${JSON.stringify(parsedNotes.firstLine)}. ` +
        `This is what a stale note left over from the previous release looks like.`,
    );
  }

  // FR59 (Epic 15's rule, re-learned here): a signal a gate computes and then
  // discards is a gate that cannot verify. `hasN8nUpgrade` used to be reported
  // and ignored, so a note with no span passed and the connector README shipped
  // with an EMPTY "Upgrading from 1.x" section on a breaking release — the
  // fail-open Epic 18 exists to close, on the very surface it was built for.
  //
  // The span is required on EVERY real publish, not only on a major bump: the
  // n8n user has no `.env` and no changelog, so "nothing to do beyond upgrading
  // the community node" is information they do not otherwise have. That one
  // sentence is what `minimalNote()` writes, and it is what the workflow's
  // failure summary has always told the operator to write.
  //
  // `parseReleaseNotes` still ACCEPTS a markerless note — a local `/prep-mcp`
  // of a product that has not written one yet must keep working. Parse-legal
  // and publish-legal are deliberately different: only this gate is the
  // publish decision.
  const hasN8nUpgrade = parsedNotes.n8nUpgrade !== undefined;
  if (!hasN8nUpgrade) {
    problems.push(
      `The note carries no ${N8N_UPGRADE_START} … ${N8N_UPGRADE_END} span, so the n8n connector ` +
        `README's "Upgrading from 1.x" section would ship EMPTY. Every real publish needs the span; ` +
        `when there is nothing to do, say so in one line.`,
    );
  }

  return {
    ...base,
    present: true,
    parsed: true,
    firstLine: parsedNotes.firstLine,
    namesVersion,
    hasN8nUpgrade,
    ok: problems.length === 0,
    problems,
  };
}

/**
 * The CLI, as a function of its arguments. Exported so the exit-code contract —
 * fail-closed by default, exit 0 under `--advisory`, and NEVER a body file when
 * the note is unusable — is unit-testable without four subprocess spawns.
 */
export async function runCli(args: readonly string[]): Promise<number> {
  const positionals = args.filter((a) => !a.startsWith('--'));
  const packageDir = positionals[0];
  const expectedVersion = positionals[1];
  const emitIdx = args.indexOf('--emit-body');
  const emitBodyPath = emitIdx >= 0 ? args[emitIdx + 1] : undefined;
  // `--advisory` reports exactly the same way and exits 0. It exists for the ONE
  // situation where failing would be wrong rather than strict: a run against a
  // tag that already exists (a `/retry-publish` of a single failed publisher, or
  // a dry-run against `main`). The note has to ride the tag, so a published tag
  // cannot gain one without re-tagging a published version — which the runbook
  // forbids. Advisory keeps the signal (a `::warning::` and a step-summary
  // block, emitted by the caller from `.ok`) without bricking the retry path.
  const advisory = args.includes('--advisory');

  if (!packageDir || !expectedVersion || (emitIdx >= 0 && !emitBodyPath)) {
    process.stderr.write(
      'Usage: tsx src/ci/check-release-notes.ts <package-dir> <version> [--emit-body <path>] [--advisory]\n',
    );
    return 2;
  }

  const report = await checkReleaseNotes(packageDir, expectedVersion);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  if (!report.ok) {
    process.stderr.write(
      JSON.stringify(
        {
          step: 'check-release-notes',
          cause: report.problems.join(' '),
          action:
            `Write ${RELEASE_NOTES_REL_PATH} in the MCP source repo, on the bump branch, so it ` +
            `rides the v${expectedVersion} tag. Its whole text becomes the GitHub Release body; ` +
            `the span between ${N8N_UPGRADE_START} and ${N8N_UPGRADE_END} becomes the n8n ` +
            `connector README's "Upgrading from 1.x" section. See ` +
            `docs/runbooks/release-checklist.md#writing-the-release-note. Minimal file:\n` +
            minimalNote(expectedVersion),
        },
        null,
        2,
      ) + '\n',
    );
    // In advisory mode nothing is emitted either: FR62 forbids inventing the
    // text, and a Release body assembled from anything but the authored note
    // would be exactly that. The caller sees `ok: false` and says so.
    return advisory ? 0 : 1;
  }

  if (emitBodyPath) {
    // Safe: `ok` implies the file parsed, so re-parsing cannot throw here.
    const raw = await fs.readFile(path.join(packageDir, RELEASE_NOTES_REL_PATH), 'utf8');
    await fs.writeFile(emitBodyPath, parseReleaseNotes(raw).body, 'utf8');
  }

  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
