import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  errorReportSchema,
  type ErrorReport,
} from '../schemas/error-report.schema.js';

export interface GateReportLike {
  passed?: boolean;
  mcpName?: string;
  errors?: unknown[];
  log?: { event?: string; pipeline_run_id?: string };
}

export interface AggregatedErrorReport {
  pipeline_run_id: string;
  mcpName: string | null;
  has_failures: boolean;
  source_reports: Array<{ path: string; passed: boolean; error_count: number }>;
  errors: ErrorReport[];
}

export interface AggregateOptions {
  inputs: Array<{ path: string; raw: string }>;
  pipelineRunId: string;
}

export function aggregateErrorReports(opts: AggregateOptions): AggregatedErrorReport {
  const errors: ErrorReport[] = [];
  const source_reports: AggregatedErrorReport['source_reports'] = [];
  let mcpName: string | null = null;

  for (const input of opts.inputs) {
    let parsed: GateReportLike;
    try {
      parsed = JSON.parse(input.raw) as GateReportLike;
    } catch (err) {
      throw new Error(`${input.path}: not valid JSON — ${(err as Error).message}`);
    }
    const passed = parsed.passed === true;
    if (parsed.mcpName && !mcpName) mcpName = parsed.mcpName;
    const layerErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
    for (const candidate of layerErrors) {
      const result = errorReportSchema.safeParse(candidate);
      if (!result.success) {
        throw new Error(
          `${input.path}: error entry failed errorReportSchema validation — ${result.error.message}`,
        );
      }
      errors.push(result.data);
    }
    source_reports.push({ path: input.path, passed, error_count: layerErrors.length });
  }

  return {
    pipeline_run_id: opts.pipelineRunId,
    mcpName,
    has_failures: errors.length > 0,
    source_reports,
    errors,
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--pipeline-run-id');
  if (idIdx < 0 || !args[idIdx + 1]) {
    process.stderr.write(
      'Usage: tsx src/ci/aggregate-error-reports.ts <report.json>... --pipeline-run-id <id>\n',
    );
    return 2;
  }
  const pipelineRunId = args[idIdx + 1]!;
  const reportPaths = args.filter((a, i) => i !== idIdx && i !== idIdx + 1 && !a.startsWith('-'));
  if (reportPaths.length === 0) {
    process.stderr.write('At least one report path is required.\n');
    return 2;
  }
  const inputs: AggregateOptions['inputs'] = [];
  for (const p of reportPaths) {
    try {
      inputs.push({ path: p, raw: await fs.readFile(p, 'utf8') });
    } catch (err) {
      process.stderr.write(`Skipping ${p}: ${(err as Error).message}\n`);
    }
  }
  if (inputs.length === 0) {
    process.stderr.write('No readable report files; nothing to aggregate.\n');
    return 1;
  }
  try {
    const aggregated = aggregateErrorReports({ inputs, pipelineRunId });
    process.stdout.write(JSON.stringify(aggregated, null, 2) + '\n');
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
