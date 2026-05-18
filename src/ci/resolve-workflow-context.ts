import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  mcpPipelineConfigSchema,
  DEFAULT_GIT_TAG_PREFIX,
} from '../schemas/mcp-pipeline-config.schema.js';

export interface ResolveWorkflowContextOptions {
  /** GitHub tag name when triggered by `push` on a v* tag (e.g., 'v1.0.0'). Empty/undefined for workflow_dispatch. */
  tag?: string;
  /** Engineer-provided MCP name when triggered by workflow_dispatch. Empty/undefined for tag push. */
  inputMcpName?: string;
  /** Engineer-provided version when triggered by workflow_dispatch. Empty/undefined for tag push. */
  inputVersion?: string;
  /** Absolute path to mcp-pipeline.yaml. */
  configPath: string;
  /** `github.run_id`. */
  runId: string;
  /** `github.run_attempt`. */
  runAttempt: string;
}

export interface WorkflowContext {
  mcp_name: string;
  version: string;
  pipeline_run_id: string;
  source: 'tag-push' | 'workflow-dispatch';
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export async function resolveWorkflowContext(
  opts: ResolveWorkflowContextOptions,
): Promise<WorkflowContext> {
  const tag = emptyToUndefined(opts.tag);
  const inputMcpName = emptyToUndefined(opts.inputMcpName);
  const inputVersion = emptyToUndefined(opts.inputVersion);
  const pipelineRunId = `${opts.runId}-${opts.runAttempt}`;

  if (inputMcpName && inputVersion) {
    return {
      mcp_name: inputMcpName,
      version: inputVersion,
      pipeline_run_id: pipelineRunId,
      source: 'workflow-dispatch',
    };
  }

  if (!tag) {
    throw new Error(
      'resolveWorkflowContext requires either a tag (push event) or both inputMcpName and inputVersion (workflow_dispatch).',
    );
  }

  // In the per-MCP-repo model (v1.1+), each MCP has its OWN public repo
  // where v* tags are pushed. A v* tag on this pipeline repo is vestigial
  // (the canonical flow is workflow_dispatch). When tag-push DOES fire
  // here, we assume the default 'v' prefix for every MCP in the registry —
  // resolving the right MCP requires workflow_dispatch with `mcp_name`.
  const configRaw = await fs.readFile(opts.configPath, 'utf8');
  const config = mcpPipelineConfigSchema.parse(yaml.load(configRaw));

  const names = Object.keys(config.mcps);
  for (const name of names) {
    if (tag.startsWith(DEFAULT_GIT_TAG_PREFIX)) {
      const version = tag.slice(DEFAULT_GIT_TAG_PREFIX.length);
      if (version.length === 0) continue;
      // First match wins. Ambiguous when >1 MCP — use workflow_dispatch.
      return { mcp_name: name, version, pipeline_run_id: pipelineRunId, source: 'tag-push' };
    }
  }

  throw new Error(
    `Tag '${tag}' does not start with '${DEFAULT_GIT_TAG_PREFIX}'. Configured MCPs: ${names.join(', ') || '(none)'}. ` +
      `Use workflow_dispatch with explicit mcp_name + version to disambiguate.`,
  );
}

async function main(): Promise<number> {
  const tag =
    process.env.GH_REF_TYPE === 'tag' ? process.env.GH_REF_NAME : undefined;
  const inputMcpName = process.env.INPUT_MCP_NAME;
  const inputVersion = process.env.INPUT_VERSION;
  const runId = process.env.GH_RUN_ID;
  const runAttempt = process.env.GH_RUN_ATTEMPT;

  if (!runId || !runAttempt) {
    process.stderr.write(
      'GH_RUN_ID and GH_RUN_ATTEMPT must be set (typically by GitHub Actions).\n',
    );
    return 2;
  }

  try {
    const result = await resolveWorkflowContext({
      tag,
      inputMcpName,
      inputVersion,
      configPath: path.resolve(process.cwd(), 'mcp-pipeline.yaml'),
      runId,
      runAttempt,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
