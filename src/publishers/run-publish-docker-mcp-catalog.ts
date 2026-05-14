import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';
import { publishDockerMcpCatalog } from './publish-docker-mcp-catalog.js';

async function main(): Promise<number> {
  const mcpName = process.env.INPUT_MCP_NAME ?? '';
  const version = process.env.INPUT_VERSION ?? '';
  const pipelineRunId = process.env.INPUT_PIPELINE_RUN_ID ?? '';
  const dryRun = parseDryRunFlag(process.env.INPUT_DRY_RUN);

  if (!mcpName || !version || !pipelineRunId) {
    process.stderr.write(
      `actions/publish-docker-mcp-catalog requires INPUT_MCP_NAME, INPUT_VERSION, INPUT_PIPELINE_RUN_ID env vars\n`,
    );
    return 2;
  }

  const output = await publishDockerMcpCatalog({
    mcp_name: mcpName,
    version,
    pipeline_run_id: pipelineRunId,
    dry_run: dryRun,
    repo_root: process.cwd(),
  });

  process.stdout.write(JSON.stringify(output) + '\n');
  return output.status === 'failed' ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Without this catch the script exited 1 with only the publish_started
    // log line in result.json — the runner-yaml then has nothing to surface,
    // so final-report falls back to the generic "did not run" message and
    // the engineer is left blind. Print the stack to stderr (captured by
    // GH Actions) AND emit a failedOutput-shaped JSON to stdout so the
    // composite action's `> result.json` redirect still produces something
    // the PublisherOutputSchema can parse.
    const stack = err instanceof Error ? err.stack ?? err.message : String(err);
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${stack}\n`);
    const failed = {
      target: 'docker-mcp-catalog',
      status: 'failed' as const,
      target_url: 'https://example.invalid/crashed/docker-mcp-catalog',
      version_published: null,
      duration_ms: 0,
      attempts: 1,
      dry_run: process.env.INPUT_DRY_RUN === 'true',
      error: {
        message: `Publisher crashed before writing result.json: ${message}`,
        cause: 'Unhandled rejection in publishDockerMcpCatalog. See stderr above for the stack trace.',
        action: 'Inspect the workflow log for the stack trace and fix the failing await.',
      },
    };
    process.stdout.write(JSON.stringify(failed) + '\n');
    process.exit(1);
  });
