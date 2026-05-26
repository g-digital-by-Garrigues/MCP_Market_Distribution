# Audit: inline JS / bash logic in `.github/workflows/`

**Date:** 2026-05-26
**Story:** [8.5](../../_bmad-output/planning-artifacts/epics.md)

## Purpose

Catalogue every workflow file that embeds non-trivial JavaScript or bash logic inline, grade the extraction value, and decide what to do about each entry. Triggered by [Story 6.5](../../_bmad-output/planning-artifacts/epics.md), where we discovered that the slash-command author validator had been living as inline JS inside `retry-dispatch.yml` for months — invisible to the unit-test suite and the runbooks — until the explicit refactor in PR #142.

This audit is the **plan**. Story 8.5's deliverable is the audit itself; each `extractable` entry below is a candidate for a follow-up extraction story but is not executed in this story.

## Grading rubric

| Grade | When to use it | Action |
|---|---|---|
| `trivial` | ≤5 lines, no API calls, no branching on data values, no message formatting | Leave as-is. Extraction would be net-negative (overhead > benefit). |
| `extractable` | Logic that we'd want to unit-test, OR a pattern that already has a TS equivalent we're not reusing, OR a wording/policy that should live in one place | File a follow-up story. |
| `leave-as-is` | Non-trivial but workflow-specific orchestration — manipulating GITHUB_OUTPUT, yq/jq on workflow-context files, env var threading | Leave inline. No TS alternative exists or makes sense. |

## Inventory

### `.github/workflows/publish.yml` (1,698 lines)

Two `actions/github-script@v7` blocks and ~23 multiline `run: |` blocks. Detailed below.

#### `Post or update PR comment` step (around line 583) — **extractable**

- **What it does:** Reads `error-report.md`, finds the associated PR via `listPullRequestsAssociatedWithCommit`, upserts a marked comment.
- **Why extractable:** Same upsert pattern as `src/reporters/pr-comment-upserter.ts` (used by Cline, mcpso, docker-mcp-catalog). The error-report path should call the existing module instead of reimplementing the logic inline. Two implementations means two places to fix the next "duplicate-comment-because-marker-changed" bug.
- **Proposed extraction:** Make this step shell out to `pnpm tsx src/reporters/run-pr-comment-upserter.ts <marker> <body-file>` (the existing module already has the seam — just need a CLI shim).
- **Size:** ~40 lines.

#### `Upsert PR comment with release report` step (around line 1649) — **extractable**

- **What it does:** Same upsert pattern as above, for release-report comments.
- **Why extractable:** Identical to the error-report block. Both should consume the same upserter module.
- **Proposed extraction:** Same as above. One CLI shim covers both call sites.
- **Size:** ~40 lines.

#### `Resolve workflow context` step (around line 142, multiline `run: |`) — **leave-as-is**

- **What it does:** Wraps `pnpm tsx src/ci/resolve-workflow-context.ts` and threads the resolved values into `$GITHUB_OUTPUT`.
- **Why leave-as-is:** The TypeScript module is already the canonical logic. The bash is just GH Actions plumbing — it reads JSON from disk, emits step outputs, and writes a step summary. No business logic.

#### `Resolve MCP source repo` step (around line 178, multiline `run: |`) — **leave-as-is**

- **What it does:** Reads `mcp-pipeline.yaml#mcps.<id>.repo_url` via `yq`, sets `repo_ref` based on `dry_run` flag.
- **Why leave-as-is:** Configuration extraction — appropriate to keep in YAML where the config also lives. The branching (`if dry_run, ref=main, else ref=v$version`) is 3 lines and reads naturally inline.

#### Coherence pre-hoc check (Story 8.2, around line 197) — **leave-as-is**

- **What it does:** Calls the validator CLI and posts a structured fail summary on mismatch.
- **Why leave-as-is:** Mostly a thin wrapper around the TS validator. The step-summary HTML is workflow-presentation, not business logic.

#### The other ~19 multiline `run: |` blocks — **trivial**

All inspected: they fall into three patterns:
1. `pnpm tsx <module>.ts <args>` calling out to TypeScript (trivial wrapper).
2. `cat result.json >> $GITHUB_OUTPUT` shape (trivial output marshalling).
3. `gh api / gh pr / git` 2-5 line invocations for things like committing release reports.

None contain branching on data values or message-formatting logic worth extracting.

### `.github/workflows/retry-dispatch.yml` (160 lines)

#### `Parse + validate + dispatch` step — **partial extraction already done**

- **History:** Originally a ~90-line `github-script` block with the parser + author validator + dispatcher all inline. Story 4.9 extracted `parseCommand` to TypeScript. Story 6.5 (PR #142) extracted `validateAuthor`.
- **What remains inline:** ~50 lines of GitHub-API orchestration — `listComments` to find the release-report marker, `createWorkflowDispatch` to fire `publish.yml`, `createComment` to reply.
- **Grade:** `leave-as-is`. The remaining logic is workflow-specific orchestration (resolves `mcp_name`/`version` from PR comments, passes inputs to `gh api`). No clear TS module emerges from it — it's not "decision logic" anymore, it's "API client wrapping". The two pieces with policy/logic content (parsing and authorization) are already extracted.

### `.github/workflows/regression-e2e.yml` (88 lines) — **trivial**

Pure orchestration: 3 jobs, each `uses: ./.github/workflows/publish.yml`. No inline logic.

## Summary

| Workflow | Extractable sites | Recommended action |
|---|---|---|
| `publish.yml` | 2 (both PR-comment upsert blocks) | Open story: "Consolidate PR-comment upsert logic — error-report + release-report both call `src/reporters/pr-comment-upserter.ts`" |
| `retry-dispatch.yml` | 0 (already extracted in Stories 4.9 + 6.5) | None |
| `regression-e2e.yml` | 0 | None |

## Follow-up backlog item

**Title:** Consolidate PR-comment upsert across error-report and release-report paths
**Type:** Technical debt
**Origin:** Story 8.5 audit
**Description:** Both inline `github-script` blocks in `publish.yml` reimplement the same upsert-marked-comment pattern that already exists in `src/reporters/pr-comment-upserter.ts`. Extract a CLI shim (`src/reporters/run-pr-comment-upserter.ts`) and have the workflow steps shell out to it. ~80 lines of inline JS → ~20 lines of workflow YAML + reuse of an existing unit-tested module.
**Risk:** Low. The upserter already has unit tests covering the upsert behaviour; this change consolidates the call sites without changing the policy.

## See also

- [ADR 0003](../adr/0003-slash-command-author-write-or-higher.md) — the Story 6.5 extraction this audit's principle is modelled on
- [`src/reporters/pr-comment-upserter.ts`](../../src/reporters/pr-comment-upserter.ts) — the existing module the recommended extraction would reuse
- Epic 6 retrospective lesson 4 (inline-code stories age poorly) — the rationale for running this audit at all
