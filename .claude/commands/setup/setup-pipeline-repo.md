---
description: One-command bootstrap of a fresh g-digital pipeline repo with branch protection, initial LICENSE/README, and the three CI secrets.
---

# /setup-pipeline-repo — Bootstrap a new pipeline repo

You are bootstrapping a new GitHub repository to host the g-digital MCP distribution pipeline. The goal is to reduce per-MCP onboarding from ~1.5 hours of manual clicks to a guided ~5-minute flow.

## Inputs

- `$1` (required): GitHub org slug. For the canonical setup this is `g-digital-by-Garrigues`.
- `$2` (required): repository name (e.g. `MCP_Market_Distribution` or, for a throwaway test, `MCP_Market_Distribution_setupskill_test`).

You will also ask the engineer interactively for these three secret values (do not echo them back):
- `DOCKERHUB_USERNAME` — Docker Hub org admin handle (typically `gdigital`).
- `DOCKERHUB_TOKEN` — Docker Hub Organization Access Token with Read & Write to repos.
- `BOT_PAT` — GitHub Personal Access Token used by CI to commit release reports and push tags. If the dedicated bot account doesn't exist yet, the engineer's own PAT is acceptable as a temporary measure; record a TODO to rotate when the bot account lands.

## Soft dependencies

This skill works in two modes; pick the highest-automation mode whose tooling is available:

1. **Full automation** — the `gh` CLI is installed AND `gh auth status` is green. Use `gh api` for branch protection and `gh secret set` for the three secrets.
2. **Hybrid** — only the GitHub MCP Server is available. Create the repo, LICENSE, README via MCP, then surface a copy-paste-friendly list of the manual steps the engineer still needs (URLs + values for each of the three secrets and the branch protection rule).

If neither is available, exit with a clear "install `gh` CLI or mount the GitHub MCP Server first" message — do NOT proceed.

## Idempotency

Before changing anything, check whether the repo already exists (`mcp__github__search_repositories` or `gh repo view`). If it does AND it is correctly configured (LICENSE present, README present, three secrets configured, branch protection on `main`), emit a single "✅ already configured" line and exit 0.

If the repo exists but is partially configured, complete the missing pieces only.

## Workflow

1. **Pre-flight**: confirm both arguments are present; confirm at least one of the soft-dependency tools is usable.
2. **Repo creation**: if missing, create the repo in the org as `private: false`, `autoInit: true` (or equivalent). Use the GitHub MCP `create_repository` tool.
3. **LICENSE** (`LICENSE`, MIT) — commit to `main` via `create_or_update_file`. Template:
   ```
   MIT License

   Copyright (c) <CURRENT_YEAR> J&A Garrigues, S.L.P.

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software ... (standard MIT text)
   ```
4. **README** (`README.md`) — commit a stub pointing engineers at the planning artifacts. Template:
   ```markdown
   # <repo-name>

   Pipeline repo bootstrapped by `/setup-pipeline-repo`. See:
   - `docs/runbooks/setup-day1.md` for next steps.
   - `mcp-pipeline.yaml` for per-MCP configuration.
   ```
5. **Branch protection on `main`** — require PR review (1 approval), require status checks before merge, dismiss stale reviews. In full-automation mode run:
   ```
   gh api -X PUT /repos/<org>/<repo>/branches/main/protection -H "Accept: application/vnd.github+json" \
     -f required_status_checks.strict=true \
     -f enforce_admins=false \
     -f required_pull_request_reviews.required_approving_review_count=1 \
     -f required_pull_request_reviews.dismiss_stale_reviews=true \
     -f restrictions=
   ```
   In hybrid mode, print this exact URL and rule list for the engineer to apply manually:
   `https://github.com/<org>/<repo>/settings/branches`.
6. **Secrets** — prompt the engineer (one at a time, never echoing back) for each value, then:
   - Full automation: `gh secret set <NAME> --body "<value>" --repo <org>/<repo>`.
   - Hybrid: print the exact URL `https://github.com/<org>/<repo>/settings/secrets/actions/new` and the secret name; the engineer pastes the value there.
7. **Summary**: emit one structured success/failure line per step. Example:
   ```
   ✅ repo created (or already present)
   ✅ LICENSE committed (or already present)
   ✅ README committed (or already present)
   ✅ branch protection on main (or already configured)
   ⚠ DOCKERHUB_USERNAME — set manually at https://github.com/<org>/<repo>/settings/secrets/actions/new (hybrid mode)
   ⚠ DOCKERHUB_TOKEN — set manually at https://github.com/<org>/<repo>/settings/secrets/actions/new (hybrid mode)
   ⚠ BOT_PAT — set manually at https://github.com/<org>/<repo>/settings/secrets/actions/new (hybrid mode) [TODO rotate when bot account lands]
   ```

## Safety rails

- Never log secret values to chat. The engineer pastes them interactively; the skill consumes them once.
- Never overwrite an existing LICENSE or README — only create if missing.
- Never delete or recreate branch protection rules; only create when missing.
- If any step fails, halt the chain and emit `{ step, cause, action }` so the engineer can fix and re-run.

## Notes

- This skill is operational tooling; manual setup via `docs/runbooks/setup-day1.md` remains the documented fallback.
- The skill targets Phase-2 second-MCP onboarding, where the time savings compound.
- TODO once the dedicated bot account exists at Garrigues IT: replace the engineer's personal PAT in `BOT_PAT` and update `docs/runbooks/bot-pat-rotation.md`.
