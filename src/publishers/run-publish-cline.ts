import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';
import { runWithCrashHandler } from './crash-handler.js';
import { publishCline } from './publish-cline.js';

async function main(): Promise<number> {
  const mcpName = process.env.INPUT_MCP_NAME ?? '';
  const version = process.env.INPUT_VERSION ?? '';
  const pipelineRunId = process.env.INPUT_PIPELINE_RUN_ID ?? '';
  const dryRun = parseDryRunFlag(process.env.INPUT_DRY_RUN);

  if (!mcpName || !version || !pipelineRunId) {
    process.stderr.write(
      `actions/publish-cline requires INPUT_MCP_NAME, INPUT_VERSION, INPUT_PIPELINE_RUN_ID env vars\n`,
    );
    return 2;
  }

  const output = await publishCline({
    mcp_name: mcpName,
    version,
    pipeline_run_id: pipelineRunId,
    dry_run: dryRun,
    repo_root: process.cwd(),
  });

  process.stdout.write(JSON.stringify(output) + '\n');
  return output.status === 'failed' ? 1 : 0;
}

runWithCrashHandler('cline', main);
