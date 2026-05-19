import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ErrorReport } from '../schemas/error-report.schema.js';

// Story 5.10b: Track C — Layer 2 (`mcpb validate`).
//
// Single shell-out to the official mcpb CLI's validate command, which
// re-parses the manifest.json against the v0.3 schema and checks the
// bundle layout (entry_point present, node_modules populated,
// manifest_version supported, etc.). This catches drift between our
// generator and upstream spec changes that Layer 1's hand-rolled lint
// might miss — e.g. a new required field added in manifest 0.4 that
// our template still emits as 0.3 would fail here.
//
// CONTRACT: `mcpb validate <path>` expects a PATH to a manifest JSON
// OR to a project DIRECTORY containing manifest.json. It does NOT
// accept a packed `.mcpb` ZIP archive — passing the ZIP returns
// "Invalid JSON in manifest file: Unexpected token P..." because the
// CLI JSON.parse()s the file directly. We pass the PRE-PACK bundle
// directory (the staging tree produced by run-mcpb-adapter-build.ts
// just BEFORE the `mcpb pack` step), which has manifest.json at the
// root and server/ alongside. Regression: caught in run #26108618427
// when we initially passed the .mcpb path.
//
// We pin the CLI version to match the generator (Story 5.9d's
// MCPB_CLI_PACKAGE constant) so a wire-format drift in a new mcpb
// release can't silently pass through CI.

const MCPB_CLI_PACKAGE = '@anthropic-ai/mcpb@^2.1.2';
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

function gateError(
  check: string,
  fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>,
): ErrorReport {
  return { stage: 'gate', layer: 2, target: 'smithery', check, ...fields };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ExecResult>;

export interface TrackCLayer2CheckResult {
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackCLayer2Result {
  passed: boolean;
  mcpName: string;
  checks: TrackCLayer2CheckResult[];
  errors: ErrorReport[];
  log: {
    event: 'gate.track_c_layer_2_passed' | 'gate.track_c_layer_2_failed';
    pipeline_run_id?: string;
  };
}

export interface RunTrackCLayer2Options {
  mcpName: string;
  /**
   * Absolute path to the PRE-PACK bundle directory (the staging tree
   * produced by run-mcpb-adapter-build.ts containing manifest.json +
   * server/). NOT the packed `.mcpb` ZIP — see the contract note at
   * the top of the file.
   */
  bundleDir: string;
  pipelineRunId?: string;
  timeoutMs?: number;
}

export interface RunTrackCLayer2Deps {
  exec?: ExecFn;
}

function defaultExec(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    const timer =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
            stderr += `\n[timeout after ${options.timeoutMs} ms]`;
          }, options.timeoutMs)
        : null;
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${(err as Error).message}`, exitCode: -1 });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function trim(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export async function runTrackCLayer2(
  opts: RunTrackCLayer2Options,
  deps: RunTrackCLayer2Deps = {},
): Promise<TrackCLayer2Result> {
  const exec = deps.exec ?? defaultExec;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // `mcpb validate <projectDir>` reads manifest.json from the dir +
  // checks the surrounding layout. `npx --yes` accepts the implicit
  // install prompt; the package is pinned via MCPB_CLI_PACKAGE.
  const result = await exec(
    'npx',
    ['--yes', MCPB_CLI_PACKAGE, 'validate', opts.bundleDir],
    { timeoutMs },
  );

  if (result.exitCode === 0) {
    return {
      passed: true,
      mcpName: opts.mcpName,
      checks: [{ name: 'mcpb_validate', passed: true }],
      errors: [],
      log: {
        event: 'gate.track_c_layer_2_passed',
        ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
      },
    };
  }

  const err = gateError('mcpb_validate', {
    observation: `\`mcpb validate ${path.basename(opts.bundleDir)}\` exited ${result.exitCode}: ${trim(result.stderr || result.stdout)}`,
    cause: 'The bundle directory does not satisfy the official manifest+layout schema. Most often: manifest_version drift, missing required field, or a server/ layout mismatch with the declared entry_point.',
    action: 'Inspect the stderr above. If it references a manifest field, fix templates/mcpb-adapter/manifest.json.hbs. If it references the layout, fix the staging step in generate-mcpb-bundle.ts or the CLI shim. Then re-run the adapter build with clean=true.',
    source_path: 'manifest.json',
  });

  return {
    passed: false,
    mcpName: opts.mcpName,
    checks: [{ name: 'mcpb_validate', passed: false, error: err }],
    errors: [err],
    log: {
      event: 'gate.track_c_layer_2_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const bundleDir = process.argv[3];
  if (!mcpName || !bundleDir) {
    process.stderr.write('Usage: tsx src/gates/run-track-c-layer-2.ts <mcp-name> <bundle-dir>\n');
    return 2;
  }
  const result = await runTrackCLayer2({
    mcpName,
    bundleDir,
    ...(process.env.PIPELINE_RUN_ID ? { pipelineRunId: process.env.PIPELINE_RUN_ID } : {}),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.passed ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
