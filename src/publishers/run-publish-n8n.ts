import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';
import { runWithCrashHandler } from './crash-handler.js';
import { publishN8n } from './publish-n8n.js';

// CLI shim invoked from actions/publish-n8n/action.yml. Reads composite-
// action inputs from env vars, calls publishN8n, emits the
// PublisherOutput JSON on stdout. Mirror of run-publish-npm.ts, with
// one extra input: INPUT_PACKAGE_DIR — the path to the GENERATED n8n
// adapter tree (a previous workflow step ran the adapter generator and
// uploaded it as an artifact, then this composite action downloaded it).

async function main(): Promise<number> {
  const mcpName = process.env.INPUT_MCP_NAME ?? '';
  const version = process.env.INPUT_VERSION ?? '';
  const pipelineRunId = process.env.INPUT_PIPELINE_RUN_ID ?? '';
  const packageDir = process.env.INPUT_PACKAGE_DIR ?? '';
  const dryRun = parseDryRunFlag(process.env.INPUT_DRY_RUN);

  if (!mcpName || !version || !pipelineRunId || !packageDir) {
    process.stderr.write(
      'actions/publish-n8n requires INPUT_MCP_NAME, INPUT_VERSION, INPUT_PIPELINE_RUN_ID, INPUT_PACKAGE_DIR env vars\n',
    );
    return 2;
  }

  const output = await publishN8n({
    mcp_name: mcpName,
    version,
    pipeline_run_id: pipelineRunId,
    dry_run: dryRun,
    package_dir: packageDir,
  });

  process.stdout.write(JSON.stringify(output) + '\n');
  return output.status === 'failed' ? 1 : 0;
}

runWithCrashHandler('n8n', main);
