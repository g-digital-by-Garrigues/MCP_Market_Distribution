---
description: Validate an MCP source folder against the same Layer-1 checks the CI gate runs, so engineers can fix issues locally before pushing the v* tag.
---

# /preflight-mcp — Pre-commit validator

You are running the same Layer-1 validation the CI Track A gate runs (Story 1.3 today; Stories 2.2 layer-1 helpers plug in next), so engineers know whether `pending-to-publish/<mcp-name>/` is publication-ready BEFORE pushing a `v*` tag.

## Inputs

- `$1` (required): MCP name, e.g. `evidence-manager`. Must be a kebab-case key in `mcp-pipeline.yaml#mcps` AND the folder name under `pending-to-publish/`.

## What the skill runs

```
pnpm tsx src/setup/run-preflight.ts <mcp-name>
```

The helper:
1. Loads `mcp-pipeline.yaml` and validates it against the zod schema (Story 1.2). If the config itself is malformed, the helper exits with the field paths + reasons.
2. Resolves `mcps[<mcp-name>]`. If the entry is missing, the helper lists available keys for the engineer.
3. Runs the Story 1.3 source-folder validator against `pending-to-publish/<mcp-name>/` using the entry's `reverse_dns_name` as the expected `mcpName` value.
4. Emits a JSON report with the source-folder check list (each item `present` or `missing`, with remediation text on misses) and a single boolean `ready`.

## Exit semantics (same as the CI gate it mirrors)

- Exit `0` — every required element is present, `ready: true`. The engineer can safely push a `v*` tag.
- Exit `1` — at least one element is missing OR the config has errors. The structured error follows the FR34 shape; surface the per-item remediation text to the engineer in chat.
- Exit `2` — usage error (missing argument).

## How to surface results

When `ready: true`, say so in one line. When `ready: false`:
- Print the `mcp-name` and the list of missing items, one per line, each with its remediation text.
- Print the canonical fix-and-retry hint: "Apply the remediations above, then re-run `/preflight-mcp <mcp-name>`."

## Notes

- Layer 1 in the CI gate runs the same `validateSourceFolder` plus future Stories 2.2 helpers. Keep this skill aligned by extending `run-preflight.ts` whenever a new Layer-1 helper lands.
- The skill is a soft dependency on nothing; it only needs the repo on disk and `pnpm` in PATH.
