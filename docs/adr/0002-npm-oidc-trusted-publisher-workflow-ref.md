# ADR 0002 — npm OIDC Trusted Publisher uses `workflow_ref` (caller), not `job_workflow_ref` (reusable workflow)

**Status:** accepted
**Date:** 2026-05-24

## Context

The pipeline publishes scoped packages (`@g-digital/mcp-*`, `@g-digital/n8n-nodes-*`) to npm using **GitHub OIDC Trusted Publishers** — the operator configures a (repo, workflow) pair on `npmjs.com/<package>/access`, and npm validates that the GitHub OIDC token at publish time was issued by that exact (repo, workflow) pair.

In our v1.1 per-MCP-repo model, the flow is:

1. Engineer pushes `v*` tag to `EAD-Factory-MCP` (or one of the other source MCP repos).
2. `EAD-Factory-MCP/.github/workflows/publish.yml` fires.
3. That workflow uses `workflow_call` to invoke `g-digital-by-Garrigues/MCP_Market_Distribution/.github/workflows/publish.yml@main`.
4. The reusable pipeline does the actual `npm publish --provenance`.

The OIDC token GitHub mints for that publish run carries **two** workflow-identity claims:

| Claim | Value in our case |
|---|---|
| `workflow_ref` | `g-digital-by-Garrigues/EAD-Factory-MCP/.github/workflows/publish.yml@refs/tags/v1.0.12` (the **caller**) |
| `job_workflow_ref` | `g-digital-by-Garrigues/MCP_Market_Distribution/.github/workflows/publish.yml@refs/heads/main` (the **reusable workflow**) |

npm's Trusted Publisher checks **only `workflow_ref`** against the configured pair. The pipeline repo and the caller repo are different here; only one of them can match.

During the ead-factory v1.0.12 OIDC test (run [#26355812899](https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP/actions/runs/26355812899)) we tried both configurations to determine empirically which one npm enforces:

- **Repository = `MCP_Market_Distribution`, workflow = `publish.yml`** → 404 (rejected — claim doesn't match `workflow_ref`).
- **Repository = `EAD-Factory-MCP`, workflow = `publish.yml`** → success (claim matches `workflow_ref`).

The community-reported behaviour (collected during the OIDC investigation, summarised by the Gemini search Hugo ran) corroborates: npm uses `workflow_ref`.

## Decision

Configure the npm Trusted Publisher for **every scoped package** against the **source MCP repository** that triggers the publish, not against `MCP_Market_Distribution`.

| Package | Repository | Workflow |
|---|---|---|
| `@g-digital/mcp-ead-factory` | `g-digital-by-Garrigues/EAD-Factory-MCP` | `publish.yml` |
| `@g-digital/n8n-nodes-ead-factory` | `g-digital-by-Garrigues/EAD-Factory-MCP` | `publish.yml` |
| `@g-digital/mcp-ead-enterprise-suite` | `g-digital-by-Garrigues/EAD_Enterprise_Suite_MCP` | `publish.yml` |
| `@g-digital/n8n-nodes-ead-enterprise-suite` | `g-digital-by-Garrigues/EAD_Enterprise_Suite_MCP` | `publish.yml` |
| `@g-digital/mcp-gocertius` | `g-digital-by-Garrigues/GoCertius_MCP` | `publish.yml` |
| `@g-digital/n8n-nodes-gocertius` | `g-digital-by-Garrigues/GoCertius_MCP` | `publish.yml` |

The publisher's error-remediation message uses `process.env.GITHUB_REPOSITORY` (the caller repo at runtime) to name the correct repository in the action text, rather than hardcoding any single repo.

## Consequences

**Wins:**
- OIDC publishes succeed without `NPM_TOKEN` for all 6 scoped packages.
- Onboarding a new MCP requires one Trusted Publisher entry per scoped package; the pattern is mechanical.

**Trade-offs:**
- A single MCP repo with two scoped packages (main + n8n adapter) needs **two** Trusted Publisher configurations on npm. This is easy to forget — the symptom is a 404 on the n8n publish step the first time the new MCP releases. The release checklist runbook calls this out explicitly.
- The pipeline repo (`MCP_Market_Distribution`) is **not** a Trusted Publisher for any package. If we ever wanted to publish from `MCP_Market_Distribution` directly (e.g. a pipeline-internal package), we'd need to add it then.

**Why this is non-obvious:**
- The intuition that the **reusable workflow's** identity is what matters (since that's where the publish code actually runs) is wrong. GitHub's OIDC design treats `workflow_ref` as "who triggered this run" — and Trusted Publishers verifies that, not "what code did the publishing".
- The runtime evidence is opaque from the error response (404 looks like "not configured" rather than "configured for the wrong repo"). We discovered this by trying both configurations.

## References

- ead-factory v1.0.12 publish run (successful with this configuration): [#26355812899](https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP/actions/runs/26355812899)
- npm OIDC Trusted Publishers docs: https://docs.npmjs.com/trusted-publishers
- GitHub OIDC token claims reference: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect
- Publisher's error-remediation code (uses GITHUB_REPOSITORY at runtime): [`src/publishers/publish-npm.ts`](../../src/publishers/publish-npm.ts) (`remediationForNpmFailure`)
- Same fix for n8n publisher: [`src/publishers/publish-n8n.ts`](../../src/publishers/publish-n8n.ts) (`remediationForNpmFailure`)
- Release checklist runbook (operator-facing instruction): [`docs/runbooks/release-checklist.md`](../runbooks/release-checklist.md)
- Epic 7 retrospective (origin of this learning): [`epic-7-retro-2026-05-24.md`](../../_bmad-output/implementation-artifacts/epic-7-retro-2026-05-24.md)
