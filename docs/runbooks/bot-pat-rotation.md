# Bot PAT rotation runbook

How to rotate the `BOT_PAT` GitHub Personal Access Token used by the marketplace-submission publishers, on a quarterly cadence or after a security event.

This runbook addresses [Story 6.3](../../_bmad-output/planning-artifacts/epics.md).

## What `BOT_PAT` is and what uses it

`BOT_PAT` is a fine-grained GitHub Personal Access Token belonging to the `HA-gdigital` bot account. It's stored as a repo secret on `MCP_Market_Distribution` and threaded through to the calling source MCP repos via `secrets: inherit` in their thin `publish.yml` wrappers.

Three pipeline publishers use it:

| Publisher | What it does with the token |
|---|---|
| [`publish-cline`](../../src/publishers/publish-cline.ts) | Opens / upserts an issue on `cline/mcp-marketplace` for each MCP |
| [`publish-mcpso`](../../src/publishers/publish-mcpso.ts) | Opens / closes issues on `chatmcp/mcpso` for each MCP version |
| [`publish-docker-mcp-catalog`](../../src/publishers/publish-docker-mcp-catalog.ts) | Forks `docker/mcp-registry`, pushes a branch, opens a PR; closes stale PRs for prior versions |

None of the OIDC-publishing targets (npm, MCP Official Registry, Smithery) use this PAT — those use the workflow's OIDC token. The PAT is only for **third-party marketplace submissions where we have no other authentication option**.

## Required PAT scope

**Fine-grained token, minimum scopes:**

- `public_repo` — open issues + PRs on public upstream marketplaces (cline, chatmcp, docker)
- `read:user` — verify token identity for log events

