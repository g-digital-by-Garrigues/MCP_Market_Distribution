import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  runInspectorHarness,
  type InspectorToolEntry,
} from '../../gates/inspector-harness.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';
import type { DistributionConfig } from '../../schemas/distribution-config.schema.js';
import type {
  McpbAuthor,
  McpbBundleSpec,
  McpbOperationSpec,
  McpbUserConfigField,
} from './types.js';

// Story 5.9: assemble the McpbBundleSpec for a single MCP.
//
// Mirrors the Track B build-node-spec.ts pattern — pulls together:
//   1. tools/list via inspector-harness — canonical tool names +
//      descriptions for the README catalogue.
//   2. .distribution.yaml — npm scope, source-package name, repo URL.
//   3. server.json#packages[0].environmentVariables — each env var
//      becomes a manifest `user_config` field the MCPB host prompts
//      for at install time.
//
// The output spec is consumed by the Handlebars manifest.json.hbs +
// README.md.hbs templates (Story 5.9b) and the generator orchestrator
// (Story 5.9c).
//
// `smithery_namespace` defaults to `g-digital-by-Garrigues` (matches
// our GitHub org); future MCPs from a different org would override via
// .distribution.yaml#smithery_namespace once that field is added.

export interface BuildMcpbBundleSpecInput {
  /** Path to the MCP source folder (clone target: pending-to-publish/<id>/). */
  readonly packageDir: string;
  /** Pipeline-repo root, used to load .distribution.yaml. */
  readonly repoRoot: string;
  /** MCP id (kebab-case). */
  readonly mcpName: string;
  /** Version to embed in the manifest (typically the source MCP's version). */
  readonly version: string;
  /**
   * Inspector-harness configuration — defaults to spawning
   * `node <packageDir>/dist/server.js`, which is what publish-npm ships.
   * Tests can inject a mock command/args here.
   */
  readonly inspectorCommand?: string;
  readonly inspectorArgs?: readonly string[];
  readonly inspectorTimeoutMs?: number;
  /**
   * Smithery namespace override. Defaults to `g-digital-by-Garrigues`
   * to match our GitHub org. The published bundle's reference is
   * `<smithery_namespace>/<name>` when run through
   * `smithery mcp publish ... -n <ns>/<name>`.
   */
  readonly smitheryNamespace?: string;
}

export interface BuildMcpbBundleSpecResult {
  spec: McpbBundleSpec;
}

export class BuildMcpbBundleSpecError extends Error {
  readonly stage: 'tools_list' | 'server_json' | 'distribution_config' | 'launch';
  constructor(stage: BuildMcpbBundleSpecError['stage'], message: string) {
    super(message);
    this.name = 'BuildMcpbBundleSpecError';
    this.stage = stage;
  }
}

const DEFAULT_SMITHERY_NAMESPACE = 'g-digital';

function toTitleCase(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function envNameToConfigKey(envName: string): string {
  // MCPB host UIs key user_config by lower_snake_case (e.g.
  // `okta_client_id`) while the env var stays UPPER_SNAKE
  // (`OKTA_CLIENT_ID`). This converter is the canonical mapping.
  return envName.toLowerCase();
}

interface ServerJsonShape {
  description?: string;
  repository?: { url?: string } | string;
  packages?: ReadonlyArray<{
    environmentVariables?: ReadonlyArray<{
      name: string;
      description?: string;
      isSecret?: boolean;
      isRequired?: boolean;
    }>;
  }>;
}

interface PackageJsonShape {
  keywords?: string[];
  homepage?: string;
}

async function readServerJson(packageDir: string): Promise<ServerJsonShape> {
  const filePath = path.join(packageDir, 'server.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new BuildMcpbBundleSpecError(
      'server_json',
      `server.json not found at ${filePath}: ${(err as Error).message}. Run /prep-mcp first so the artifact exists.`,
    );
  }
  try {
    return JSON.parse(raw) as ServerJsonShape;
  } catch (err) {
    throw new BuildMcpbBundleSpecError(
      'server_json',
      `server.json at ${filePath} is not valid JSON: ${(err as Error).message}.`,
    );
  }
}

// Best-effort read — returns an empty object when package.json is
// missing or unparseable (some test fixtures don't ship one). The
// fields we extract (keywords, homepage) are all manifest-optional, so
// a missing package.json downgrades the manifest gracefully rather
// than failing the whole adapter build.
async function readPackageJson(packageDir: string): Promise<PackageJsonShape> {
  const filePath = path.join(packageDir, 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return {};
  }
}

