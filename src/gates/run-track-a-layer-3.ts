import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ErrorReport } from '../schemas/error-report.schema.js';

const TSC_OBSERVATION_CHARS = 2000;
const DOCKER_HEALTHCHECK_TIMEOUT_S = 60;

function gateError(check: string, fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>): ErrorReport {
  return { stage: 'gate', layer: 3, target: null, check, ...fields };
}

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: readonly string[], opts: { cwd: string }) => ExecResult;

export interface RunTrackALayer3Options {
  repoRoot: string;
  mcpName: string;
  pipelineRunId?: string;
  /** When true, skip the Docker build + HEALTHCHECK probe. Useful in environments without Docker. */
  skipDocker?: boolean;
  /** When true, skip the npx-install structural probe. */
  skipNpxProbe?: boolean;
  /** Test seam — defaults to spawnSync. */
  exec?: Exec;
}

export interface TrackALayer3Result {
  passed: boolean;
  mcpName: string;
  checks_run: string[];
  errors: ErrorReport[];
  log: { event: 'gate.layer_3_passed' | 'gate.layer_3_failed'; pipeline_run_id?: string };
}

function defaultExec(cmd: string, args: readonly string[], opts: { cwd: string }): ExecResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function trimTscError(stderr: string, stdout: string): string {
  const combined = `${stdout}\n${stderr}`.trim();
  return combined.slice(-TSC_OBSERVATION_CHARS);
}

async function checkNpmBuild(mcpFolder: string, exec: Exec): Promise<ErrorReport | null> {
  const install = exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: mcpFolder });
  if (install.status !== 0) {
    return gateError('npm_install', {
      observation: `npm install failed (exit ${install.status}): ${install.stderr.trim().slice(-TSC_OBSERVATION_CHARS) || install.stdout.trim().slice(-TSC_OBSERVATION_CHARS)}.`,
      cause: 'Dependency installation failed on the runner.',
      action: 'Run `npm install` locally inside pending-to-publish/<mcp>/ to reproduce, fix the dependency or registry issue, then re-tag.',
    });
  }
  const build = exec('npm', ['run', 'build'], { cwd: mcpFolder });
  if (build.status !== 0) {
    return gateError('npm_build', {
      observation: trimTscError(build.stderr, build.stdout),
      cause: 'The MCP source has TypeScript errors that prevent the build from completing.',
      action: "Fix TypeScript build errors locally with 'npm run build' and push a fix commit, then re-run.",
    });
  }
  return null;
}

/**
 * Static check: the Dockerfile and the MCP source must agree on transport.
 *
 * Surfaces a class of bug that bit EAD_Enterprise_Suite_MCP v1.2.0–1.2.2 and
 * GoCertius_MCP v1.1.0–1.1.2 on 2026-05-26 — the Dockerfile declared
 * `HEALTHCHECK CMD fetch http://localhost:8080/healthz` but did NOT set
 * `ENV MCP_TRANSPORT=http`. `selectTransport()` defaults to stdio when the env
 * is unset; the container never binds port 8080; the HEALTHCHECK wait loop
 * times out at 60s. Each failed iteration cost ~5 minutes of CI; this check
 * surfaces the same mismatch in under a second with a clear remediation.
 *
 * Detects:
 *   - HEALTHCHECK probes HTTP (`http://` or `https://` substring after merging
 *     line continuations) AND
 *   - No `ENV MCP_TRANSPORT=http` or `ENV TRANSPORT=http` line
 *
 * Soft passes when:
 *   - No Dockerfile (checkDockerImage handles that)
 *   - No HEALTHCHECK
 *   - HEALTHCHECK uses non-HTTP probe (process check, custom script)
 *   - Transport env is set (either name)
 */
