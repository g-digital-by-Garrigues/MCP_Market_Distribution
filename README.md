# g-digital MCP Distribution Pipeline

> Automated pipeline that publishes g-digital MCP servers and n8n nodes across the MCP ecosystem.

This repo is the implementation of the g-digital MCP Distribution System — an internal pipeline that takes an MCP source folder, validates it, and publishes it to npm, Docker Hub, the MCP Official Registry, Smithery, Docker MCP Catalog, Cline Marketplace, mcp.so, and (for Track B) n8n's npm community.

## Status

🚧 **Under construction.** This repo is currently being scaffolded. See the planning artifacts in the parent project for the full PRD, architecture, and 57-story implementation plan.

Expected initial milestones:

- **Epic 1:** Pipeline foundation + local Prep Agent (artifact generation, manifest validation)
- **Epic 2:** Track A quality gate in CI (static / MCP protocol smoke test / build & install)
- **Epic 3:** Track A core publication (npm + Docker Hub + Official Registry)
- **Epic 4:** Track A full coverage + retry recovery (Smithery, Docker MCP Catalog, Cline, mcp.so)
- **Epic 5:** Track B platform adaptation (n8n + Make ROM)
- **Epic 6:** First MCP live — EAD Factory pilot

## How it works (once built)

1. **Engineer drops** an MCP source folder into `pending-to-publish/<mcp-name>/`
2. **Engineer authors** a per-MCP entry in `mcp-pipeline.yaml`
3. **Engineer runs** `/prep-mcp <mcp-name>` locally via Claude Code (BMad skill)
4. **Engineer pushes** a `v*` git tag
5. **GitHub Actions runs** the 3-layer Track A quality gate (static schema validation, MCP protocol smoke test via MCP Inspector, build & install verification)
6. **Publisher Agent runs** (after gates pass) — npm publish, Docker push, `mcp-publisher publish`, Smithery deploy trigger, Docker MCP Catalog PR, Cline issue, mcp.so submission
7. **Track B runs in parallel** — n8n community node converted, validated, and published
8. **Release report** is committed to `_bmad-output/release-reports/<mcp>-<version>.md` and posted as a PR comment

Result: code drop → live across 10+ distribution channels in < 30 minutes.

## Repo layout (v1.1+)

The pipeline repo (this one) holds:

- `mcp-pipeline.yaml` — registry of MCPs the pipeline knows how to publish, keyed by kebab-case id. Each entry's only required field is `repo_url`. Everything else moves to the per-MCP repo (see below).
- `src/`, `actions/`, `.github/workflows/` — pipeline tooling itself.
- `pending-to-publish/<id>/` is **transient** at workflow time: the [`checkout-mcp-source`](./actions/checkout-mcp-source/action.yml) composite action clones the MCP repo into that path before any gate or publisher runs, and nothing under it is committed here.

Each MCP source repo (`g-digital-by-Garrigues/<Name>-MCP`) holds:

- The MCP code, `package.json`, `server.json`, `README.md`, `Dockerfile`, `LICENSE`, `assets/`.
- A `.distribution.yaml` at the root — schema in [`src/schemas/distribution-config.schema.ts`](./src/schemas/distribution-config.schema.ts). This is the source of truth for the per-MCP publish config the pipeline consumes (npm scope, docker image, license, tools list, logo path, skip_targets, etc.). No secrets — those stay as GitHub Actions secrets in this repo.

## Release flow (per-MCP-repo model, v1.1+)

Each MCP source lives in its **own public repository** under `g-digital-by-Garrigues/`, named `<MCP-Title-Case>-MCP` (e.g. [`EAD-Factory-MCP`](https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP)). The MCP code, README, Dockerfile, `package.json`, `server.json`, and a `.distribution.yaml` (publishing config consumed by this pipeline) live there. This repo holds only the pipeline tooling and the registry of MCPs to manage.

To cut a new release of an MCP:

1. **In the MCP's own repo (e.g. `EAD-Factory-MCP`):**
   - Open a PR bumping `package.json` and `server.json` to the new version (e.g. `1.0.5`).
   - When the PR merges to `main`, create and push the matching tag:
     ```bash
     git checkout main && git pull
     git tag -a v1.0.5 -m "Release 1.0.5"
     git push origin v1.0.5
     ```
   - The tag **must** match `v<version>` exactly. The pipeline fails fast if the tag doesn't exist.

2. **In this repo (`MCP_Market_Distribution`):**
   - Go to **Actions → publish → Run workflow** and dispatch with:
     | input | value |
     |---|---|
     | `mcp_name` | the MCP id (e.g. `ead-factory`) |
     | `version` | the version you just tagged (e.g. `1.0.5`) |
     | `dry_run` | `false` (use `true` to validate without publishing) |
     | `step`/`track`/`bump` | defaults are fine for a fresh release |

3. **The pipeline** will:
   - Clone the MCP repo at `v1.0.5` (or `main` for dry-runs).
   - Run the 3-layer Track A gate against that source.
   - Publish to npm, Docker Hub, MCP Official Registry, and open submissions on Docker MCP Catalog, Cline, mcp.so. Smithery is skipped per `skip_targets` until the MCPB generator lands.
   - Commit a release report to `_bmad-output/release-reports/` and post it as a comment if dispatched from a PR context.

### Registering a new MCP

To add an MCP to the pipeline:

1. Create the public repo `g-digital-by-Garrigues/<MCP-Title-Case>-MCP` with MIT license.
2. Add the MCP code, plus a `.distribution.yaml` at the root (see [`EAD-Factory-MCP/.distribution.yaml`](https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP/blob/main/.distribution.yaml) for the canonical example). Schema: `src/schemas/distribution-config.schema.ts`. This file is the source of truth for every per-MCP publish field (npm scope, docker image name, license, tools list, logo path, skip_targets, etc.) — nothing per-MCP should live in this repo.
3. In this repo, append an entry under `mcps:` in [`mcp-pipeline.yaml`](./mcp-pipeline.yaml) with at minimum `repo_url`. Everything else lives in the MCP's own `.distribution.yaml`.
4. Open the v1.0.0 PR in the MCP repo, tag `v1.0.0`, dispatch this workflow with `mcp_name=<your-id>, version=1.0.0`.

## License

MIT. See [LICENSE](./LICENSE).

## Contributing

Internal Garrigues / g-digital project. For onboarding, see `docs/runbooks/setup-day1.md` (added in Epic 1).
