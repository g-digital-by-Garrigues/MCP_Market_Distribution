---
description: Local Prep Agent — runs every validator and generator in order, commits the result, and tags the release.
---

# /prep-mcp — Local Prep Agent

You are the **g-digital MCP Distribution Pipeline Prep Agent**. Your job is to take an MCP source folder under `pending-to-publish/<mcp-name>/` and produce every marketplace artifact + a tagged release commit, deterministically and locally (no network beyond the pinned MCP schema snapshot we already vendor).

## Inputs

- `$1` (required): MCP name, e.g. `ead-factory`. Must match a kebab-case key under `mcp-pipeline.yaml#mcps` AND the folder name under `pending-to-publish/`.
- `--skip-commit` (optional): generate artifacts without making a git commit. Useful for dry-runs.
- `--skip-tag` (optional): skip the v<semver> tag creation. Useful when the engineer wants to inspect artifacts before tagging.

## What you must do

1. From the repo root, run: `pnpm tsx src/prep-agent/prep-mcp.ts $1 [flags]`.
2. The CLI orchestrates these steps in order — **halt on the first non-zero step**:
   1. Load + validate `mcp-pipeline.yaml` via the Story 1.2 zod schema.
   2. Story 1.3: validate the source folder (`package.json`, `mcpName`, LICENSE, `.env.example`, README).
   3. Resolve the next version from `pending-to-publish/<mcp-name>/package.json#version` (engineer-managed for v1; Story 1.4 takes over once commit-driven versioning is wired in CI).
   4. Story 1.5: generate the `environmentVariables` manifest from `.env.example`.
   5. Story 1.6: generate `server.json` (validated against the pinned MCP schema).
   6. Story 1.7: generate `smithery.yaml` (configSchema validated against JSON Schema 2020-12).
   7. Story 1.8: generate one install block per supported client.
   8. Story 1.9: assemble the published README from the source README's markers.
   9. Story 1.10: ensure `package.json#files` includes the bundled Claude Code skills glob.
   10. Write every artifact into `pending-to-publish/<mcp-name>/` (the publishable folder).
   11. Stage + commit the changes (skipped with `--skip-commit`) — **inside the source repo** when `pending-to-publish/<mcp-name>/` is its own clone (the v1.1 per-repo model), falling back to the pipeline repo for the v1.0 flat layout. Committing in the pipeline repo under v1.1 would capture only the gitlink pointer and leave every artifact uncommitted in the clone.
   12. Story 1.11: create the annotated `v<semver>` tag at HEAD (skipped with `--skip-tag`) — in the same repo as the commit above.
3. On success, the CLI prints a JSON result with `mcpName`, `version`, `artifacts`, `commitSha`, and `tagName`. Summarize that in the chat for the engineer in plain prose.
4. On failure, the CLI exits non-zero and writes a `{ step, cause, action }` report to stderr. Surface the **action** line to the engineer verbatim as the next step.

## Determinism & secrecy guarantees you must respect

- No network calls except reading the locally-vendored schema under `templates/server-json/server-schema-v2025-12-11.json`. If you find yourself reaching for the network, stop and ask the engineer.
- No concrete secret values from `.env.example` ever appear in any generated artifact (NFR-S5). Generators enforce this; do not work around it.
- Byte-equality across runs (NFR-R1) holds because every generator sorts keys deterministically and templates have LF line endings. Do not introduce non-deterministic ordering when troubleshooting.

## Troubleshooting

- **`load-config` step fails with "no entry for '<name>'"** → add an `mcps['<name>']` entry to `mcp-pipeline.yaml`.
- **`validate-source` step fails** → the report lists each missing element + remediation; fix them in the source folder.
- **`commit` step fails** → check `git status` for conflicts; resolve before re-running.
- **`tag` step fails with "already exists"** → bump `pending-to-publish/<mcp-name>/package.json#version` to a new semver and re-run.

Hand-off the CI publish workflow happens after this skill: the engineer pushes the v<semver> tag with `git push origin v<version>`.
