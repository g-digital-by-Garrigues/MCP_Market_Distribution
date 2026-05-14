import process from 'node:process';

import { parseDryRunFlag } from '../ci/dry-run.js';
import { publishDockerMcpCatalog } from './publish-docker-mcp-catalog.js';

// Last-resort diagnostic. The .catch in v1.0.1 (PR #64) didn't surface
// anything, which means the v1.0.0/v1.0.1 crashes weren't reaching the
// promise chain — most likely a direct process.exit, an uncaughtException,
// or an unhandledRejection raised in a different event-loop tick. Wiring
// these process-level listeners gives us a stack trace on stderr no
// matter how the runner dies, and also writes a structured PublisherOutput
// to stdout so the composite action's `> result.json` redirect captures
// something the final-report aggregator can render.
process.on('uncaughtException', (err) => {
  emitCrash('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  emitCrash('unhandledRejection', err);
  process.exit(1);
});

function emitCrash(kind: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[run-publish-docker-mcp-catalog] ${kind}:\n${stack}\n`);
  const failed = {
    target: 'docker-mcp-catalog',
    status: 'failed' as const,
    target_url: 'https://example.invalid/crashed/docker-mcp-catalog',
    version_published: null,
    duration_ms: 0,
    attempts: 1,
    dry_run: process.env.INPUT_DRY_RUN === 'true',
    error: {
      message: `Publisher crashed via ${kind}: ${message}`,
      cause: 'Uncaught error or unhandled promise rejection in the docker-mcp-catalog publisher.',
      action: 'See the stack trace on stderr above; fix the failing await/throw.',
    },
  };
  process.stdout.write(JSON.stringify(failed) + '\n');
}

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

  try {
    const output = await publishDockerMcpCatalog({
      mcp_name: mcpName,
      version,
      pipeline_run_id: pipelineRunId,
      dry_run: dryRun,
      repo_root: process.cwd(),
    });
    process.stdout.write(JSON.stringify(output) + '\n');
    return output.status === 'failed' ? 1 : 0;
  } catch (err) {
    emitCrash('uncaughtException', err);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    emitCrash('unhandledRejection', err);
    process.exit(1);
  });