function buildUserConfigFields(server: ServerJsonShape): McpbUserConfigField[] {
  const vars = server.packages?.[0]?.environmentVariables ?? [];
  return vars.map((v) => ({
    envName: v.name,
    configKey: envNameToConfigKey(v.name),
    title: toTitleCase(v.name.toLowerCase().replace(/_/g, '-')),
    description: v.description ?? '',
    sensitive: v.isSecret === true,
    // MCPB defaults `required: true` when unset. Be explicit so the
    // manifest is deterministic.
    required: v.isRequired !== false,
  }));
}

function buildOperation(tool: InspectorToolEntry): McpbOperationSpec {
  const op: McpbOperationSpec = {
    name: tool.name,
    description: tool.description ?? '',
  };
  // Only thread inputSchema through when the source MCP actually
  // provides one. Smithery indexes the schema for parameter UI hints;
  // emitting `inputSchema: null` is worse than omitting the field.
  if (tool.inputSchema !== undefined && tool.inputSchema !== null) {
    op.inputSchema = tool.inputSchema;
  }
  return op;
}

function resolveRepoUrl(distribution: DistributionConfig, server: ServerJsonShape): string {
  const repo = server.repository;
  if (typeof repo === 'string' && repo.length > 0) return repo;
  if (repo && typeof repo === 'object' && typeof repo.url === 'string' && repo.url.length > 0) {
    return repo.url;
  }
  return `https://www.npmjs.com/package/${encodeURIComponent(distribution.npm_package_name)}`;
}

export async function buildMcpbBundleSpec(
  input: BuildMcpbBundleSpecInput,
): Promise<BuildMcpbBundleSpecResult> {
  let distribution: DistributionConfig;
  try {
    distribution = await loadDistributionConfig(input.repoRoot, input.mcpName);
  } catch (err) {
    throw new BuildMcpbBundleSpecError(
      'distribution_config',
      `Could not load .distribution.yaml for '${input.mcpName}': ${(err as Error).message}`,
    );
  }

  const server = await readServerJson(input.packageDir);

  const command = input.inspectorCommand ?? 'node';
  const args = input.inspectorArgs ?? ['dist/server.js'];
  const resolvedArgs = args.map((a) =>
    path.isAbsolute(a) ? a : path.resolve(input.packageDir, a),
  );

  const probe = await runInspectorHarness({
    command,
    args: resolvedArgs,
    ...(typeof input.inspectorTimeoutMs === 'number'
      ? { timeoutMs: input.inspectorTimeoutMs }
      : {}),
  });

  if (probe.launch_error) {
    throw new BuildMcpbBundleSpecError(
      'launch',
      `Could not launch MCP for '${input.mcpName}' (${command} ${args.join(' ')}): ${probe.launch_error}`,
    );
  }
  if (!probe.initialize_succeeded) {
    throw new BuildMcpbBundleSpecError(
      'launch',
      `MCP for '${input.mcpName}' failed the initialize handshake: ${probe.initialize_error ?? 'unknown'}.`,
    );
  }
  if (probe.tools_list_error) {
    throw new BuildMcpbBundleSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' returned tools/list error: ${probe.tools_list_error}.`,
    );
  }
  if (probe.tools_list.length === 0) {
    throw new BuildMcpbBundleSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' exposes zero tools — refusing to generate an empty MCPB bundle.`,
    );
  }

  const operations = probe.tools_list.map(buildOperation);
  const userConfig = buildUserConfigFields(server);
  const displayName = toTitleCase(input.mcpName);
  const pkg = await readPackageJson(input.packageDir);
  const repoUrl = resolveRepoUrl(distribution, server);

  const spec: McpbBundleSpec = {
    name: input.mcpName,
    displayName,
    version: input.version,
    description: server.description ?? `${displayName} MCP server.`,
    sourceMcpPackageName: distribution.npm_package_name,
    sourceRepoUrl: repoUrl,
    ...(pkg.homepage && pkg.homepage !== repoUrl ? { homepageUrl: pkg.homepage } : {}),
    author: { name: 'g-digital by Garrigues' },
    keywords: pkg.keywords ?? [],
    operations,
    userConfig,
    // Source MCPs compile to `dist/server.js` and we stage that into
    // `<bundle>/server/`. Smithery's MCPB host treats `server/index.js`
    // as the canonical entry, but the manifest's `entry_point` can
    // point anywhere under `server/`. We name the staged file
    // `server/index.js` for compatibility with hosts that hard-code
    // that path (per anthropics/mcpb examples).
    entryPoint: 'server/index.js',
    // Icon: when .distribution.yaml declares a logo_path the source MCP
    // ships, the generator (Story 5.9c) copies it into the bundle at
    // `assets/icon.png` and emits manifest.icon pointing here. When
    // logo_path is absent Smithery falls back to a generic placeholder.
    ...(distribution.logo_path ? { iconPath: 'assets/icon.png' } : {}),
    smitheryNamespace: input.smitheryNamespace ?? DEFAULT_SMITHERY_NAMESPACE,
  };

  return { spec };
}
