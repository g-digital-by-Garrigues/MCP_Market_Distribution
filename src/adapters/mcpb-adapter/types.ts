// Types for the MCPB bundle adapter (Track C, Story 5.9).
//
// The adapter converts an MCP server (tools + credentials + metadata)
// into a Model Context Protocol Bundle (.mcpb): a ZIP archive containing
// a `manifest.json` plus the bundled `server/` directory (entry point +
// production node_modules + compiled dist/). The bundle is what Smithery
// accepts via `smithery mcp publish <bundle.mcpb> -n <org>/<name>` since
// they retired their repo auto-deploy model in 2026.
//
// Intermediate shape is `McpbBundleSpec`: a fully-resolved, validated
// description of what the generator emits. Handlebars templates consume
// this spec. Keeping it separate from IO lets us unit-test the manifest
// derivation without filesystem or shell-out.
//
// Manifest spec reference: anthropics/mcpb MANIFEST.md (v0.3, 2025-12-02).
// Bundle layout reference: same source. We pin to manifest_version 0.3
// here because that's what the published `mcpb` CLI validates against.

/** MCPB manifest version we emit — pinned to the spec the `mcpb` CLI ships with. */
export const MCPB_MANIFEST_VERSION = '0.3';

/** Public-facing `server.type` values supported by the MCPB spec. We only
 * emit `node` for the g-digital MCPs (all node/stdio); the spec also
 * allows `python` and `binary`. Add here when a non-node MCP onboards. */
export type McpbServerType = 'node';

/**
 * One MCP tool, surfaced BOTH in the manifest's `tools` array (so
 * Smithery's registry indexes them as a real list rather than
 * `tools: null`) AND in the bundle README catalogue.
 *
 * `inputSchema` is optional only because some MCPs declare a tool
 * without a JSON Schema for its inputs; the manifest spec accepts that.
 */
export interface McpbOperationSpec {
  /** Tool name as the MCP exposes it (snake_case). */
  name: string;
  /** Concise human-readable description. */
  description: string;
  /** Raw JSON Schema describing the tool's input arguments (from `tools/list`). */
  inputSchema?: unknown;
}

/** Source code repository information for the manifest's `repository` field. */
export interface McpbRepository {
  type: 'git';
  url: string;
}

/**
 * One env-var that the MCP requires at runtime, mapped to a manifest
 * `user_config` entry the host UI prompts for at install time.
 *
 * The manifest's `mcp_config.env` references these via the
 * `${user_config.<configKey>}` substitution syntax so the actual env
 * var the spawned server receives is filled from the user's input.
 */
export interface McpbUserConfigField {
  /** Env-var name as the MCP expects it (UPPER_SNAKE_CASE), e.g. `OKTA_CLIENT_ID`. */
  envName: string;
  /**
   * lower_snake_case config key the manifest references via
   * `${user_config.<key>}`. MCPB convention is lower_snake here even
   * though the env var is UPPER_SNAKE — the host UI uses the config
   * key as the form field id.
   */
  configKey: string;
  /** Human-friendly label rendered by the MCPB host UI (e.g. Claude Desktop). */
  title: string;
  /** Description shown beneath the form field. */
  description: string;
  /** Whether the field is sensitive (masked input, encrypted at rest by the host). */
  sensitive: boolean;
  /** Whether the field is required for the server to start. */
  required: boolean;
}

/**
 * Author block. MCPB requires `author.name`; `email` and `url` are
 * optional but help with attribution in marketplace listings.
 */
export interface McpbAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface McpbBundleSpec {
  /**
   * Machine identifier — kebab-case, no scope (e.g. `ead-factory`).
   * This is what `smithery mcp publish -n <org>/<name>` references.
   */
  name: string;
  /** Title-Case label shown in the MCPB host UI. */
  displayName: string;
  /** Semver aligned with the source MCP. */
  version: string;
  /** Short description for the manifest + README header. */
  description: string;
  /** Source MCP npm package name (e.g. `@g-digital/mcp-ead-factory`) — surfaced in README + provenance. */
  sourceMcpPackageName: string;
  /**
   * Source MCP's GitHub repo URL — also doubles as the default
   * homepage when `homepageUrl` is not explicitly set.
   */
  sourceRepoUrl: string;
  /**
   * Optional product homepage URL distinct from the source repo. When
   * absent the manifest emits `homepage: sourceRepoUrl` (matches the
   * `repository.url`); set this to the product landing page (e.g.
   * https://www.eadtrust.com) when the MCP has one.
   */
  homepageUrl?: string;
  /** Author block for manifest + package.json carried inside the bundle. */
  author: McpbAuthor;
  /**
   * Search keywords surfaced under `manifest.keywords`. Sourced from
   * the source MCP's `package.json#keywords`; aids discoverability on
   * Smithery / MCPB marketplaces.
   */
  keywords: string[];
  /** Tool catalogue — emitted in `manifest.tools` AND in the README. */
  operations: McpbOperationSpec[];
  /** Manifest user_config fields derived from server.json#environmentVariables. */
  userConfig: McpbUserConfigField[];
  /**
   * Entry point relative to the bundle's `server/` directory. Always
   * `server/index.js` for node-stdio MCPs; pulled out as a field so we
   * could swap to `server/dist/server.js` for MCPs that ship their
   * compiled output deeper.
   */
  entryPoint: string;
  /**
   * Relative path inside the bundle to the icon file (PNG, typically
   * 400x400). Populated when the source MCP's `.distribution.yaml`
   * declares `logo_path`; the generator copies the source logo into
   * the bundle at this path. Set to `null` (omit) when no logo is
   * shipped — Smithery falls back to a generic placeholder.
   */
  iconPath?: string;
  /** Smithery namespace (NOT the GitHub org — see [[smithery-mcpb-deferred]]). */
  smitheryNamespace: string;
}
