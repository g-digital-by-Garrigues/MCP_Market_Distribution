# Release checklist (v1.1+ per-MCP-repo model)

The canonical "what to do before you push the tag" checklist for any MCP source repo (`EAD-Factory-MCP`, `GoCertius_MCP`, `EAD_Enterprise_Suite_MCP`, or future portfolio additions). Follow it for every release — patch, minor, or major.

This document combines [Story 6.1](../../_bmad-output/planning-artifacts/epics.md#story-61-author-npm-trusted-publisher-setup-runbook) (npm Trusted Publisher setup) and Action Item A1 from the [Epic 7 retrospective](../../_bmad-output/implementation-artifacts/epic-7-retro-2026-05-24.md).

## Why this checklist exists

In the v1.1 per-repo model, the pipeline (`MCP_Market_Distribution/publish.yml`) clones the source MCP at the `v<version>` tag at workflow time. **Whatever lives at that tag is what reaches every store.** If the tag points at a commit with stale artifacts, the pipeline ships the stale artifacts — silently, in some cases (see "Anti-patterns" below).

The six failure modes we've already hit:
- **Stale `server.json` at the tag**: the v1.1.0 tag was created after `package.json` was bumped but **before** `server.json` was bumped. The pipeline cloned a tag where `server.json` still said `1.0.0`; the MCP Official Registry correctly rejected the publish as a duplicate of the already-published v1.0.0; the pipeline silently marked it as `skipped`. Fixed in `publish-mcp-registry` (PR #139) by detecting the mismatch and failing loudly — but the operator-facing fix is **always run `/prep-mcp` before tagging** so this case never arises.
- **Missing Trusted Publisher for n8n adapter package**: OIDC publish failed because `@g-digital/n8n-nodes-*` was created on npm but had no Trusted Publisher configured. Configure both the main MCP package AND its n8n adapter package — they're independent npm packages.
- **Dockerfile / transport contract mismatch** (2026-05-26): EAD_Enterprise_Suite_MCP v1.2.0–1.2.2 and GoCertius_MCP v1.1.0–1.1.2 all failed Track A Layer 3. The Dockerfile (from `@suite/generator` template) declared `HEALTHCHECK CMD fetch http://localhost:8080/healthz` but did NOT set `ENV MCP_TRANSPORT=http`. `selectTransport()` defaults to stdio when the env is unset → port 8080 stays closed → HEALTHCHECK times out at 60s. ead-factory works because its Dockerfile bakes `ENV TRANSPORT=http`. Generator template fixed in `@suite/generator` PR #15. **The contract**: if your Dockerfile's HEALTHCHECK probes HTTP, your container MUST bake the transport env so the HTTP listener actually starts.
- **Docker Hub anonymous pull rate-limit**: same 2026-05-26 incident. `docker build` failed at `[auth] library/node:pull token` because Layer 3 had no `docker/login-action` and the runner's shared IP had exhausted the anonymous quota. Fixed in pipeline PR #150 by authenticating before every L3 build using `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN`.
- **n8n adapter template/src changes not verified locally** (2026-05-28, Epic 12; recurred twice in 2026-07-16 Epic 13 releases): the generated node's `tsc` errors are only caught by Track B Layer 2 (compile), which runs **only on a real publish of a not-yet-published version**. EAD Factory v1.2.0 shipped the MCP server to all 7 stores but the node failed to compile (`TS2872` — `QUERY_PARAM_STYLE` went always-truthy once `query_param_style: flat` was set), forcing a v1.2.1 recovery. The v1.2.0 fix then broke the *single-API* case (`'' === 'flat'` → `TS2367`), caught on gocertius **before** tagging by the check below. **The verification must replicate the gate EXACTLY** — a loose check hides the error:
  - ❌ `ts.transpileModule` does not typecheck at all.
  - ❌ `npm install` + `tsc --strict false` (or a `tsc` that can't resolve `n8n-workflow` + `@types/node`) does not raise `TS2872`/`TS2367` and floods you with false module errors.
  - ✅ Replicate Track B L2: **`pnpm install --no-frozen-lockfile`** then **`./node_modules/.bin/tsc --noEmit`** (strict, deps resolved) in the generated node dir. Run it for EACH product — a single-API product (gocertius/ead-es) and a multi-manager one (ead-factory) exercise different template branches.
  ```bash
  # 1. Generate the adapter for a real MCP (requires built MCP dist):
  pnpm tsx src/adapters/n8n-adapter/run-adapter-build.ts <mcp_name> <version> <package_dir> /tmp/adapter-check
  # 2. Compile it the way the gate does — pnpm (not npm), strict tsc, deps resolved:
  cd /tmp/adapter-check && pnpm install --no-frozen-lockfile >/dev/null 2>&1
  ./node_modules/.bin/tsc --noEmit && echo "EXIT 0 — clean"
  # (run tsc separately from install: pnpm install exits non-zero on the isolated-vm
  #  ignored-build warning, which is not a compile error.)
  ```

## Pre-release checklist

Run through this in order. Each step has a verification command — if the command fails, fix it before moving on.

### 0. Confirm the source repo is Phase-A-current (before you bump anything)

Phase B (bump → tag → publish) is the **pipeline's** job. Phase A (regenerate + propagate the source from `@suite/generator`) is the **generator team's** job (Model B, MCP_Market_Distribution#212 — a pipeline-side PR that regenerates source was closed for crossing that boundary: GoCertius_MCP#69 / EAD_Enterprise_Suite_MCP#71). **Never bump a source repo whose Phase A is stale — you would publish artifacts from an old generator snapshot.**

Check the source `@main` before bumping:

```bash
# 1. .distribution.yaml must be freshly generated — NOT the 1970 epoch placeholder.
gh api "repos/g-digital-by-Garrigues/<repo>/contents/.distribution.yaml?ref=main" \
  -H "Accept: application/vnd.github.raw" | grep -i "Generated:"
#   Bad:  "Generated: 1970-01-01"  → generated by an ancient generator; Phase A is stale.
#   Good: a recent date (e.g. 2026-07-16).
```

The `n8n-node/` mirror `@main` will still be pre-epic before you bump — that is expected, because it is **distribution-owned** and your Phase B regenerates it. The reliable "is Phase A current?" signal is the `.distribution.yaml` date, not the mirror.

If the date is stale (1970 / months old), **stop and ask the generator team to run Phase A** (regenerate from the current generator `@main` and open a source-only propagation PR). Only bump once that PR is merged. This is what EAD Factory (#32), gocertius (#80) and ead-enterprise-suite (#81) each needed before their Epic 13 bumps.

### 1. Decide the version

Pick the next semver based on what's changed since the last `v*` tag:

- **patch** (1.0.x → 1.0.(x+1)) — bug fixes only, no API changes
- **minor** (1.x.0 → 1.(x+1).0) — new features, backwards compatible, no breaking changes
- **major** (x.0.0 → (x+1).0.0) — breaking changes

Verify the last release:
```bash
git tag --sort=-v:refname | head -5
```

### 2. Run `/prep-mcp` to regenerate all artifacts

```bash
/prep-mcp <mcp-name> <new-version>
```

This regenerates atomically:
- `package.json#version`
- `server.json` (MCP Registry manifest)
- `smithery.yaml`
- `install-blocks/*.md` (all 8 client install blocks)
- The auto-generated sections in `README.md`
- The n8n adapter tree at `pending-to-publish/<mcp>/_n8n-adapter/`

**Why this is non-negotiable:** every artifact must declare the same version. Manual bumps that touch only `package.json` will publish to npm fine but fail (silently in some cases) at the MCP Registry, Smithery, or n8n.

### 3. Inspect the diff and commit

```bash
git diff
git add -A
git commit -m "chore: bump to v<version>"
```

If the diff includes more than the version field updates, review the new generated content for surprises.

### 4. Open a PR, get it merged

The PR must merge to `main` before the tag is created. Tags don't trigger from PR branches.

### 5. Verify Trusted Publishers exist on npm

For both packages this MCP will publish:
- `@g-digital/mcp-<name>` → main MCP package
- `@g-digital/n8n-nodes-<name>` → n8n community adapter

Both need a Trusted Publisher configured at npmjs.com:

| Package access URL | Repository | Workflow |
|---|---|---|
| `https://www.npmjs.com/package/@g-digital/mcp-<name>/access` | `g-digital-by-Garrigues/<source-mcp-repo>` | `publish.yml` |
| `https://www.npmjs.com/package/@g-digital/n8n-nodes-<name>/access` | `g-digital-by-Garrigues/<source-mcp-repo>` | `publish.yml` |

> **Critical fact about `workflow_call` and OIDC:** the OIDC token's `workflow_ref` claim is the **caller's** workflow ref (your source MCP repo's `publish.yml`), not the reusable workflow (`MCP_Market_Distribution/publish.yml`). Configure the Trusted Publisher against the source MCP repo. We tested this on ead-factory v1.0.12 with no `NPM_TOKEN` in the org and the OIDC publish succeeded for both packages.

If either Trusted Publisher is missing or wrong, the npm step will fail with a 404. The publisher's `cause` and `action` fields will name the correct (repo, workflow) pair to configure.

### 6. Create and push the tag — pointing at `main` HEAD

**Canonical path is `git push`. Do not mix triggers.**

```bash
git checkout main
git pull
git tag v<version>
git push origin v<version>
```

**The tag must be created from `main` AFTER the PR is merged.** A tag created before the merge will point at the pre-merge commit and the pipeline will clone stale artifacts.

**Do not also fire `gh workflow run publish.yml ...` in the same release.** When GitHub Actions is healthy, both `gh api .../git/refs -X POST` AND `gh workflow run` produce a run each. The `concurrency` block in `publish.yml` (group `publish-<mcp>-<version>`, `cancel-in-progress: false`) serializes them so they never race, but the second run is wasted work and noise. Pick one trigger; the tag push is the canonical one. Use `workflow_dispatch` only for manual re-runs of an already-tagged release.

If you created the tag too early, see "Recovery: fixing a tag that points at a stale commit" below.

## After merging a PIPELINE change to `main` (before any release)

`regression-e2e` on a PR is shallow: it runs `publish.yml@main` (not the PR's code) against each source's already-published `@main` version, so the ledger skips the deep gates (Track A L2/L3, Track B, Track C) as idempotent. **The deep gates first see your merged code on the post-merge run.** So after every merge of a pipeline change:

1. Open the `regression-e2e` run for the merge commit (`gh run list --branch main --workflow regression-e2e.yml --limit 1`).
2. Confirm it is green — and that the jobs you expected to exercise actually ran, not skipped. A merge that skips everything as idempotent proves nothing.
3. If red, it is ours to fix (it runs in this repo). Do not start a release on top of an unverified pipeline change.

See `docs/n8n-adapter-contract.md` → "Verify CI yourself" for the full rationale.

## Post-publish verification

After the tag push fires the pipeline (~15-20 min for a full run):

### 7. Check the release report

Open the latest release report in `_bmad-output/release-reports/<mcp>-v<version>.md` (committed back to `MCP_Market_Distribution/main` by the pipeline). Every target row should be `✅ succeeded` or `⏭ skipped` (idempotent). Investigate any `❌ failed` row.

### 8. Spot-check the live URLs

| Store | URL pattern |
|---|---|
| npm | `https://www.npmjs.com/package/@g-digital/mcp-<name>` |
| Docker Hub | `https://hub.docker.com/r/gdigital/<name>` |
| MCP Official Registry | `https://registry.modelcontextprotocol.io/v0/servers/io.github.g-digital-by-Garrigues%2F<name>` |
| Smithery | `https://smithery.ai/server/g-digital/<name>` |
| n8n npm | `https://www.npmjs.com/package/@g-digital/n8n-nodes-<name>` |

The Docker MCP Catalog, Cline Marketplace, and mcp.so submissions are open queues — they'll only show the new version after maintainer review.

## Recovery: fixing a tag that points at a stale commit

**Do not force-move the tag.** Moving published tags rewrites the SHA they point at, which can break caches, CDN mirrors, downstream consumers, and GitHub releases. The safer pattern: **bump again to the next patch version**.

Example: v1.1.0 tag points at a commit where `server.json` was still `1.0.0`. Instead of moving the tag:

1. Open a PR bumping to `v1.1.1` (covers both `package.json` AND `server.json`, ideally via `/prep-mcp`).
2. Merge.
3. Tag `v1.1.1` from the merge commit and push.
4. The pipeline runs end-to-end; everything that was already at v1.1.0 (npm, Docker Hub) skips idempotently; the registry/store that was missing v1.1.0 gets v1.1.1.

The "gap" in version coverage (no v1.1.0 in the registry but v1.1.1 is there) is acceptable. The MCP Official Registry doesn't require every npm version to be registered — it just needs the latest.

## Anti-patterns

These are things we've done that you should not do:

- **Bumping only `package.json` manually.** Always go through `/prep-mcp` so every artifact bumps atomically. The MCP Registry will silently reject the publish if `server.json` is stale.
- **Tagging before the bump PR merges.** The tag will point at the pre-merge commit. The pipeline clones the tag, not `main`.
- **Configuring the Trusted Publisher against `MCP_Market_Distribution`.** The OIDC token's `workflow_ref` is the caller (your source repo). Configure against the source MCP repo.
- **Setting `NPM_TOKEN` permanently in the org.** Use OIDC. Restore `NPM_TOKEN` only for the bootstrap first-ever publish of a new package; remove it once the Trusted Publisher is configured.
- **Force-moving published tags.** Bump to the next patch instead.
- **Templating a Dockerfile without confirming it matches the source's transport defaults.** If `HEALTHCHECK` probes HTTP, the Dockerfile MUST bake the transport env (`ENV MCP_TRANSPORT=http` for generated MCPs, `ENV TRANSPORT=http` for ead-factory). Otherwise Layer 3 times out at 60s with the container never reaching `healthy`.
- **Mixing trigger paths in the same release.** Either `git push origin <tag>` OR `gh workflow run publish.yml --ref main -f version=...` — not both. Both fire independently when GitHub Actions is healthy.
- **Reflex retries when something fails.** After ~3 failed attempts on the same stage, stop and audit: read the gate output (cap is 2000 chars from the TAIL, so the real error IS there), compare against ead-factory's working setup, identify the contract you're violating. Iterating without diagnosis is how a 30-min release becomes a 4-hour debugging session.

## If something goes wrong: where to look

Common failure surfaces and the first thing to check:

| Symptom | Likely cause | First thing to check |
|---|---|---|
| Setup job: "Remote branch v\<x.y.z\> not found" | Tag doesn't exist on GitHub | `git push origin v<version>` after merging the bump PR |
| Setup job: unit tests fail | Pipeline changes broke existing tests OR pipeline ref isn't up to date | Check the failed test name; if it's in `tests/unit/`, fix the test in pipeline and re-merge |
| Track A Layer 1: `hasMismatch: true` | `server.json#version` (or other artifact) doesn't match expected version | `/prep-mcp` wasn't run on the bump commit. Bump to next patch with full `/prep-mcp` regeneration |
| Track A Layer 3: `docker build failed (exit 1): #2 [auth] library/node:pull token` | Docker Hub anon pull rate-limit hit; `docker/login-action` not configured | Verify `DOCKERHUB_USERNAME` + `DOCKERHUB_TOKEN` org secrets exist; pipeline #150 added the login step in L3 |
| Track A Layer 3: `ERR_PNPM_NO_LOCKFILE` | Dockerfile uses pnpm but project is npm | Rewrite Dockerfile to use `npm ci`. Long-term fix: PR to `@suite/generator` template |
| Track A Layer 3: `Container did not reach 'healthy' within 60s` | Dockerfile HEALTHCHECK probes HTTP but `MCP_TRANSPORT` not set | Add `ENV MCP_TRANSPORT=http` (or `TRANSPORT=http` for ead-factory) to Dockerfile, bump patch, re-tag |
| Any publisher: `401`/`403` | Missing secret OR wrong scope | Check the publisher's `cause`/`action` field; verify the named secret exists in the org and has the right scope (e.g. `SMITHERY_TOKEN` for `g-digital/*`, `BOT_PAT` with `public_repo`+`workflow`+`issues:write`) |
| publish-npm: `E404` on a brand-new package | Trusted Publisher not yet configured (impossible before first publish) | First publish: temporarily set `NPM_TOKEN` org secret with `@g-digital/*` scope. After first publish, add Trusted Publisher entry on npmjs.com keyed to the source repo's `publish.yml`, then remove `NPM_TOKEN` |
| publish-mcp-registry: `package-ownership verification failed: mcpName field missing in npm package` | `package.json` doesn't declare `mcpName` field matching `server.json#name` | Add `"mcpName": "io.github.g-digital-by-Garrigues/<name>"` to `package.json`, bump patch |

Two reasons we keep hitting "L3 timeout / build failed":
1. **Gate output was historically truncated to 200 chars** (the truncation cut off before the actual error). Pipeline #151/#153 widened to 2000 chars taken from the **tail** of stderr — the real error is in the gate's PR comment now. Read it first.
2. **The Dockerfile template's contract with the source MCP's transport selection is not statically validated.** Pre-flight check for this is on the backlog (Phase 3 of the 2026-05-26 audit).

## See also

- [`setup-day1.md`](./setup-day1.md) — initial repo setup via setup-helper Claude Code skills
- [`dry-run-mode.md`](./dry-run-mode.md) — running the pipeline in dry-run for verification without publishing
- [`init-state-branch.md`](./init-state-branch.md) — bootstrapping the `releases/state` orphan branch
- [Epic 7 retrospective](../../_bmad-output/implementation-artifacts/epic-7-retro-2026-05-24.md) — origin of this checklist's lessons
