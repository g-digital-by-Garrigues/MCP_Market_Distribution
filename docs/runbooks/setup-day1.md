# Day-1 setup runbook

This runbook is the canonical reference for the **operational human-only steps** required to bootstrap the g-digital MCP distribution pipeline. The corresponding planning document (`_bmad-output/planning-artifacts/human-setup-runbook.md`) lists every task; this runbook focuses on the **automatable subset** that the three setup-helper Claude Code skills cover.

## Prerequisites

- Docker Desktop running (for the GitHub MCP Server container).
- Node 22+ and pnpm 9.15+ on `$PATH`.
- npm CLI v11.10 or newer (`npm --version`).
- Logged in to npm as a member of the `@g-digital` org (`npm whoami`, then `npm org ls @g-digital`).
- The GitHub MCP Server mounted in Claude Code with the corporate CA bundle (see `~/.claude.json#mcpServers.github` — the existing entry already includes the `SSL_CERT_FILE` + volume mount for Garrigues' Netskope chain).
- *(Optional, full-automation)* `gh` CLI installed and `gh auth login` completed. Without `gh`, the `/setup-pipeline-repo` skill falls back to its hybrid mode and prints the manual URLs you need to visit.

## The three skills

| Skill | Automates which human-setup tasks | Estimated time saved |
|---|---|---|
| [`/setup-pipeline-repo`](.claude/commands/setup/setup-pipeline-repo.md) | #2 (repo creation), #4 (LICENSE/README), #8 (branch protection), #10 (CI secrets) | ~30 min → ~5 min |
| [`/setup-trusted-publishers`](.claude/commands/setup/setup-trusted-publishers.md) | #15 (npm Trusted Publishing wired per package) | ~15 min → ~30 sec |
| [`/preflight-mcp`](.claude/commands/setup/preflight-mcp.md) | #17 (per-MCP readiness check before tagging) | ad-hoc → 5 sec |

## Recommended invocation order

1. **One-time per pipeline repo**:
   ```
   /setup-pipeline-repo g-digital-by-Garrigues MCP_Market_Distribution
   ```
   Idempotent — re-running on a configured repo is a no-op.

2. **Per MCP, before the first publish of that MCP**:
   ```
   /setup-trusted-publishers
   ```
   Until `0.0.0-bootstrap` exists for a package, it'll be skipped with a clear "publish a bootstrap version first" message. Bootstrap-publish each package, then re-run.

3. **Per MCP, before every tag push**:
   ```
   /preflight-mcp <mcp-name>
   ```
   Confirms the source folder satisfies Layer-1 checks. Exits non-zero with remediations if anything is missing — same exit semantics as the CI gate it mirrors.

## What to do when a skill fails

Every skill emits a structured `{ step, cause, action }` report on the failure path (FR34 shape). Read the `action` line and apply it. Common causes:

- `npm whoami` reports "not logged in" → `npm login --scope=@g-digital` with an org-owner account.
- `git remote get-url origin` returns nothing → run `git remote add origin https://github.com/<org>/<repo>.git`.
- `mcp-pipeline.yaml` fails schema validation → fix the field paths the report lists, then re-run.
- Secret setup in hybrid mode → open the URL the skill prints, paste the value the engineer just typed into chat (the skill does not echo secrets back; you keep your own copy).

## Related artifacts

- `_bmad-output/planning-artifacts/human-setup-runbook.md` — the complete 20-task human setup runbook (this document covers only the automatable subset).
- `docs/runbooks/bot-pat-rotation.md` *(Story 6.3, pending)* — how to rotate `BOT_PAT` once the dedicated bot account exists at Garrigues IT.
- `docs/runbooks/npm-trusted-publisher-setup.md` *(Story 6.1, pending)* — security rationale + rotation playbook for npm Trusted Publishing.
- `docs/runbooks/smithery-fallback.md` *(Story 6.2, pending)* — what to do when Smithery deploy verification times out.