async function checkDockerfileContract(mcpFolder: string): Promise<ErrorReport | null> {
  const dockerfilePath = path.join(mcpFolder, 'Dockerfile');
  let content: string;
  try {
    content = await fs.readFile(dockerfilePath, 'utf8');
  } catch {
    return null;
  }

  // Backslash line continuations are how multi-line HEALTHCHECK is normally
  // written. Merge them so the directive is one logical line for matching.
  const merged = content.replace(/\\\s*\n\s*/g, ' ');
  const healthcheckMatch = merged.match(/^\s*HEALTHCHECK\b[^\n]*/im);
  if (!healthcheckMatch) {
    return null;
  }

  const probesHttp = /https?:\/\//.test(healthcheckMatch[0]);
  if (!probesHttp) {
    return null;
  }

  // Accept either env var name: MCP_TRANSPORT (generated MCPs) or TRANSPORT
  // (ead-factory and other hand-authored MCPs). `ENV NAME=value` and
  // `ENV NAME value` are both valid Docker syntax.
  const hasTransportEnv = /^\s*ENV\s+(MCP_TRANSPORT|TRANSPORT)\s*[=\s]\s*["']?http\b/im.test(content);
  if (hasTransportEnv) {
    return null;
  }

  return gateError('dockerfile_contract', {
    observation: `Dockerfile declares a HEALTHCHECK that probes HTTP (http:// or https://) but does not set ENV MCP_TRANSPORT=http (or ENV TRANSPORT=http). The container will default to stdio, never bind any port, and the HEALTHCHECK will time out after ${DOCKER_HEALTHCHECK_TIMEOUT_S}s.`,
    cause: "MCP transport selection (src/core/transport/select.ts in MCPs generated by @suite/generator, src/config.ts in ead-factory) defaults to stdio when the transport env is unset. Stdio does not open any port, so the HEALTHCHECK probe has nothing to reach.",
    action: "Add `ENV MCP_TRANSPORT=http` to the Dockerfile (for MCPs from @suite/generator) or `ENV TRANSPORT=http` (for ead-factory and other hand-authored MCPs that read TRANSPORT). Place it between USER and PORT/EXPOSE so the HTTP server starts before the first HEALTHCHECK probe.",
  });
}

async function checkDockerImage(
  mcpFolder: string,
  imageName: string,
  exec: Exec,
): Promise<ErrorReport | null> {
  const dockerfile = path.join(mcpFolder, 'Dockerfile');
  try {
    await fs.access(dockerfile);
  } catch {
    return gateError('docker_build', {
      observation: `No Dockerfile present at ${dockerfile}.`,
      cause: 'Track A publishes to Docker Hub + the Docker MCP Catalog, so a Dockerfile is required.',
      action: 'Add a Dockerfile at the MCP root (multi-stage build recommended; see existing g-digital MCPs for a template), then re-tag.',
    });
  }
  const build = exec('docker', ['build', '--tag', imageName, '.'], { cwd: mcpFolder });
  if (build.status !== 0) {
    return gateError('docker_build', {
      observation: `docker build failed (exit ${build.status}): ${(build.stderr || build.stdout).trim().slice(-TSC_OBSERVATION_CHARS)}.`,
      cause: 'The Dockerfile produces a non-zero exit during image build.',
      action: 'Run `docker build .` locally inside the MCP folder to reproduce, fix the failing layer, then re-tag.',
    });
  }
  const run = exec(
    'docker',
    ['run', '--detach', '--name', imageName, '--rm', imageName],
    { cwd: mcpFolder },
  );
  if (run.status !== 0) {
    return gateError('docker_healthcheck', {
      observation: `docker run failed to start the container (exit ${run.status}): ${(run.stderr || run.stdout).trim().slice(-TSC_OBSERVATION_CHARS)}.`,
      cause: 'The container exited immediately or could not start.',
      action: 'Run `docker run --rm <image>` locally to reproduce; check the ENTRYPOINT and the server bootstrap.',
    });
  }
  const wait = exec(
    'bash',
    [
      '-c',
      `for i in $(seq 1 ${DOCKER_HEALTHCHECK_TIMEOUT_S}); do status=$(docker inspect --format='{{.State.Health.Status}}' ${imageName} 2>/dev/null || echo unknown); if [ "$status" = "healthy" ]; then exit 0; fi; if [ "$status" = "unhealthy" ]; then exit 2; fi; sleep 1; done; exit 3`,
    ],
    { cwd: mcpFolder },
  );
  exec('docker', ['stop', imageName], { cwd: mcpFolder });
  if (wait.status === 0) return null;
  if (wait.status === 2) {
    return gateError('docker_healthcheck', {
      observation: `Container's HEALTHCHECK reported 'unhealthy' within ${DOCKER_HEALTHCHECK_TIMEOUT_S}s.`,
      cause: 'The Dockerfile HEALTHCHECK command is failing inside the running container.',
      action: 'Run the HEALTHCHECK command interactively inside the container (docker exec) to see why it fails, fix it, then re-tag.',
    });
  }
  if (wait.status === 3) {
    return gateError('docker_healthcheck', {
      observation: `Container did not reach 'healthy' within ${DOCKER_HEALTHCHECK_TIMEOUT_S}s.`,
      cause: 'HEALTHCHECK is either missing, too slow, or the container is stuck initializing.',
      action: 'Ensure the Dockerfile declares HEALTHCHECK and the command reports healthy within 60s; if startup is genuinely slower, add a HEALTHCHECK --start-period.',
    });
  }
  return gateError('docker_healthcheck', {
    observation: `HEALTHCHECK wait script exited unexpectedly (status ${wait.status}): ${(wait.stderr || wait.stdout).trim().slice(-TSC_OBSERVATION_CHARS)}.`,
    cause: 'The HEALTHCHECK probe could not be polled (Docker daemon issue?).',
    action: 'Verify Docker is running on the runner, then re-run.',
  });
}

async function checkNpxInstall(
  mcpFolder: string,
  exec: Exec,
): Promise<ErrorReport | null> {
  let pkgRaw: string;
  try {
    pkgRaw = await fs.readFile(path.join(mcpFolder, 'package.json'), 'utf8');
  } catch {
    return gateError('npx_install', {
      observation: `package.json missing in ${mcpFolder}.`,
      cause: 'Track A publishes to npm, so package.json must be present.',
      action: 'Run /prep-mcp <mcp-name> to regenerate the artifact and commit the result.',
    });
  }
  const pkg = JSON.parse(pkgRaw) as { bin?: string | Record<string, string> };
  if (!pkg.bin) {
    return gateError('npx_install', {
      observation: 'package.json has no "bin" field.',
      cause: '`npx -y <package>` resolves the package via its bin entry; without one, consumer install instructions break.',
      action: 'Add a "bin" entry to package.json pointing at the built server entry (e.g., "bin": { "<short-name>": "dist/server.js" }), then re-tag.',
    });
  }
  const binPath = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
  if (!binPath) {
    return gateError('npx_install', {
      observation: 'package.json "bin" field is empty.',
      cause: 'npx needs at least one bin target to resolve the package.',
      action: 'Set the bin entry to the built server entry path (e.g., "dist/server.js") and re-tag.',
    });
  }
  try {
    await fs.access(path.join(mcpFolder, binPath));
  } catch {
    return gateError('npx_install', {
      observation: `package.json#bin points at '${binPath}' but the file is not present after build.`,
      cause: 'The bin entry references a file the build did not produce.',
      action: `Either fix the bin path in package.json or ensure the build emits ${binPath}, then re-tag.`,
    });
  }
  const pack = exec('npm', ['pack', '--dry-run', '--json'], { cwd: mcpFolder });
  if (pack.status !== 0) {
    return gateError('npx_install', {
      observation: `npm pack --dry-run failed (exit ${pack.status}): ${(pack.stderr || pack.stdout).trim().slice(-TSC_OBSERVATION_CHARS)}.`,
      cause: 'npm cannot build the tarball that the npm registry would receive on publish.',
      action: 'Run `npm pack --dry-run` locally to reproduce, fix the underlying packaging issue, then re-tag.',
    });
  }
  try {
    const packed = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = (packed[0]?.files ?? []).map((f) => f.path.replace(/\\/g, '/'));
    if (!files.includes(binPath.replace(/^\.\//, ''))) {
      return gateError('npx_install', {
        observation: `package.json#bin '${binPath}' is present on disk but not listed in npm pack output (files: ${files.slice(0, 5).join(', ')}...).`,
        cause: 'The bin file is excluded from the published tarball; consumers would get a broken install.',
        action: 'Add the bin path (or its parent directory glob) to package.json#files, then re-tag.',
      });
    }
  } catch (err) {
    return gateError('npx_install', {
      observation: `Could not parse 'npm pack --json' output: ${(err as Error).message}.`,
      cause: 'npm pack succeeded but produced unparseable JSON.',
      action: 'Run `npm pack --dry-run --json` locally; if the output looks fine, file a bug and bypass with workflow_dispatch + dry_run.',
    });
  }
  return null;
}

export async function runTrackALayer3(
  opts: RunTrackALayer3Options,
): Promise<TrackALayer3Result> {
  const mcpFolder = path.join(opts.repoRoot, 'pending-to-publish', opts.mcpName);
  const exec = opts.exec ?? defaultExec;
  const errors: ErrorReport[] = [];
  const checks: string[] = [];

  checks.push('npm_build');
  const buildError = await checkNpmBuild(mcpFolder, exec);
  if (buildError) {
    errors.push(buildError);
    return finalize(opts, checks, errors);
  }

  if (!opts.skipDocker) {
    // Static contract check first — catches HEALTHCHECK / transport-env
    // mismatches in <1s, before paying ~5 minutes for a doomed docker build
    // and a 60s HEALTHCHECK timeout.
    checks.push('dockerfile_contract');
    const contractError = await checkDockerfileContract(mcpFolder);
    if (contractError) {
      errors.push(contractError);
      return finalize(opts, checks, errors);
    }
    checks.push('docker');
    const dockerError = await checkDockerImage(
      mcpFolder,
      `gate-layer-3-${opts.mcpName}`,
      exec,
    );
    if (dockerError) errors.push(dockerError);
  }

  if (!opts.skipNpxProbe) {
    checks.push('npx_install');
    const npxError = await checkNpxInstall(mcpFolder, exec);
    if (npxError) errors.push(npxError);
  }

  return finalize(opts, checks, errors);
}

function finalize(
  opts: RunTrackALayer3Options,
  checks: string[],
  errors: ErrorReport[],
): TrackALayer3Result {
  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    checks_run: checks,
    errors,
    log: {
      event: passed ? 'gate.layer_3_passed' : 'gate.layer_3_failed',
      pipeline_run_id: opts.pipelineRunId,
    },
  };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 1 || argv[0]?.startsWith('-')) {
    process.stderr.write(
      'Usage: tsx src/gates/run-track-a-layer-3.ts <mcp-name> [--skip-docker] [--skip-npx-probe]\n',
    );
    return 2;
  }
  const mcpName = argv[0]!;
  const skipDocker = argv.includes('--skip-docker');
  const skipNpxProbe = argv.includes('--skip-npx-probe');

  const result = await runTrackALayer3({
    repoRoot: process.cwd(),
    mcpName,
    skipDocker,
    skipNpxProbe,
    pipelineRunId: process.env.PIPELINE_RUN_ID,
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