That's it. The token does **not** need:
- Write access to any of our own repos (those are handled by `GITHUB_TOKEN`)
- Workflow scope (the publishers don't dispatch workflows)
- Org admin or repo admin scopes
- Package read/write (no npm interactions go through this token)

A classic PAT also works if fine-grained tokens aren't available, but use the same minimum scope (`public_repo` only).

## Why one PAT instead of three

Risk acceptance documented during Epic 4 planning (search "Mary's flagged risks" in [`epics.md`](../../_bmad-output/planning-artifacts/epics.md)):

- All three publishers act with **identical permission needs** (open public-repo issues / PRs only).
- The blast radius of compromise is bounded by `public_repo` — no private data exposure, no destructive operations on our own infrastructure.
- Three separate PATs would triple the rotation work and audit surface without reducing exposure (any one of them grants the same level of access).
- The bot account has no privileged role anywhere; the PAT is the bot's full power.

Trade-off accepted: a single compromise event invalidates all three publishers' authentication at once. Mitigation: rotate quarterly, monitor failed-auth events in the workflow logs, and use fine-grained tokens (which can be revoked surgically per target repo if needed).

## Rotation procedure (target ≤ 20 minutes)

### 1. Generate a new token

1. Log in to GitHub as the bot account (`HA-gdigital`).
2. Open https://github.com/settings/personal-access-tokens/new
3. **Token name:** `mcp-market-distribution-bot-<YYYY-QQ>` (e.g., `mcp-market-distribution-bot-2026-Q3`).
4. **Expiration:** 90 days from today. Tighter than that creates rotation churn; looser undermines the point of rotation.
5. **Repository access:** "Public repositories (read-only)" — the fine-grained UI gates `public_repo` write access through the underlying issues/PR permissions, set below.
6. **Permissions → Repository → Issues:** **Read and write**.
7. **Permissions → Repository → Pull requests:** **Read and write**.
8. **Permissions → Account → Email addresses (if shown):** **Read** (some fine-grained UIs require this to attach an author identity to opened issues; harmless).
9. Generate. Copy the token immediately — GitHub only shows it once.

### 2. Sanity-check the new token (≤ 2 minutes)

```bash
GH_TOKEN="<new-token>" gh api user --jq '.login'
# → HA-gdigital

GH_TOKEN="<new-token>" gh api repos/cline/mcp-marketplace --jq '.permissions'
# → should show issues read+write, pull request read+write
```

If `gh api user` returns a different login or 401, you copied the wrong token. Generate again.

### 3. Update the org secret

```bash
gh secret set BOT_PAT --org g-digital-by-Garrigues --visibility selected \
  --repos "MCP_Market_Distribution,EAD-Factory-MCP,EAD_Enterprise_Suite_MCP,GoCertius_MCP" \
  --body "<new-token>"
```

Or via the GitHub UI: Org settings → Secrets and variables → Actions → `BOT_PAT` → Update.

**Selected repos**: the token only needs to be visible to `MCP_Market_Distribution` (which holds the pipeline) and the three source MCP repos (which use `secrets: inherit` to pass it through). Don't grant org-wide visibility.

### 4. Verify the secret reaches the pipeline

Trigger a dry-run on any MCP source repo:

```bash
gh workflow run publish.yml \
  --repo g-digital-by-Garrigues/EAD-Factory-MCP \
  --field version=1.0.12 \
  --field dry_run=true \
  --field track=both \
  --field step=all
```

Watch the run. The Cline / mcp.so / Docker MCP Catalog publishers run in dry-run mode without actually opening anything but they DO validate the PAT against the upstreams. If the new token works, those steps return `succeeded`. If the old token (cached, wrong env) is still in play, you'll see 401s in the publisher logs.

### 5. Revoke the old token

Only after a successful dry-run with the new token:

1. Go to https://github.com/settings/personal-access-tokens (logged in as `HA-gdigital`).
2. Find the prior token (matching the previous `mcp-market-distribution-bot-<YYYY-QQ>` name).
3. Click **Revoke**.
4. Confirm.

The pipeline shouldn't notice — the org secret already points at the new token. The old token simply stops working.

### 6. Document the rotation

Append a one-line entry to [`docs/runbooks/bot-pat-rotation-log.md`](./bot-pat-rotation-log.md) (create the file if it's missing):

```
| 2026-MM-DD | <YYYY-QQ> | HA-gdigital | <expiry-date> |
```

This is the audit trail. It's also where the next rotator looks to know when their predecessor rotated, and whether it was on schedule.

## Emergency rotation (compromise event)

If you suspect the token is compromised (leaked logs, accidental commit, etc.):

1. **Skip step 4 (verification)**. Don't wait for a successful dry-run.
2. Revoke the old token IMMEDIATELY (step 5 first, then steps 1–3).
3. Trigger a dry-run after the new token is in place to confirm the pipeline still works.
4. Audit the workflow runs since the last known-good rotation: look for unexpected `target.publish_succeeded` events for cline/mcpso/docker-mcp-catalog. The bot only opens new submissions on real publishes, so unexpected `gh issue create` events in the audit log are the relevant signal.
5. File a security note describing the suspected leak vector so the next rotation is informed.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 in `publish-cline` immediately after rotation | Org secret update didn't reach the repos | Re-run `gh secret set ... --repos "..."` with the correct repo list |
| 403 on `gh pr create` against `docker/mcp-registry` | Fine-grained token missing pull_request: write permission | Re-issue with PR write scope |
| 403 with "rate limit" body | Bot exceeded GitHub's REST rate limit (5000/hr for authenticated requests) | Wait the reset interval (visible in `X-RateLimit-Reset` response header); for sustained high-frequency publishing, consider talking to GitHub support |
| Token works in `gh api` but not in the workflow | The workflow is reading a stale cached secret | Cancel any in-flight runs; new runs always re-read secrets |
| New issues / PRs are being opened by your personal account, not `HA-gdigital` | The PAT was generated from the wrong account | Log out, log in as `HA-gdigital`, redo the rotation |

## See also

- [`release-checklist.md`](./release-checklist.md) — pre-publish checklist (assumes `BOT_PAT` is valid)
- [Cline, mcp.so, Docker MCP Catalog publisher source](../../src/publishers/) — the three modules that consume this token
- [Story 6.3 acceptance criteria](../../_bmad-output/planning-artifacts/epics.md) — original requirement
- [Epic 7 retrospective](../../_bmad-output/implementation-artifacts/epic-7-retro-2026-05-24.md) — quarterly cadence cadence
