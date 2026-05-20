import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  runInspectorHarness,
  type InspectorToolEntry,
} from '../../gates/inspector-harness.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';
import type { DistributionConfig } from '../../schemas/distribution-config.schema.js';
import {
  jsonSchemaToProperties,
  type ToolInputSchema,
} from './json-schema-to-properties.js';
import type {
  N8nCredentialField,
  N8nNodeSpec,
  N8nOperationSpec,
} from './types.js';
import { resolveMcpEntryRelPath } from '../../utils/resolve-mcp-entry.js';

// Story 5.1b: assemble the N8nNodeSpec for a single MCP.
//
// Pulls together three input sources:
//   1. tools/list via inspector-harness — gives us the canonical tool
//      names + descriptions + inputSchemas the MCP actually exposes
//      (more reliable than the static .distribution.yaml#tools list,
//      which engineers can drift).
//   2. .distribution.yaml — npm_scope, n8n_adapter_target_name, repo
//      URL, source-MCP package metadata.
//   3. server.json#packages[0].environmentVariables — what credentials
//      the n8n node needs to expose (mapping 1:1 from MCP env vars).
//
// The output spec is consumed by the Handlebars codegen step (5.1c).
// Unsupported-schema notes from the converter are aggregated and
// surfaced via `unsupportedNotes` so the generator can write them
// into the README / hand them to the LLM-refine pass (5.1d).

export interface BuildN8nNodeSpecInput {
  /** Path to the MCP source folder (clone target: pending-to-publish/<id>/). */
  readonly packageDir: string;
  /** Pipeline-repo root, used to load .distribution.yaml. */
  readonly repoRoot: string;
  /** MCP id (kebab-case). */
  readonly mcpName: string;
  /** Version to embed in the generated package.json (typically the source MCP's version). */
  readonly version: string;
  /**
   * Inspector-harness configuration — defaults to spawning
   * `node <packageDir>/dist/server.js`, which is what publish-npm
   * ships. Tests can inject a mock command/args here.
   */
  readonly inspectorCommand?: string;
  readonly inspectorArgs?: readonly string[];
  readonly inspectorTimeoutMs?: number;
}

export interface BuildN8nNodeSpecResult {
  spec: N8nNodeSpec;
  /** Aggregated diagnostic notes (across all operations). */
  unsupportedNotes: string[];
}

export class BuildN8nNodeSpecError extends Error {
  readonly stage: 'tools_list' | 'server_json' | 'distribution_config' | 'launch';
  constructor(stage: BuildN8nNodeSpecError['stage'], message: string) {
    super(message);
    this.name = 'BuildN8nNodeSpecError';
    this.stage = stage;
  }
}

// Two-tier title-case so 'ead-factory' → 'EadFactory' (class name)
// and 'ead-factory' → 'Ead Factory' (display).
function toPascalCase(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}
function toTitleCase(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
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

async function readServerJson(packageDir: string): Promise<ServerJsonShape> {
  const filePath = path.join(packageDir, 'server.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new BuildN8nNodeSpecError(
      'server_json',
      `server.json not found at ${filePath}: ${(err as Error).message}. Run /prep-mcp first so the artifact exists.`,
    );
  }
  try {
    return JSON.parse(raw) as ServerJsonShape;
  } catch (err) {
    throw new BuildN8nNodeSpecError(
      'server_json',
      `server.json at ${filePath} is not valid JSON: ${(err as Error).message}.`,
    );
  }
}

function buildCredentials(server: ServerJsonShape): N8nCredentialField[] {
  const vars = server.packages?.[0]?.environmentVariables ?? [];
  return vars.map((v) => {
    const field: N8nCredentialField = {
      envName: v.name,
      displayName: toTitleCase(v.name.toLowerCase().replace(/_/g, '-')),
      isSecret: v.isSecret === true,
    };
    if (v.description) field.description = v.description;
    return field;
  });
}

function buildOperation(tool: InspectorToolEntry): {
  op: N8nOperationSpec;
  notes: string[];
} {
  const { properties, unsupportedNotes } = jsonSchemaToProperties(
    tool.inputSchema as ToolInputSchema | null,
    { operationName: tool.name },
  );
  return {
    op: {
      name: tool.name,
      displayName: toTitleCase(tool.name.replace(/_/g, '-')),
      description: tool.description ?? '',
      properties,
    },
    notes: unsupportedNotes,
  };
}

