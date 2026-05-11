import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { AggregatedErrorReport } from './aggregate-error-reports.js';

export interface RenderOptions {
  aggregated: AggregatedErrorReport;
  workflowRunUrl?: string;
}

const HEADER = '## ❌ Pipeline gate failed';

export function renderErrorReportMarkdown(opts: RenderOptions): string {
  const { aggregated, workflowRunUrl } = opts;
  const lines: string[] = [];
  lines.push(`<!-- error-report:${aggregated.pipeline_run_id} -->`);
  lines.push(HEADER);
  lines.push('');
  lines.push(`**MCP:** \`${aggregated.mcpName ?? '(unknown)'}\``);
  lines.push(`**Pipeline run:** \`${aggregated.pipeline_run_id}\``);
  if (workflowRunUrl) {
    lines.push(`**Workflow run:** ${workflowRunUrl}`);
  }
  lines.push('');
  if (!aggregated.has_failures) {
    lines.push('_No structured errors were emitted. Check the workflow logs for the failing job._');
    return lines.join('\n') + '\n';
  }
  for (const err of aggregated.errors) {
    const heading = err.layer != null
      ? `### ${err.stage} · Layer ${err.layer} · \`${err.check}\``
      : err.target
        ? `### ${err.stage} · target \`${err.target}\` · \`${err.check}\``
        : `### ${err.stage} · \`${err.check}\``;
    lines.push(heading);
    lines.push('');
    lines.push(`- **Observation:** ${err.observation}`);
    lines.push(`- **Cause:** ${err.cause}`);
    lines.push(`- **Action:** ${err.action}`);
    if (err.source_path) {
      lines.push(`- **Source:** \`${err.source_path}\``);
    }
    if (err.level && err.level !== 'error') {
      lines.push(`- **Level:** ${err.level}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0]?.startsWith('-')) {
    process.stderr.write(
      'Usage: tsx src/ci/render-error-report-markdown.ts <aggregated.json> [--workflow-run-url <url>]\n',
    );
    return 2;
  }
  const reportPath = args[0]!;
  const urlIdx = args.indexOf('--workflow-run-url');
  const workflowRunUrl = urlIdx >= 0 ? args[urlIdx + 1] : undefined;
  const raw = await fs.readFile(reportPath, 'utf8');
  const aggregated = JSON.parse(raw) as AggregatedErrorReport;
  process.stdout.write(renderErrorReportMarkdown({ aggregated, workflowRunUrl }));
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
