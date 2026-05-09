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

## License

MIT. See [LICENSE](./LICENSE).

## Contributing

Internal Garrigues / g-digital project. For onboarding, see `docs/runbooks/setup-day1.md` (added in Epic 1).
