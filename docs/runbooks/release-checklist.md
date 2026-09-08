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

Run through this in order. The order is the point: every step here depends only on steps above it. Each step has a verification command — if the command fails, fix it before moving on.

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

### 1. Trust `origin/main` only after checking the clone's refspec

This is first because everything below it edits a working tree you have to be able to trust.

A clone made at a tag (`git clone --branch v1.0.0 --single-branch`) keeps a **narrowed fetch refspec**, so `git fetch origin` never updates `refs/remotes/origin/main` — it stays frozen at whatever the clone started from, silently, forever. On 2026-07-22 `pending-to-publish/{gocertius,ead-enterprise-suite}` were in exactly that state: `git reset --hard origin/main` threw both trees back to an ancient commit (`package.json` still 1.0.0) and produced release tags pointing at the wrong commit. Caught before pushing, by luck.

```bash
git config --get remote.origin.fetch
#   Good: +refs/heads/*:refs/remotes/origin/*
#   Bad:  +refs/tags/v1.0.0:...   or   +refs/heads/main:...   (narrowed)

# Repair, then re-sync:
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch origin --prune

# Belt and braces — the local ref must match the remote:
[ "$(git rev-parse origin/main)" = "$(git ls-remote origin refs/heads/main | cut -f1)" ] && echo OK
```

### 2. Decide the version

Pick the next semver based on what's changed since the last `v*` tag:

- **patch** (1.0.x → 1.0.(x+1)) — bug fixes only, no API changes
- **minor** (1.x.0 → 1.(x+1).0) — new features, backwards compatible, no breaking changes
- **major** (x.0.0 → (x+1).0.0) — breaking changes

Verify the last release:
```bash
git tag --sort=-v:refname | head -5
```

### 3. Set the version by hand in `package.json`

**Yes, you are editing a generator-owned file, and that is the one place you may.**
`package.json` sits under `generator:` in every published repo's `.artifact-owners.yaml`
— the same table this document cites below as the authority for where the release note
may live — so the rule you should read into this step is *not* "generator ownership is
advisory". It is a **field-level carve-out**, agreed with generation on 2026-09-07 and
made machine-readable on their side: `.artifact-owners.yaml` gains `field_exceptions`
and its `artifact_owners_schema_version` goes **1 → 2**, assigning `package.json#version`
to distribution. `version` is the **only** field carved out, and nothing else in that
file — not `files`, not `dependencies`, not `scripts` — is yours to touch. If you find
yourself wanting to hand-edit another generator-owned path, this step is not the
precedent: raise it with generation and get it into `field_exceptions` first.

(The `files` glob that `ensureSkillBundle` rewrites was proposed as a second exception
and **withdrawn** — both sides verified the rewrite is a genuine no-op, so it never
diverges from what generation emitted. Until the schema bump propagates, any gate that
reads `.artifact_owners_schema_version` must read it from the manifest, never pin it.)

`/prep-mcp` does **not** bump the version — it **reads** it. The resolved version comes from `pending-to-publish/<mcp-name>/package.json#version` and feeds everything downstream (`server.json`, `smithery.yaml`, the install blocks, the n8n node); the only reason prep rewrites `package.json` at all is to pass the bundled-skills `files` glob through `ensureSkillBundle`, which never touches `version`. Leave the version alone and prep will faithfully regenerate every artifact at the version you already published.

```bash
cd pending-to-publish/<mcp>
# Edit package.json#version to the version you decided in step 2, then:
grep -m1 '"version"' package.json
```

### 4. Write the release note at `.github/RELEASE_NOTES.md`