function npmPackageName(scope: string, targetName: string): string {
  const normalizedScope = scope.startsWith('@') ? scope : `@${scope}`;
  return `${normalizedScope}/${targetName}`;
}

function resolveRepoUrl(distribution: DistributionConfig, server: ServerJsonShape): string {
  // server.json#repository.url is the canonical URL the MCP itself
  // declares (Story 1.6); fall back to a placeholder only if it's
  // somehow absent.
  const repo = server.repository;
  if (typeof repo === 'string' && repo.length > 0) return repo;
  if (repo && typeof repo === 'object' && typeof repo.url === 'string' && repo.url.length > 0) {
    return repo.url;
  }
  // distribution config doesn't carry the repo URL directly (that
  // lives in mcp-pipeline.yaml#repo_url, which this loader doesn't
  // expose). Best-effort fallback uses npm_package_name.
  return `https://www.npmjs.com/package/${encodeURIComponent(distribution.npm_package_name)}`;
}

export async function buildN8nNodeSpec(
  input: BuildN8nNodeSpecInput,
): Promise<BuildN8nNodeSpecResult> {
  let distribution: DistributionConfig;
  try {
    distribution = await loadDistributionConfig(input.repoRoot, input.mcpName);
  } catch (err) {
    throw new BuildN8nNodeSpecError(
      'distribution_config',
      `Could not load .distribution.yaml for '${input.mcpName}': ${(err as Error).message}`,
    );
  }

  const server = await readServerJson(input.packageDir);

  // Spawn the MCP via inspector-harness to fetch the live tools/list.
  const command = input.inspectorCommand ?? 'node';
  const args = input.inspectorArgs ?? [await resolveMcpEntryRelPath(input.packageDir)];
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
    throw new BuildN8nNodeSpecError(
      'launch',
      `Could not launch MCP for '${input.mcpName}' (${command} ${args.join(' ')}): ${probe.launch_error}`,
    );
  }
  if (!probe.initialize_succeeded) {
    throw new BuildN8nNodeSpecError(
      'launch',
      `MCP for '${input.mcpName}' failed the initialize handshake: ${probe.initialize_error ?? 'unknown'}.`,
    );
  }
  if (probe.tools_list_error) {
    throw new BuildN8nNodeSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' returned tools/list error: ${probe.tools_list_error}.`,
    );
  }
  if (probe.tools_list.length === 0) {
    throw new BuildN8nNodeSpecError(
      'tools_list',
      `MCP for '${input.mcpName}' exposes zero tools — refusing to generate an empty n8n node.`,
    );
  }

  const unsupportedNotes: string[] = [];
  const operations: N8nOperationSpec[] = [];
  for (const tool of probe.tools_list) {
    const { op, notes } = buildOperation(tool);
    operations.push(op);
    unsupportedNotes.push(...notes);
  }

  const credentials = buildCredentials(server);
  const bareTargetName = distribution.n8n_adapter_target_name.replace(/^n8n-nodes-/, '');
  const className = toPascalCase(bareTargetName);
  const resourceLabel = toTitleCase(bareTargetName);
  const paramName = className.charAt(0).toLowerCase() + className.slice(1);
  const credentialClassName = `${className}Api`;
  const credentialParamName = `${paramName}Api`;

  const spec: N8nNodeSpec = {
    packageName: npmPackageName(distribution.npm_scope, distribution.n8n_adapter_target_name),
    sourceMcpPackageName: distribution.npm_package_name,
    version: input.version,
    className,
    displayName: resourceLabel,
    description: server.description ?? `n8n community node for the ${resourceLabel} MCP.`,
    nodeName: input.mcpName,
    paramName,
    resourceDisplayName: resourceLabel,
    operations,
    credentials,
    credentialClassName,
    credentialParamName,
    sourceRepoUrl: resolveRepoUrl(distribution, server),
    author: 'g-digital by Garrigues',
    // Flag set when the source MCP ships a logo via .distribution.yaml.
    // The generator (Story 5.1c, extended for icon support) copies the
    // logo into nodes/<Class>/icon.png and emits `icon: 'file:icon.png'`
    // on the n8n description so the catalogue UI renders the brand
    // instead of a generic box.
    ...(distribution.logo_path ? { iconBundled: true } : {}),
  };

  return { spec, unsupportedNotes };
}
