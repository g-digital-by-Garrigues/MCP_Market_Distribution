import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  generateReleaseReport,
  type ReleaseReportMetadata,
} from '../reporters/release-reporter.js';
import {
  publisherOutputSchema,
  type PublisherOutput,
} from '../schemas/publisher-output.schema.js';

// Story 3.7: CLI shim invoked from the `final-report` job in publish.yml.
//
// Inputs (env vars):
//   MCP_NAME                — pipeline-internal MCP id
//   VERSION                 — semver
//   PIPELINE_RUN_ID         — correlation id from setup
//   WORKFLOW_RUN_URL        — link to this run for the report footer
//   PUBLISHER_RESULTS_JSON  — newline-separated PublisherOutput JSON strings,
//                             one per target (passed via shell heredoc)
//   OUTPUT_PATH             — where to write the markdown file
//                             (default: _bmad-output/release-reports/<mcp>-<version>.md)
//
// Stdout: the rendered markdown (so the calling shell can capture it for the
//         PR-comment upsert step).
// Exit 0 always — a failed publisher does not make report rendering fail;
// the report's purpose is to surface that failure.

function parseOutputs(raw: string): PublisherOutput[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `PUBLISHER_RESULTS_JSON line ${i + 1} is not valid JSON: ${(err as Error).message}\n  > ${line.slice(0, 200)}`,
      );
    }
    return publisherOutputSchema.parse(parsed);
  });
}

async function main(): Promise<number> {
  const mcpName = process.env.MCP_NAME ?? '';
  const version = process.env.VERSION ?? '';
  const pipelineRunId = process.env.PIPELINE_RUN_ID ?? '';
  const workflowRunUrl = process.env.WORKFLOW_RUN_URL ?? '';
  const rawResults = process.env.PUBLISHER_RESULTS_JSON ?? '';
  const explicitPath = process.env.OUTPUT_PATH;

  if (!mcpName || !version || !pipelineRunId || !workflowRunUrl) {
    process.stderr.write(
      `render-release-report requires MCP_NAME, VERSION, PIPELINE_RUN_ID, WORKFLOW_RUN_URL env vars\n`,
    );
    return 2;
  }

  const outputs = parseOutputs(rawResults);
  const metadata: ReleaseReportMetadata = {
    mcp_name: mcpName,
    version,
    pipeline_run_id: pipelineRunId,
    workflow_run_url: workflowRunUrl,
  };

  const markdown = generateReleaseReport({ outputs, metadata });

  const outputPath =
    explicitPath ?? path.join('_bmad-output', 'release-reports', `${mcpName}-v${version}.md`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, markdown, 'utf8');

  process.stdout.write(markdown);
  process.stderr.write(`Wrote release report to ${outputPath}\n`);
  return 0;
}

void main().then((code) => process.exit(code));