**Required on every real publish, of every product, including the first one** — and it has to exist now, because the n8n connector README is rendered from it in step 6. See [Writing the release note](#writing-the-release-note) below for the contract and a worked example. The pipeline fails the run in its very first job if the file is missing, unparseable, still names the previous version, or carries no `N8N_UPGRADE` span.

**This step is not optional and it is not scoped to one product.** As of 2026-09-07 none of `EAD-Factory-MCP`, `GoCertius_MCP` or `EAD_Enterprise_Suite_MCP` has ever carried `.github/RELEASE_NOTES.md` at `origin/main`, so the FIRST release of each of the three has to write it on the bump branch. There is no exemption to fall back on: skipping this step fails the run in `setup`, before pre-flight, before Track A, before anything external happens. Every dry-run now prints a `⚠️` advisory block naming the missing note, so the gap shows up before the release rather than during it.

```bash
# In the MCP source repo, on the bump branch:
$EDITOR .github/RELEASE_NOTES.md

# From the pipeline repo, the same check the `setup` job runs:
pnpm tsx src/ci/check-release-notes.ts pending-to-publish/<mcp> <new-version>
```

### 5. Rebuild the MCP's `dist/` and align the lockfile

Both of these bit the Epic 17 releases and neither is covered by `/prep-mcp`. Both must happen **before** prep, not after.

**Rebuild the MCP's `dist/` before trusting any n8n pre-flight.** The n8n adapter is generated by *launching the built MCP server* and asking it for `tools/list`, so a stale `dist/` produces a *green* pre-flight against code that no longer exists — and mirrors yesterday's operation list into today's connector. On 2026-07-22 the committed `dist/` was five days old. Use `npm`, matching CI's "Install + build MCP source" step exactly: all three source repos ship a `package-lock.json` and no `pnpm-lock.yaml`.

```bash
cd pending-to-publish/<mcp>
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build
```

**Align the lockfile with `package.json`.** You bumped the version by hand in step 3 and nothing touched the lockfile, so the two drift silently — `ead-factory` went out with a lockfile still declaring the previous version.

```bash
grep -m1 '"version"' package.json package-lock.json   # must agree
npm install --package-lock-only                       # re-align if they do not
```

### 6. Run `/prep-mcp` to regenerate all artifacts

```bash
/prep-mcp <mcp-name> --skip-tag
```

**Always pass `--skip-tag`.** `skipTag` defaults to `false`, and since #241 prep commits and tags **inside the source clone** — so an unflagged run creates the `v<version>` tag at the *pre-merge* commit, the exact anti-pattern this document forbids two sections down. The tag is never pushed, so the damage is local, but the next `git tag v<version>` then fails "already exists"; the fix for that is `git tag -d v<version>` in the source clone, **not** a version bump.

The command takes one positional (the MCP name) plus `--skip-commit` / `--skip-tag`. A second positional is silently discarded, so a version passed here does nothing at all.

`--skip-commit` is **no longer** needed. The Epic 17 known issue "use `--skip-commit` and commit in the source clone by hand until this is fixed" is **obsolete**: #241 made prep commit inside the source clone itself, and an integration test pins that behaviour. Only `--skip-tag` is still required.

This regenerates atomically, at the version it read from `package.json`:
- `server.json` (MCP Registry manifest)
- `smithery.yaml`
- `install-blocks/*.md` (all 8 client install blocks)
- The auto-generated sections in `README.md`
- The n8n adapter tree at `pending-to-publish/<mcp>/n8n-node/`

**Why this is non-negotiable:** every artifact must declare the same version. Bumping only `package.json` and skipping prep will publish to npm fine but fail (silently in some cases) at the MCP Registry, Smithery, or n8n.

**Check that `n8n-node/` was actually written.** `prep-mcp` stops the bump (exit 1, `step: generate-n8n-adapter`) when the adapter REFUSES the contract — an unmatched auth style, an operation that matched no resource, an unparseable `.github/RELEASE_NOTES.md`. It still continues, non-fatally, when the source MCP cannot be **launched** (unbuilt `dist/`, missing deps): it prints `[prep-mcp] Warning: could not launch '<mcp>' to build the n8n adapter`, leaves `n8n-node/` **absent** and exits 0. So an absent or unchanged `n8n-node/` is still a failure, not a pass — check for it.

```bash
ls -la pending-to-publish/<mcp>/n8n-node/
grep -m1 '"version"' pending-to-publish/<mcp>/n8n-node/package.json
grep -n "Upgrading from 1.x" pending-to-publish/<mcp>/n8n-node/README.md   # your note, rendered
```

### 7. Inspect the diff and commit

```bash
git diff
git add -A
git commit -m "chore: bump to v<version>"
```

If the diff includes more than the version field updates, review the new generated content for surprises.

### 8. Open a PR, get it merged

The PR must merge to `main` before the tag is created. Tags don't trigger from PR branches. The PR carries the bump, the regenerated artifacts **and** `.github/RELEASE_NOTES.md`, so the note rides the tag.

### 9. Verify Trusted Publishers exist on npm

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

### 10. Create and push the tag — pointing at `main` HEAD

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

## Writing the release note

**Where.** `.github/RELEASE_NOTES.md`, in the **MCP source repo**, written on the bump branch so it rides the tag the pipeline clones. Not at the repo root: each published repo's `.artifact-owners.yaml` lists `.github/` under `distribution:` and ends with `unlisted: forbidden`, so a new root file would be a contract violation. `README.md` cannot hold it either — prep assembles that file from the generator-owned `README.template.md` and overwrites it wholesale on every run, so anything hand-added there is destroyed on the next release.

**Required, on every real publish.** The `setup` job runs `src/ci/check-release-notes.ts` before pre-flight and before any publisher, and fails the run when the file is absent, unparseable, when its first non-blank line does not name `v<version>` — the stale-note failure mode, a 1.9.0 note that rode along to the 2.0.0 tag — or when it carries no `N8N_UPGRADE` span. This is deliberate fail-closed design: the reason there were **zero** GitHub Releases on GoCertius and EAD Enterprise Suite on 2026-09-07, and EAD Factory's newest was `v1.0.11` (2026-05-21) against npm's 1.3.1, is that the surface was optional. A patch release with nothing to say writes four lines.

The version match is bounded, not a substring: a note titled `# v2.0.0-rc.1` does **not** satisfy a 2.0.0 publish, and `# v1.2.30` does not satisfy 1.2.3. A left-behind release-candidate note is a stale note.

**Two runs are advisory instead of fail-closed**, and only two: a **dry-run** (it clones `main` and publishes nothing) and a **retry** (`/retry-publish`, which dispatches with `release_note_check: advisory`). A retry targets a tag that already exists; the note has to ride that tag; so demanding one from a retry would mean re-tagging a published version, which this document forbids. An advisory run prints the same report plus a `::warning::` and a step-summary block, and the `github-release` job then **skips** the Release rather than inventing a body — the pipeline never writes release text nobody authored. Everything else — every fresh publish — stays fail-closed. If you dispatch `publish.yml` by hand to re-run an old release, set `release_note_check: advisory` yourself; the default is `enforce`.

**One file, two audiences.**

| Surface | Gets | Audience |
|---|---|---|
| The GitHub Release on the source repo | the whole file, minus the two marker lines | the server operator, who has a `.env` |
| The n8n connector `README.md` → "Upgrading from 1.x" | only the span between the markers | the n8n user, who has no `.env` and cannot act on a variable name alone |

**The marker contract.**

```md
# <Product> MCP v<version>

Whatever the server operator needs to know.

<!-- N8N_UPGRADE -->
Whatever the n8n user needs to do. Inserted verbatim: no re-wrapping, no escaping.
<!-- /N8N_UPGRADE -->
```

Both markers, each on its own line; the span may not be blank; and inside the span the shallowest heading allowed is `###`, because the span is rendered underneath `## Upgrading from 1.x` and a `#` or `##` would escape that section.

The span is **mandatory on a real publish**. The parser still accepts a markerless note — a local `/prep-mcp` of a product that has not written one yet must keep working — but `setup` rejects it, because the alternative is a connector README that ships its "Upgrading from 1.x" section empty on a breaking release. When there is genuinely nothing to do, say exactly that in one line; the n8n user has no `.env` and no changelog, so "nothing to do beyond upgrading the community node" is information they do not otherwise have.

**Write it before you run `/prep-mcp`** (step 4, not step 7). The connector README is rendered from the span during prep, so a note written afterwards reaches the GitHub Release and *not* the connector.

**Worked example.** `tests/fixtures/release-notes/gocertius-2.0.0.md` and `tests/fixtures/release-notes/ead-enterprise-suite-2.0.0.md` in this repo are the real Epic 18 2.0.0 notes: two breaking changes told as siblings rather than one buried inside the other, the mandatory variables in a table with their secret / not-secret status, and the counts re-derived from the source rather than copied. Read one before writing your first note. They are a *dated example*, not a second checklist to keep in sync — the hardcoded lists in this document are what went stale twice.

## After merging a PIPELINE change to `main` (before any release)

`regression-e2e` on a PR is shallow: it runs `publish.yml@main` (not the PR's code) against each source's already-published `@main` version, so the ledger skips the deep gates (Track A L2/L3, Track B, Track C) as idempotent.

**Corrected 2026-09-02:** this section used to say "the deep gates first see your merged code on the post-merge run", and told you to open that run. **There was no post-merge run.** `regression-e2e` triggered on `pull_request` and `workflow_dispatch` only, so the instruction pointed at something that never happened — and between 2026-07-22 and 2026-09-02 nothing ran it at all, which is why a schema break kept prep/bump/publish down for all three products, unseen, for six weeks. What exists now:

| After a merge to `main` | Runs how | Covers |
|---|---|---|
| `ci` | automatically, on `push` to `main` | typecheck + unit/integration tests + lint, on the merged code (this includes the n8n official linter, driven for real by the Track B L1 integration test) |
| `regression-e2e` | **manually**, or the Monday 06:00 UTC schedule | the deep gates against the real source repos |

So after every merge of a pipeline change:

1. Confirm the `ci` run for the merge commit is green (`gh run list --branch main --workflow ci.yml --limit 1`). It is automatic.
2. Before any release, dispatch the sweep yourself rather than waiting for Monday: `gh workflow run regression-e2e.yml --ref main`, then `gh run watch <id> --exit-status`.
3. Confirm it is green — and that the jobs you expected to exercise actually ran, not skipped. A merge that skips everything as idempotent proves nothing.
4. If red, it is ours to fix (it runs in this repo). Do not start a release on top of an unverified pipeline change.

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
| GitHub Release | `https://github.com/g-digital-by-Garrigues/<source-mcp-repo>/releases/tag/v<version>` |

The GitHub Release is created by the `github-release` job from `.github/RELEASE_NOTES.md`. If it is missing, the job either did not run (check that `publish-npm` succeeded) or 403'd — in which case `BOT_PAT`'s `public_repo` scope is the first thing to check, and [`bot-pat-rotation.md`](./bot-pat-rotation.md) is the runbook.

The Docker MCP Catalog, Cline Marketplace, and mcp.so submissions are open queues — they'll only show the new version after maintainer review.

## Submitting a new version to the n8n Creator Portal

Learned the hard way on 2026-07-22, when the portal rejected `ead-factory` hours after a clean release (Story 17.4). Four rules:

1. **The portal only re-runs its automated pre-check against a NEW published version.** Explaining that the previous rejection was stale does nothing; ship a bump.
2. **Wait for the published version to be fully resolvable before submitting.** The rejection was consistent with npm's packument propagation still serving the previous version at `latest`. Verify on the *published* package, not locally:

   ```bash
   docker run --rm -it node:22-bookworm \
     npx @n8n/scan-community-package@0.29.1 <package-name>
   # want: ✅ Provenance   ✅ Fetched source from …@<sha>   ✅ passed
   ```

3. **Never cite `npx @n8n/scan-community-package <package>` at `latest` as evidence about a published package.** Up to 0.28.x it globs `.ts` while our tarballs ship only compiled `.js`, so it matches nothing and prints "passed" — it did exactly that for a package with 96 real violations. Use `0.29.x`, which follows the provenance attestation back to the GitHub source and lints that.
4. **Run the scanner in `node:22`.** On newer Node the `isolated-vm` postinstall fails under node-gyp and `npx` exits 1 **with no output at all**, which reads like a pass if you are not watching exit codes.

A single warning in the report does not block verification: `icon-prefer-themed-variants` was being reported when the portal **accepted** ead-factory v1.3.1.

## Recovery: fixing a tag that points at a stale commit

**Do not force-move the tag.** Moving published tags rewrites the SHA they point at, which can break caches, CDN mirrors, downstream consumers, and GitHub releases. The safer pattern: **bump again to the next patch version**.

Example: v1.1.0 tag points at a commit where `server.json` was still `1.0.0`. Instead of moving the tag:

1. Open a PR bumping to `v1.1.1`: edit `package.json#version` by hand, then run `/prep-mcp <mcp-name> --skip-tag` so `server.json` and every other artifact follow. Prep reads the version; it does not bump it.
2. Merge.
3. Tag `v1.1.1` from the merge commit and push.
4. The pipeline runs end-to-end; everything that was already at v1.1.0 (npm, Docker Hub) skips idempotently; the registry/store that was missing v1.1.0 gets v1.1.1.

The "gap" in version coverage (no v1.1.0 in the registry but v1.1.1 is there) is acceptable. The MCP Official Registry doesn't require every npm version to be registered — it just needs the latest.

## Anti-patterns

These are things we've done that you should not do:

- **Bumping `package.json` and stopping there.** The hand edit is step 3; `/prep-mcp` is step 6 and propagates it to every other artifact. The MCP Registry will silently reject the publish if `server.json` is stale.
- **Running `/prep-mcp` without `--skip-tag`.** It tags inside the source clone, at the pre-merge commit. Delete the local tag (`git tag -d v<version>`) and re-run; do not bump the version to escape it.
- **Tagging a release with no `.github/RELEASE_NOTES.md`.** The `setup` job fails the run, and rightly: the note is the only thing that tells a user their credential stopped working.
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
