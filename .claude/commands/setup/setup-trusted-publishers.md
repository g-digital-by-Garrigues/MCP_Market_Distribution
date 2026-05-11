---
description: Iterate every MCP and n8n-node package declared in mcp-pipeline.yaml and run `npm trust grant` for each so npm Trusted Publishing (NFR-S2) is enforced.
---

# /setup-trusted-publishers — Wire npm Trusted Publishing

You are wiring **npm Trusted Publishing** for every package declared in `mcp-pipeline.yaml`. After this skill, the `publish.yml` workflow on `main` is the only path that can publish to the registered packages — no long-lived npm tokens needed (NFR-S2).

## Pre-flight (block on any failure)

- `npm --version` must be ≥ 11.10. If older, tell the engineer to `winget upgrade --id OpenJS.NodeJS.LTS` (Windows) or update via their package manager.
- `npm whoami` must succeed AND the engineer must be a member of the `@g-digital` org (`npm org ls @g-digital` should include their username). If not, surface "log in with `npm login --scope=@g-digital` as an org owner first" and exit non-zero.
- The repo root must contain `mcp-pipeline.yaml` and a `git remote get-url origin` returning a GitHub URL the skill can parse as `<owner>/<repo>`.

## What the skill runs

Invoke the helper that reads `mcp-pipeline.yaml`, iterates every entry, derives the two npm package names per entry (`npm_package_name` and `<npm_scope>/<n8n_adapter_target_name>`), de-duplicates, and runs `npm trust grant --provider github --owner <owner> --repo <repo> --workflow publish.yml --package <package>` for each:

```
pnpm tsx src/setup/run-trusted-publishers.ts [--dry-run] [--owner <name>] [--repo <name>] [--workflow <file>]
```

Default behavior:
- `--owner` and `--repo` are inferred from `git remote get-url origin`. Pass explicit flags to override.
- `--workflow` defaults to `publish.yml`.
- `--dry-run` prints what would happen without invoking npm.

The helper emits structured JSON with per-package outcomes and counts under four classifications:
- `configured` — newly granted in this run.
- `already-configured` — npm reported the grant was already in place; no-op.
- `package-not-published` — the package doesn't exist on npm yet; **publish a `0.0.0-bootstrap` version first**, then re-run the skill. This is the documented bootstrap order.
- `failed` — anything else; the `detail` field carries the stderr line.

## How to surface results

After the helper runs, summarize the counts to the engineer in plain prose: e.g. "2 newly configured, 0 already-configured, 4 skipped (publish a bootstrap version first), 0 failed". For each `package-not-published` outcome, include the exact `npm publish ...` command the engineer would run for that package.

If any `failed` outcomes appear, halt and emit `{ step, cause, action }` so the engineer can read the npm error message and act on it.

## Idempotency

Re-running the skill is safe. Already-configured grants are detected from npm's output and reported without action.

## Notes

- This skill is **soft-dependent on the GitHub MCP Server** — it doesn't need it. The grants are made via the local npm CLI talking to the npm registry directly.
- The actual CI publish workflow (Epic 2/3) uses GitHub OIDC; this skill just ensures the npm registry knows which (owner, repo, workflow, package) tuples are allowed to publish.
- See `docs/runbooks/npm-trusted-publisher-setup.md` once it lands (Story 6.1) for the full security rationale and rotation playbook.
