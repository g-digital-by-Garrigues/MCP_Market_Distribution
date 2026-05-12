import path from 'node:path';
import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';
import { publishMcpRegistry } from './publish-mcp-registry.js';

async function main(): Promise<number> {
  const mcpName = process.env.INPUT_MCP_NAME ?? '';
  const version = process.env.INPUT_VERSION ?? '';
  const pipelineRunId = process.env.INPUT_PIPELINE_RUN_ID ?? '';
  const dryRun = parseDryRunFlag(process.env.INPUT_DRY_RUN);

  if (!mcpName || !version || !pipelineRunId) {
    process.stderr.write(
      `actions/publish-mcp-registry requires INPUT_MCP_NAME, INPUT_VERSION, INPUT_PIPELINE_RUN_ID env vars\n`,
    );
    return 2;
  }

  const repoRoot = process.cwd();
  const packageDir = path.join(repoRoot, 'pending-to-publish', mcpName);

  const output = await publishMcpRegistry({
    mcp_name: mcpName,
    version,
    pipeline_run_id: pipelineRunId,
    dry_run: dryRun,
    package_dir: packageDir,
    repo_root: repoRoot,
  });

  process.stdout.write(JSON.stringify(output) + '\n');
  return output.status === 'failed' ? 1 : 0;
}

void main().then((code) => process.exit(code));
