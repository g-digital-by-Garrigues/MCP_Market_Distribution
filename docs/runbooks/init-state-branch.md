# Initialize the `releases/state` orphan branch (Story 3.9)

The pipeline uses an orphan branch named `releases/state` to track per-release attempt history. Story 4.8 will start writing `releases/state/<mcp_name>/<version>.json` to this branch on every publish, so that:

- Slash-command retries (Story 4.10's `/retry-publish?step=<target>`) know which targets already succeeded and can be skipped.
- A consolidated final-report builds from the ledger when all attempts eventually converge.
- Re-runs of the same `(mcp, version)` are idempotent at the publisher boundary AND at the report boundary.

## What is an orphan branch?

A git branch whose history starts from scratch — no shared commits with `main`. The state ledger lives in a parallel namespace inside the same repository, isolated from main's history so:

- Main's `git log` stays focused on code changes; the state churn is invisible.
- Main's CI is not triggered by ledger writes.
- Anyone cloning the repo can opt into the state branch with `git fetch origin releases/state:releases/state` only when they need it.

## When to run

Once per repository, as part of the bootstrap. The script is idempotent — re-running after creation exits 0 with `state_branch.already_exists`. CI can call it before any publish without consequence.

## How to run

```
pnpm run init-state-branch
```

The script:

1. Calls `git ls-remote --heads origin releases/state` to check whether the branch already exists on the remote.
2. If yes → exits 0 with a `state_branch.already_exists` log event.
3. If no → creates a worktree at `.git/state-init-worktree` pointing at a new `--orphan` branch, makes an empty initial commit (`chore(state): initialize releases/state orphan branch`), pushes to origin, and removes the worktree.

The local working tree is **never** touched — the worktree lives entirely under `.git/`.

## When to run with elevated permissions

If `releases/state` is added to your repo's branch-protection rules (typically: require PR review, no direct pushes), the bootstrap user needs a token that bypasses the rule for this one initialization. The recommendation:

1. Exclude `releases/state` from the protection rules' "Branches that match" expression.
2. OR run `pnpm run init-state-branch` once under an admin's PAT with bypass rights, then add `releases/state` to the protection rules.

Story 4.8 expects to write to `releases/state` from CI using the operational `BOT_PAT` secret; that token must have write access to the branch.

## What this guard does NOT do

- It does not create `releases/state/<mcp_name>/current.json`. That's Story 4.8's first-write responsibility, scoped per MCP at the first publish.
- It does not enforce that no consumer credential leaks into the branch — the orphan branch is intended for pipeline metadata only; the NFR-S3 audit (`audit-consumer-credentials.ts`) covers source code, not state files.
