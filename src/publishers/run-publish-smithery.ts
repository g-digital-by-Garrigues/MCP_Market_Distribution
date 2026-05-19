import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';
import { runWithCrashHandler } from './crash-handler.js';
import { publishSmithery } from './publish-smithery.js';

async function main(): Promise<number> {
  const mcpName = process.env.INPUT_MCP_NAME ?? '';
  const version = process.env.INPUT_VERSION ?? '';
  const pipelineRunId = process.env.INPUT_PIPELINE_RUN_ID ?? '';
  const dryRun = parseDryRunFlag(process.env.INPUT_DRY_RUN);
  const bundlePath = process.env.INPUT_BUNDLE_PATH ?? '';
  const smitheryNamespace = process.env.INPUT_SMITHERY_NAMESPACE; // optional

  if (!mcpName || !version || !pipelineRunId || !bundlePath) {
    process.stderr.write(
      `actions/publish-smithery requires INPUT_MCP_NAME, INPUT_VERSION, INPUT_PIPELINE_RUN_ID, INPUT_BUNDLE_PATH env vars\n`,
    );
    return 2;
  }

  const output = await publishSmithery({
    mcp_name: mcpName,
    version,
    pipeline_run_id: pipelineRunId,
    dry_run: dryRun,
    bundle_path: bundlePath,
    ...(smitheryNamespace ? { smithery_namespace: smitheryNamespace } : {}),
  });

  process.stdout.write(JSON.stringify(output) + '\n');
  return output.status === 'failed' ? 1 : 0;
}

runWithCrashHandler('smithery', main);
