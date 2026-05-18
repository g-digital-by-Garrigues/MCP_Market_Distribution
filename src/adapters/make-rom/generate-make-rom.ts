import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  runInspectorHarness,
  type InspectorToolEntry,
} from '../../gates/inspector-harness.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';
import type { DistributionConfig } from '../../schemas/distribution-config.schema.js';
import {
  jsonSchemaToMakeParams,
  type ToolInputSchema,
} from './json-schema-to-make-param.js';
import type {
  MakeAction,
  MakeConnection,
  MakeConnectionField,
  MakeRomArtifact,
} from './types.js';

// Story 5.7 / FR33: produce a Make ROM artifact from an MCP source.
//
// v1 — generate only, no publication to Make.com. We emit a single
// `make-rom.json` file with module metadata + connection fields +
// per-tool actions. The HTTP communication spec for each action is
// emitted as a placeholder because MCP tools speak stdio JSON-RPC,
// not HTTP — bridging that needs a Make-hosted gateway that is not
// in scope for v1.

export interface GenerateMakeRomInput {
  /** Path to the MCP source folder (typically pending-to-publish/<id>/). */
  readonly packageDir: string;
  /** Pipeline-repo root, used to load .distribution.yaml. */
  readonly repoRoot: string;
  /** MCP id (kebab-case). */
  readonly mcpName: string;
  /** Version to embed in the artifact (typically the source MCP version). */
  readonly version: string;
  /**
   * Absolute path to where the artifact JSON should be written.
   * Defaults to `<packageDir>/.make-rom/make-rom.json`. The directory
   * is created if missing.
   */
  readonly outputPath?: string;
  /** Inspector-harness overrides (defaults match the n8n adapter side). */
  readonly inspectorCommand?: string;
  readonly inspectorArgs?: readonly string[];
  readonly inspectorTimeoutMs?: number;
}

export interface GenerateMakeRomResult {
  artifact: MakeRomArtifact;
  /** Absolute path of the written JSON file. */
  artifactPath: string;
}

export class GenerateMakeRomError extends Error {
  readonly stage: 'tools_list' | 'server_json' | 'distribution_config' | 'launch';
  constructor(stage: GenerateMakeRomError['stage'], message: string) {
    super(message);
    this.name = 'GenerateMakeRomError';
    this.stage = stage;
  }
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

function toTitleCase(kebab: string): string {
  return kebab
    .split(/[-_]/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
}

function toCamel(kebab: string): string {
  const parts = kebab.split(/[-_]/).filter((s) => s.length > 0);
  if (parts.length === 0) return kebab;
  return (
    parts[0]!.toLowerCase() +
    parts
      .slice(1)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')
  );
}

async function readServerJson(packageDir: string): Promise<ServerJsonShape> {
  const filePath = path.join(packageDir, 'server.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new GenerateMakeRomError(
      'server_json',
      `server.json not found at ${filePath}: ${(err as Error).message}.`,
    );
  }
  try {
    return JSON.parse(raw) as ServerJsonShape;
  } catch (err) {
    throw new GenerateMakeRomError(
      'server_json',
      `server.json at ${filePath} is not valid JSON: ${(err as Error).message}.`,
    );
  }
}

function resolveRepoUrl(distribution: DistributionConfig, server: ServerJsonShape): string {
  const repo = server.repository;
  if (typeof repo === 'string' && repo.length > 0) return repo;
  if (repo && typeof repo === 'object' && typeof repo.url === 'string' && repo.url.length > 0) {
    return repo.url;
  }
  return `https://www.npmjs.com/package/${encodeURIComponent(distribution.npm_package_name)}`;
}

function buildConnection(mcpName: string, server: ServerJsonShape): MakeConnection {
  const envVars = server.packages?.[0]?.environmentVariables ?? [];
  const fields: MakeConnectionField[] = envVars.map((v) => {
    const field: MakeConnectionField = {
      envName: v.name,
      label: toTitleCase(v.name.toLowerCase().replace(/_/g, '-')),
      type: v.isSecret === true ? 'password' : 'text',
      required: v.isRequired === true,
    };
    if (v.description) field.help = v.description;
    return field;
  });
  return {
    name: `${toCamel(mcpName)}Api`,
    label: `${toTitleCase(mcpName)} API`,
    fields,
  };
}

function buildAction(tool: InspectorToolEntry): { action: MakeAction; notes: string[] } {
  const { parameters, notes } = jsonSchemaToMakeParams(
    tool.inputSchema as ToolInputSchema | null,
    { toolName: tool.name },
  );
  const action: MakeAction = {
    name: tool.name,
    label: toTitleCase(tool.name.replace(/_/g, '-')),
    description: tool.description ?? '',
    parameters,
    communication: {
      placeholder: true,
      placeholderReason:
        'MCP tools speak stdio JSON-RPC, not HTTP. Wire this action to a Make-hosted MCP-over-HTTP gateway endpoint that maps to the tools/call request below.',
      mcpToolName: tool.name,
    },
  };
  return { action, notes };
}

export async function generateMakeRom(
  input: GenerateMakeRomInput,
): Promise<GenerateMakeRomResult> {
  let distribution: DistributionConfig;
  try {
    distribution = await loadDistributionConfig(input.repoRoot, input.mcpName);
  } catch (err) {
    throw new GenerateMakeRomError(
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
    throw new GenerateMakeRomError(
      'launch',
      `Could not launch MCP for '${input.mcpName}': ${probe.launch_error}`,
    );
  }
  if (!probe.initialize_succeeded) {
    throw new GenerateMakeRomError(
      'launch',
      `MCP for '${input.mcpName}' failed initialize: ${probe.initialize_error ?? 'unknown'}.`,
    );
  }
  if (probe.tools_list_error) {
    throw new GenerateMakeRomError(
      'tools_list',
      `MCP for '${input.mcpName}' returned tools/list error: ${probe.tools_list_error}.`,
    );
  }
  if (probe.tools_list.length === 0) {
    throw new GenerateMakeRomError(
      'tools_list',
      `MCP for '${input.mcpName}' exposes zero tools — refusing to generate an empty Make ROM artifact.`,
    );
  }

  const allNotes: string[] = [];
  const actions: MakeAction[] = [];
  for (const tool of probe.tools_list) {
    const { action, notes } = buildAction(tool);
    actions.push(action);
    allNotes.push(...notes);
  }
  // Surface the gateway-required note ONCE, no matter how many actions need it.
  if (actions.length > 0) {
    allNotes.push(
      'Every action emits a placeholder communication block — wire each one to a Make-hosted MCP-over-HTTP gateway before this artifact is functional in Make.com.',
    );
  }

  const connection = buildConnection(input.mcpName, server);
  const artifact: MakeRomArtifact = {
    artifactSchemaVersion: 1,
    module: {
      name: input.mcpName,
      label: toTitleCase(input.mcpName),
      description: server.description ?? `Make module for the ${toTitleCase(input.mcpName)} MCP.`,
      sourceMcpPackageName: distribution.npm_package_name,
      version: input.version,
      sourceRepoUrl: resolveRepoUrl(distribution, server),
    },
    connection,
    actions,
    notes: allNotes,
  };

  const outputPath =
    input.outputPath ?? path.join(input.packageDir, '.make-rom', 'make-rom.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

  return { artifact, artifactPath: outputPath };
}
