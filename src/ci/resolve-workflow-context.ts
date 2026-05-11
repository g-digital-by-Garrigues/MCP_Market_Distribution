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

  const configRaw = await fs.readFile(opts.configPath, 'utf8');
  const config = mcpPipelineConfigSchema.parse(yaml.load(configRaw));

  const candidates: Array<{ name: string; prefix: string }> = [];
  for (const [name, entry] of Object.entries(config.mcps)) {
    candidates.push({ name, prefix: entry.git_tag_prefix ?? DEFAULT_GIT_TAG_PREFIX });
  }

  // Longest prefix wins to handle e.g. ead-factory-v over v.
  candidates.sort((a, b) => b.prefix.length - a.prefix.length);

  for (const { name, prefix } of candidates) {
    if (tag.startsWith(prefix)) {
      const version = tag.slice(prefix.length);
      if (version.length === 0) continue;
      return { mcp_name: name, version, pipeline_run_id: pipelineRunId, source: 'tag-push' };
    }
  }

  const listed = candidates.map((c) => `${c.name} (prefix '${c.prefix}')`).join(', ');
  throw new Error(
    `Tag '${tag}' does not match any MCP's git_tag_prefix. Configured: ${listed || '(none)'}.`,
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
