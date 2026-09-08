import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Story 18.7 (AC3, AC9): the runbook is executable prose. Every command it
// prints has to be one the CLI accepts, and no step may depend on a later one.
//
// Modelled on the 18.6 doc-lint (tests/unit/docs/no-retired-auth-in-docs.test.ts):
// a handful of EXACT tokens, never a loose regex over prose. A doc-lint that
// fails on a rewording gets deleted; a doc-lint that pins the two things that
// actually broke a release survives.
//
// What broke, and is pinned here:
//   - the checklist printed `/prep-mcp <mcp-name> <new-version>`; `main()` reads
//     args[0] as the MCP name and then only includes()-checks the two flags, so
//     the second positional was silently discarded;
//   - it printed the rebuild of the MCP's dist/ AFTER prep, though prep launches
//     the built server to fetch tools/list — a stale dist/ is how a 39-operation
//     connector gets mirrored against an 86-tool inventory;
//   - it pointed at `pending-to-publish/<mcp>/_n8n-adapter/`, a path prep builds
//     in a sibling temp dir and rm -rf's in a finally.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECKLIST = path.join(repoRoot, 'docs/runbooks/release-checklist.md');

/** Index of the single heading containing `token`. Fails loudly if 0 or >1 match. */
function headingIndex(md: string, token: string): number {
  const matches = md.split('\n').filter((l) => l.startsWith('#') && l.includes(token));
  expect(matches, `expected exactly one heading containing ${JSON.stringify(token)}`).toHaveLength(1);
  return md.indexOf(matches[0]!);
}

