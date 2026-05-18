import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ErrorReport } from '../schemas/error-report.schema.js';

// Story 5.3: Track B — Layer 2 (compile gate).
//
// Installs the generated n8n node's dependencies and runs `tsc --noEmit`
// against it. Catches type errors / missing imports / drift between the
// generator and the n8n-workflow type contract BEFORE the publisher
// would ship a broken tarball.
//
// Two checks, in order (short-circuit on first failure):
//   1. install  — pnpm install --no-frozen-lockfile in nodeDir
//   2. compile  — pnpm exec tsc --noEmit in nodeDir
//
// We use pnpm (the rest of the pipeline does) but skip the lockfile
// strictness because the generated tree has no lockfile — the install
// resolves fresh against the public registry. NFR-P3 (≤ 10 min for
// Track B end-to-end) accommodates the ~30s install cost.

function gateError(
  check: string,
  fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>,
): ErrorReport {
  return { stage: 'gate', layer: 2, target: 'n8n', check, ...fields };
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

export interface TrackBLayer2CheckResult {
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackBLayer2Result {
  passed: boolean;
  mcpName: string;
  checks: TrackBLayer2CheckResult[];
  errors: ErrorReport[];
  log: {
    event: 'gate.track_b_layer_2_passed' | 'gate.track_b_layer_2_failed';
    pipeline_run_id?: string;
  };
}

export interface RunTrackBLayer2Options {
  mcpName: string;
  /** Absolute path to the generated n8n node tree. */
  nodeDir: string;
  pipelineRunId?: string;
  /** Cap each subprocess. Defaults to 5 minutes — enough for install+tsc. */
  timeoutMs?: number;
}

export interface RunTrackBLayer2Deps {
  exec?: ExecFn;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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

async function checkInstall(
  opts: RunTrackBLayer2Options,
  exec: ExecFn,
): Promise<TrackBLayer2CheckResult> {
  const result = await exec(
    'pnpm',
    ['install', '--no-frozen-lockfile'],
    { cwd: opts.nodeDir, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (result.exitCode === 0) return { name: 'install', passed: true };
  return {
    name: 'install',
    passed: false,
    error: gateError('install', {
      observation: `pnpm install exited ${result.exitCode}: ${trim(result.stderr || result.stdout)}`,
      cause: 'Cannot install the generated n8n node\'s dependencies — likely a malformed package.json, an unresolvable source-MCP version, or a registry / network error.',
      action: 'Verify the source MCP package was published before this gate runs (publish-n8n must depend on publish-npm succeeding). Inspect the n8n node\'s generated package.json#dependencies for typos.',
      source_path: 'package.json',
    }),
  };
}

interface CompileFailure {
  observation: string;
  errorCount: number;
}

function summarizeTscFailure(stdout: string, stderr: string, exitCode: number): CompileFailure {
  // tsc writes diagnostics to stdout (one error per line, "<file>(line,col): error TSxxxx: <msg>").
  const combined = `${stdout}\n${stderr}`;
  const lines = combined.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  // Top 5 errors, trimmed, so the gate report stays readable.
  const top = lines.slice(0, 5).map((l) => l.trim());
  const observation = top.length
    ? `tsc exited ${exitCode} with ${lines.length} error(s). Sample:\n  ${top.join('\n  ')}`
    : `tsc exited ${exitCode} (no parseable diagnostics). Tail:\n${trim(combined, 800)}`;
  return { observation, errorCount: lines.length };
}

async function checkCompile(
  opts: RunTrackBLayer2Options,
  exec: ExecFn,
): Promise<TrackBLayer2CheckResult> {
  const result = await exec(
    'pnpm',
    ['exec', 'tsc', '--noEmit'],
    { cwd: opts.nodeDir, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (result.exitCode === 0) return { name: 'compile', passed: true };
  const summary = summarizeTscFailure(result.stdout, result.stderr, result.exitCode);
  return {
    name: 'compile',
    passed: false,
    error: gateError('compile', {
      observation: summary.observation,
      cause: 'The generated TypeScript does not compile — codegen drift versus the n8n-workflow / @modelcontextprotocol/sdk type contracts, or against the source MCP\'s declared types.',
      action: 'Run `pnpm exec tsc --noEmit` locally in the generated node dir to see the full error list, then patch templates/n8n-adapter/*.hbs to fix the structural mistake.',
      source_path: 'tsconfig.json',
    }),
  };
}

export async function runTrackBLayer2(
  opts: RunTrackBLayer2Options,
  deps: RunTrackBLayer2Deps = {},
): Promise<TrackBLayer2Result> {
  const exec = deps.exec ?? defaultExec;
  const checks: TrackBLayer2CheckResult[] = [];

  const installCheck = await checkInstall(opts, exec);
  checks.push(installCheck);
  if (installCheck.passed) {
    checks.push(await checkCompile(opts, exec));
  }

  const errors = checks.filter((c) => !c.passed).map((c) => c.error!);
  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    checks,
    errors,
    log: {
      event: passed ? 'gate.track_b_layer_2_passed' : 'gate.track_b_layer_2_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const nodeDir = process.argv[3];
  if (!mcpName || !nodeDir) {
    process.stderr.write('Usage: tsx src/gates/run-track-b-layer-2.ts <mcp-name> <node-dir>\n');
    return 2;
  }
  const result = await runTrackBLayer2({
    mcpName,
    nodeDir,
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
