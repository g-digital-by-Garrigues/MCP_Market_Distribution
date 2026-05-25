# Release checklist (v1.1+ per-MCP-repo model)

The canonical "what to do before you push the tag" checklist for any MCP source repo (`EAD-Factory-MCP`, `GoCertius_MCP`, `EAD_Enterprise_Suite_MCP`, or future portfolio additions). Follow it for every release — patch, minor, or major.

This document combines [Story 6.1](../../_bmad-output/planning-artifacts/epics.md#story-61-author-npm-trusted-publisher-setup-runbook) (npm Trusted Publisher setup) and Action Item A1 from the [Epic 7 retrospective](../../_bmad-output/implementation-artifacts/epic-7-retro-2026-05-24.md).

## Why this checklist exists

In the v1.1 per-repo model, the pipeline (`MCP_Market_Distribution/publish.yml`) clones the source MCP at the `v<version>` tag at workflow time. **Whatever lives at that tag is what reaches every store.** If the tag points at a commit with stale artifacts, the pipeline ships the stale artifacts — silently, in some cases (see "Anti-patterns" below).

The two failure modes we've already hit:
- **Stale `server.json` at the tag**: the v1.1.0 tag was created after `package.json` was bumped but **before** `server.json` was bumped. The pipeline cloned a tag where `server.json` still said `1.0.0`; the MCP Official Registry correctly rejected the publish as a duplicate of the already-published v1.0.0; the pipeline silently marked it as `skipped`. Fixed in `publish-mcp-registry` (PR #139) by detecting the mismatch and failing loudly — but the operator-facing fix is **always run `/prep-mcp` before tagging** so this case never arises.
- **Missing Trusted Publisher for n8n adapter package**: OIDC publish failed because `@g-digital/n8n-nodes-*` was created on npm but had no Trusted Publisher configured. Configure both the main MCP package AND its n8n adapter package — they're independent npm packages.

## Pre-release checklist

Run through this in order. Each step has a verification command — if the command fails, fix it before moving on.

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

```bash
git checkout main
git pull
git tag v<version>
git push origin v<version>
```

**The tag must be created from `main` AFTER the PR is merged.** A tag created before the merge will point at the pre-merge commit and the pipeline will clone stale artifacts.

If you created the tag too early, see "Recovery: fixing a tag that points at a stale commit" below.

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

## See also

- [`setup-day1.md`](./setup-day1.md) — initial repo setup via setup-helper Claude Code skills
- [`dry-run-mode.md`](./dry-run-mode.md) — running the pipeline in dry-run for verification without publishing
- [`init-state-branch.md`](./init-state-branch.md) — bootstrapping the `releases/state` orphan branch
- [Epic 7 retrospective](../../_bmad-output/implementation-artifacts/epic-7-retro-2026-05-24.md) — origin of this checklist's lessons
