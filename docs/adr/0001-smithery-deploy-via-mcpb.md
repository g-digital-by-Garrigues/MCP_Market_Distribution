# ADR 0001 — Smithery deploy via MCPB bundle, not git-push auto-deploy

**Status:** accepted
**Date:** 2026-05-19
**Supersedes:** (the original Smithery design from PRD Story 4.2 — pre-MCPB era, never had its own ADR)

## Context

The v1 PRD scoped Smithery integration as an **auto-deploy via git push**: the pipeline would push the generated `smithery.yaml` to a configured branch, then poll Smithery's API for up to 15 minutes to confirm the deploy took. Story 6.6 was originally a follow-up to "pin the verification policy" (timeout, polling interval, behaviour on timeout).

Two things broke this plan during Epic 5:

1. **Smithery launched their MCPB bundle model** during the implementation window. The bundle format (Anthropic's `@anthropic-ai/mcpb`) packages everything Smithery needs (manifest + server tree + node_modules) into a single `.mcpb` ZIP that the Smithery CLI uploads synchronously.

2. **Auto-deploy polling was a 15-minute wall-clock cost** every release, with no real win — the polling existed only because git-push deploys were asynchronous from Smithery's side. The MCPB CLI publish is synchronous: success or failure returns in seconds.

Continuing with auto-deploy after MCPB existed would have meant paying the polling cost forever for a model that solved nothing.

## Decision

Migrate Smithery publishing to the MCPB CLI flow:

1. Track C (`generate-mcpb-bundle` job + `track-c-layer-1/2/3` gates) builds and validates a `.mcpb` bundle from the source MCP.
2. `publish-smithery` (the publisher composite action) consumes the validated bundle and runs `smithery mcp publish <bundle> -n g-digital/<mcp_name>` with `SMITHERY_TOKEN` in env.
3. The CLI returns success/failure synchronously. No polling, no 15-minute timeout policy needed.

Story 6.6 ("Pin Smithery deploy verification policy") is recorded as obsolete in [`sprint-status.yaml`](../../_bmad-output/implementation-artifacts/sprint-status.yaml#L134) with a pointer to this ADR.

## Consequences

**Wins:**
- Smithery publish dropped from ~15-minute polling worst case to seconds-typical.
- Bundle validation (Track C Layer 1/2/3) catches malformed manifests before any external state mutation, where the old model could only detect failures post-deploy.
- The `.mcpb` bundle is an industry-standard artifact — interoperable with other MCPB hosts if any emerge.

**Trade-offs:**
- We now have a 3rd track (Track C) with its own 3-layer gate, adding pipeline complexity.
- `mcpb` CLI is pinned in two places (`run-mcpb-adapter-build.ts` MCPB_CLI_PACKAGE and `run-track-c-layer-2.ts`). Version drift between them is possible — caught by [`run-track-c-layer-2`'s contract note](../../src/gates/run-track-c-layer-2.ts).
- The fallback path documented in [`smithery-fallback.md`](../runbooks/smithery-fallback.md) is now "rerun the CLI manually with the same flags" rather than "manually push the YAML to a branch".

**Operational impact:**
- The 15-minute polling code paths in PRs from Epic 4 era are removed.
- Story 6.6's deliverable (a polling-policy runbook) was replaced by the [`smithery-fallback.md`](../runbooks/smithery-fallback.md) which is shorter and applies to the new model.

## References

- Migration PRs: #99–#104 in `MCP_Market_Distribution`
- Runbook: [`docs/runbooks/smithery-fallback.md`](../runbooks/smithery-fallback.md)
- Publisher: [`src/publishers/publish-smithery.ts`](../../src/publishers/publish-smithery.ts)
- Track C gates: [`src/gates/run-track-c-layer-{1,2,3}.ts`](../../src/gates/)
- Bundle adapter: [`src/adapters/mcpb-adapter/`](../../src/adapters/mcpb-adapter/)
- Sprint status note on Story 6.6 obsolescence: [`sprint-status.yaml`](../../_bmad-output/implementation-artifacts/sprint-status.yaml)
