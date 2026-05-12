# Dry-run mode (Story 2.9 / FR40)

Dry-run is the "would this release succeed without actually publishing" mode of `publish.yml`. It runs every gate normally — Layer 1, Layer 2, Layer 3, the NFR-S3 audit — and runs each publisher composite action through its validation path (`npm publish --dry-run`, `docker build` without `push`, `mcp-publisher publish --dry-run`) but never produces an externally-visible change. The release report is still generated locally so engineers can review what *would* have been published.

This is Journey 3 ("verify a release would succeed before tagging") in the PRD.

## How to invoke

Manual dispatch from the GitHub Actions UI:

1. Actions → **publish** workflow → **Run workflow**
2. Fill `mcp_name` and `version` (the version you'd tag with)
3. Toggle **dry_run** to `true`
4. (Optional) Set `step: gate` if you only want to verify the gates and skip the publisher dry-runs

A tag push (`git push origin v1.0.0`) is never a dry-run — tag pushes always carry the intent to publish. If you need to verify a tag-pushed release without consequences, dispatch the workflow manually against an earlier ref instead.

## What dry-run does NOT skip

- **Gate Layers 1/2/3** — these are the whole point of dry-run; they execute fully.
- **NFR-S3 consumer-credentials audit** — runs every time, dry-run or not.
- **Resolve-workflow-context** — still computes `pipeline_run_id`, `mcp_name`, `version`, etc.
- **Build verification** (`pnpm run typecheck && pnpm run test`) — runs every time.
- **PR comment upserts on gate FAILURES** — if a gate fails during a dry-run, the error report is still posted to the PR. Dry-run is about not making *publication* changes; gate-failure feedback is the point of running the workflow at all.

## What dry-run DOES skip

Every state-changing call site downstream of the gates must consult `dryRunEnabled()` (see `src/ci/dry-run.ts`) before doing anything externally visible:

| Operation                                  | Dry-run behavior                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `npm publish`                              | Runs `npm publish --dry-run` instead; returns placeholder `target_url`.     |
| `docker push`                              | Builds the image (so the gate still works) but skips push; placeholder url. |
| `mcp-publisher publish`                    | Runs only `mcp-publisher publish --dry-run`; placeholder url.               |
| Release report PR comment upsert           | Generated locally but not posted to the PR.                                 |
| Release report file commit to `main`       | Written to the workflow artifact but not committed.                         |
| Orphan-branch state ledger write           | Skipped entirely.                                                           |
| Slack / issue creation for partial fails   | Skipped.                                                                    |

## The contract for composite-action authors

Every composite action (`actions/publish-*/action.yml`) must accept a `dry_run` input of type `boolean` (or string `'true' | 'false'`) and pass it through to its underlying script. The action's `result_json` output must include `status: "succeeded"` even in dry-run when the validation path succeeds, with `target_url` set to a placeholder like `https://example.invalid/dry-run/<target>/<mcp>/<version>` so the release report renders consistently.

The action should also emit a `target.publish_skipped` structured log event (`reason: 'dry_run'`) so the per-target row in the release report can be flagged unambiguously.

## How publish.yml wires it

`publish.yml#setup` job exposes `dry_run` as a job output — derived from `inputs.dry_run` (manual dispatch) or defaulted to `false` (tag push). Every downstream job sets `env: DRY_RUN: ${{ needs.setup.outputs.dry_run }}` so any helper script invoked via `pnpm tsx ...` can read `process.env.DRY_RUN` consistently.

Composite actions receive the flag both as an input AND inherit the env var — explicit input takes precedence, which lets us test individual actions in isolation with a clean override.

## The "Status: DRY RUN" marker

The release-report markdown generator (Story 3.5) renders the status line as `**Status: DRY RUN**` instead of the usual ✅/⚠️/❌ when dry-run is on. This is the single visible signal in the report — engineers reviewing the artifact can tell at a glance that nothing was actually published. The constant is exported as `DRY_RUN_STATUS_HEADER` from `src/ci/dry-run.ts`.
