# Slash-command author validation policy

Who can dispatch retry slash-commands on release PRs, why we drew the line where we did, and the operational implications.

This document is referenced from the rejection reply that the [`retry-dispatch.yml`](../../.github/workflows/retry-dispatch.yml) workflow posts when an unauthorized user attempts to dispatch — so the comment text and the wording here must stay in sync. The decision and reply wording live in [`src/slash-command/validate-author.ts`](../../src/slash-command/validate-author.ts), which is the single source of truth.

Addresses [Story 6.5](../../_bmad-output/planning-artifacts/epics.md).

## The policy in one sentence

Anyone with **write access or higher** on the source MCP repo can dispatch `/retry-publish` commands. Everyone else gets a polite rejection.

## Authorized roles

The pipeline accepts these GitHub collaborator roles:

| Role | Notes |
|---|---|
| `admin` | Full repo admin |
| `maintain` | Non-admin maintainer (push + settings) |
| `write` | Push access |

Anything else (`triage`, `read`, `none`, or any future role we don't recognize) is rejected. The rejection is **fail-closed** by design: an unknown role gets the same treatment as `none`, never the benefit of the doubt.

## Why this line

Three points anchor the policy:

1. **The dispatcher consumes CI minutes.** `/retry-publish` triggers `publish.yml`, which is one of our most expensive workflows (multi-track gates, MCPB bundle build, multiple registry publishes). A read-only commenter could otherwise burn CI minutes from a public-PR drive-by.

2. **Write-equivalent users could already do this another way.** Anyone with push access can push a `v*` tag and trigger the same workflow. The slash-command isn't a privilege escalation — it's a UX shortcut for people who already have the underlying authority.

3. **`triage` is intentionally below the line.** Triage grants label/close authority over issues and PRs but no push rights. A reviewer who can close a PR but couldn't tag a release shouldn't be able to dispatch a release retry either. This is consistent with how we'd handle it if they tried to push a tag — they couldn't.

## How the check works

When a `/retry-publish` comment lands on a release PR:

1. `retry-dispatch.yml` parses the comment (via [`parse-command.ts`](../../src/slash-command/parse-command.ts) — invalid syntax exits early with a usage reply)
2. The workflow calls GitHub's `repos.getCollaboratorPermissionLevel` API for the commenter against the source MCP repo
3. The returned role is passed to [`validateAuthor(role, username)`](../../src/slash-command/validate-author.ts), which decides authorized/unauthorized and formats the rejection reply
4. If authorized, the workflow continues to the `publish.yml` dispatch
5. If unauthorized, the workflow posts the rejection reply and exits

**No call to GitHub's API means `role === null`**, which `validateAuthor` normalizes to `'none'` and rejects. This handles the failure mode where the API call itself errors out — the safe default is "don't dispatch".

## What an unauthorized commenter sees

A PR comment like:

> @username you need write access to this repo to dispatch a retry. Current role: `read`. See docs/runbooks/slash-command-policy.md for the rationale.

The comment uses backticks around the role string so it's grep-friendly and the value is visually distinct.

## Edge cases

### Org members not in the repo's contributor list

The pipeline uses `repos.getCollaboratorPermissionLevel`, not `author_association`. The latter is unreliable for members of the parent organization who haven't been explicitly added to the repo's collaborator list — they may show up as `MEMBER` in `author_association` despite having no actual collaborator role. Using `getCollaboratorPermissionLevel` resolves this consistently: the role is what the repo's settings + org-level repo permissions actually grant.

### Bot accounts

Bot accounts (GitHub Apps acting on behalf of installations) appear with their installation's permission. If you want a bot to be able to dispatch, grant the installation `write` on the source MCP repo.

### Forks

Slash-commands on PRs from forks don't pose a separate concern — `getCollaboratorPermissionLevel` is queried against the repo where the PR is being submitted to (`MCP_Market_Distribution`-callers like `EAD-Factory-MCP`), not the fork. A commenter's role on the fork is irrelevant.

### Cross-repo dispatch

The workflow always queries the role on the repo the comment was posted on. There's no cross-repo escalation path: write access on repo A does not authorize dispatches against repo B.

## Changing the policy

If you need to broaden or narrow the authorized set:

1. Edit `AUTHORIZED_ROLES` in [`src/slash-command/validate-author.ts`](../../src/slash-command/validate-author.ts)
2. Update the unit tests in [`tests/unit/slash-command/validate-author.test.ts`](../../tests/unit/slash-command/validate-author.test.ts)
3. Update this document (the authorized-roles table above)
4. The rejection reply text auto-updates because it cites the current role from the result object

Don't change the rules in the workflow YAML inline — they're meant to delegate to the TypeScript module so the policy stays unit-testable.

## See also

- [`src/slash-command/validate-author.ts`](../../src/slash-command/validate-author.ts) — the policy code (single source of truth)
- [`src/slash-command/parse-command.ts`](../../src/slash-command/parse-command.ts) — the command grammar parser
- [`.github/workflows/retry-dispatch.yml`](../../.github/workflows/retry-dispatch.yml) — the workflow that calls these
- [`release-checklist.md`](./release-checklist.md) — the full release flow this command interacts with
- [Story 6.5 acceptance criteria](../../_bmad-output/planning-artifacts/epics.md) — original requirement