describe('docs/runbooks/release-checklist.md (Story 18.7)', () => {
  let md: string;

  beforeAll(async () => {
    md = await fs.readFile(CHECKLIST, 'utf8');
  });

  it('never prints /prep-mcp with a positional version', () => {
    // Two forms count as "printed": a bare command line inside a fence, and a
    // backticked inline invocation. Prose that merely mentions `/prep-mcp` is
    // not an invocation and must not be flagged — a doc-lint with false
    // positives gets skipped, and a skipped lint enforces nothing.
    const invocations = [
      ...md.split('\n').filter((l) => l.trimStart().startsWith('/prep-mcp')).map((l) => l.trim()),
      ...(md.match(/`\/prep-mcp[^`]*`/g) ?? []).map((m) => m.slice(1, -1)),
    ];
    expect(invocations.length, 'the checklist must still show how to run prep').toBeGreaterThan(1);

    const offences = invocations.filter((inv) => {
      const args = inv.split(/\s+/).slice(1).filter(Boolean);
      return args.filter((a) => !a.startsWith('--')).length > 1;
    });

    expect(
      offences,
      'prep-mcp takes ONE positional (the MCP name) plus --skip-commit / --skip-tag. ' +
        'main() reads args[0] as the name and then only includes()-checks the flags, ' +
        'so a second positional is silently discarded.\n' +
        offences.join('\n'),
    ).toEqual([]);
    expect(md).not.toContain('/prep-mcp <mcp-name> <new-version>');
  });

  it('tells the operator to pass --skip-tag', () => {
    expect(md).toContain('--skip-tag');
  });

  it('does not point at the _n8n-adapter path, which prep deletes', () => {
    expect(md).not.toContain('_n8n-adapter');
  });

  it('names the surviving adapter output, n8n-node/', () => {
    expect(md).toContain('pending-to-publish/<mcp>/n8n-node/');
  });

  it('rebuilds dist/ BEFORE running prep', () => {
    expect(headingIndex(md, "Rebuild the MCP's `dist/`")).toBeLessThan(
      headingIndex(md, 'Run `/prep-mcp`'),
    );
  });

  it('writes the release note BEFORE running prep — the connector README renders it', () => {
    expect(headingIndex(md, 'Write the release note')).toBeLessThan(
      headingIndex(md, 'Run `/prep-mcp`'),
    );
  });

  it('checks the clone refspec BEFORE touching the version', () => {
    expect(headingIndex(md, "Trust `origin/main`")).toBeLessThan(
      headingIndex(md, 'Set the version by hand'),
    );
  });

  it('uses npm, not pnpm, to build the MCP source — those repos ship package-lock.json', () => {
    const rebuildStart = headingIndex(md, "Rebuild the MCP's `dist/`");
    const rebuildEnd = headingIndex(md, 'Run `/prep-mcp`');
    const section = md.slice(rebuildStart, rebuildEnd);
    expect(section).toContain('npm ci');
    expect(section).not.toContain('pnpm install && pnpm run build');
  });

  it('documents where the release note lives and that it is required', () => {
    expect(md).toContain('.github/RELEASE_NOTES.md');
    expect(md).toContain('<!-- N8N_UPGRADE -->');
    expect(md).toContain('<!-- /N8N_UPGRADE -->');
  });

  it('spot-checks the GitHub Release after publishing', () => {
    const start = md.indexOf('## Post-publish verification');
    expect(start).toBeGreaterThan(-1);
    expect(md.slice(start)).toContain('GitHub Release');
  });

  it('lists an unflagged /prep-mcp run as an anti-pattern', () => {
    const start = md.indexOf('## Anti-patterns');
    expect(start).toBeGreaterThan(-1);
    expect(md.slice(start)).toContain('without `--skip-tag`');
  });

  // Epic 18 review (F11): the fail-closed gate is unconditional on a real
  // publish, and none of the three source repos has ever carried
  // `.github/RELEASE_NOTES.md` at origin/main — so the next real publish of ANY
  // product, not just EAD Factory, fails in `setup` for a file nobody was told
  // to write. We kept the gate fail-closed and made the runbook step mandatory,
  // named for all three products, and ordered before the tag.
  it('names writing the note as mandatory for every product, not just one', () => {
    const start = headingIndex(md, 'Write the release note');
    const end = headingIndex(md, "Rebuild the MCP's `dist/`");
    const section = md.slice(start, end);
    expect(section).toContain('every product');
    for (const repo of ['EAD-Factory-MCP', 'GoCertius_MCP', 'EAD_Enterprise_Suite_MCP']) {
      expect(section, `the first release of ${repo} has to write the note`).toContain(repo);
    }
  });

  it('orders writing the note BEFORE creating the tag it has to ride', () => {
    expect(headingIndex(md, 'Write the release note')).toBeLessThan(
      headingIndex(md, 'Create and push the tag'),
    );
  });

  // Epic 18 review (F4): a retry cannot re-tag a published version, so the
  // advisory escape hatch has to be documented where the operator will look.
  it('documents the advisory mode for retries and dry-runs', () => {
    expect(md).toContain('release_note_check');
    expect(md).toContain('advisory');
  });

  // Epic 18 review (F14): step 3 tells the operator to hand-edit
  // `pending-to-publish/<mcp>/package.json#version`, a file every published repo's
  // `.artifact-owners.yaml` lists under `generator:` — while this same document cites
  // that table ~100 lines later as the authority for where the release note may live.
  // The edit is legitimate; it is legitimate only because generation carved the field
  // out. Unstated, it reads as "generator ownership is advisory", which is the
  // reasoning a future reader would copy onto the next generator-owned file.
  it('states the package.json#version carve-out where it tells you to hand-edit it', () => {
    const start = headingIndex(md, 'Set the version by hand');
    const end = headingIndex(md, 'Write the release note');
    const section = md.slice(start, end);
    expect(section).toContain('.artifact-owners.yaml');
    expect(section).toContain('field_exceptions');
    expect(section).toContain('package.json#version');
    // And the carve-out is bounded to one field, with the schema bump that carries it.
    expect(section).toContain('artifact_owners_schema_version');
    expect(section).toContain('**1 → 2**');
  });

  // Epic 18 review (F8/F10): the span used to be optional in prose and
  // computed-then-discarded in code. Both are now fail-closed.
  it('states that the N8N_UPGRADE span is mandatory on a real publish', () => {
    expect(md).not.toContain('A note with no markers at all is legal');
    expect(md).toContain('mandatory on a real publish');
  });
});
