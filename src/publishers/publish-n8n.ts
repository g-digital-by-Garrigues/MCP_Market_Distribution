import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { dryRunEnabled } from '../ci/dry-run.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  dryRunPlaceholderUrl,
  publisherOutputSchema,
  type PublisherOutput,
} from '../schemas/publisher-output.schema.js';
import {
  checkTargetVersion,
  type CheckOptions,
  type ExecFn as ProbeExecFn,
} from './check-target-version.js';

// Story 5.6: Track B publisher — pushes the generated n8n community
// node to npm under `<scope>/n8n-nodes-<target>`. Mirrors publish-npm.ts
// for the source MCP, with two differences:
//
//   1. package_dir points at the GENERATED adapter tree (not the source
//      MCP), so a prior workflow step has to run the adapter generator
//      and gates first. publish-n8n itself does NOT run gates; the
//      workflow ensures Track B Layer 1/2/3 have passed before getting
//      here.
//   2. Before publishing, we `npm install` + `npm run build` inside the
//      generated dir so the published tarball ships compiled JS (n8n's
//      loader expects `dist/<Class>/<Class>.node.js`). The dist/ output
//      isn't checked in to anything; it's built fresh here.
//
// Auth strategy: same as publish-npm — NPM_TOKEN if set, else OIDC +
// trusted publisher. For the FIRST publish of a new n8n node package
// the trusted publisher won't exist yet, so NPM_TOKEN is the bootstrap.

export interface PublishN8nInput {
  /** Source MCP's pipeline-internal kebab-case id (e.g. 'ead-factory'). */
  readonly mcp_name: string;
  /** Semver to publish — same as the source MCP version (FR32 alignment). */
  readonly version: string;
  /** Pipeline run correlation id. */
  readonly pipeline_run_id: string;
  /** When true, run `npm publish --dry-run` and never push. */
  readonly dry_run: boolean;
  /**
   * Absolute path to the GENERATED n8n adapter tree (a prior workflow
   * step ran generateN8nNode against this dir). Must contain a
   * package.json with the right `name` and `version`.
   */
  readonly package_dir: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export interface PublishN8nDeps {
  exec?: ExecFn;
  probeExec?: ProbeExecFn;
  probeOptions?: Pick<CheckOptions, 'retryDelaysMs' | 'sleep'>;
  now?: () => number;
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv;
  writeNpmrc?: (npmrcPath: string, content: string) => Promise<void>;
  removeNpmrc?: (npmrcPath: string) => Promise<void>;
}

function defaultExec(
  cmd: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
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
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ stdout, stderr: `${stderr}\n${(err as Error).message}`, exitCode: -1 });
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

interface PackageJsonShape {
  name: string;
  version: string;
}

async function readPackageJson(packageDir: string): Promise<PackageJsonShape> {
  const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as Partial<PackageJsonShape>;
  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    throw new Error(
      `Generated n8n adapter package.json at ${packageDir} is missing a "name" field.`,
    );
  }
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(
      `Generated n8n adapter package.json at ${packageDir} is missing a "version" field.`,
    );
  }
  return { name: parsed.name, version: parsed.version };
}

function npmTargetUrl(name: string, version: string): string {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

function failed(
  input: PublishN8nInput,
  pkgName: string,
  isDryRun: boolean,
  duration: number,
  attempts: number,
  message: string,
  cause: string,
  action: string,
): PublisherOutput {
  return validate({
    target: 'n8n',
    status: 'failed',
    target_url: dryRunPlaceholderUrl('n8n', pkgName, input.version),
    version_published: null,
    duration_ms: duration,
    attempts,
    dry_run: isDryRun,
    error: { message, cause, action },
  });
}

export async function publishN8n(
  input: PublishN8nInput,
  deps: PublishN8nDeps = {},
): Promise<PublisherOutput> {
  const exec = deps.exec ?? defaultExec;
  const probeExec = deps.probeExec;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;
  const writeNpmrc = deps.writeNpmrc ?? ((p, c) => fs.writeFile(p, c, 'utf8'));
  const removeNpmrc =
    deps.removeNpmrc ??
    (async (p) => {
      try {
        await fs.unlink(p);
      } catch {
        /* best-effort cleanup */
      }
    });

  const isDryRun = dryRunEnabled({ input: String(input.dry_run), env: env.DRY_RUN });
  const started = now();
  const baseEvent = {
    mcp_name: input.mcp_name,
    version: input.version,
    pipeline_run_id: input.pipeline_run_id,
    target: 'n8n',
    dry_run: isDryRun,
  };
  log.info('target.publish_started', baseEvent);

  let pkg: PackageJsonShape;
  try {
    pkg = await readPackageJson(input.package_dir);
  } catch (err) {
    return failed(
      input,
      input.mcp_name,
      isDryRun,
      now() - started,
      1,
      (err as Error).message,
      'The n8n adapter generator did not write a valid package.json, or the workflow passed the wrong directory.',
      `Re-run the adapter generator for ${input.mcp_name} and confirm package_dir points at the generated tree, then /retry-publish?step=n8n.`,
    );
  }

  if (pkg.version !== input.version) {
    return failed(
      input,
      pkg.name,
      isDryRun,
      now() - started,
      1,
      `Generated package.json version (${pkg.version}) does not match the requested publish version (${input.version}).`,
      'The adapter generator was invoked with a version that does not match the source MCP version.',
      `Regenerate the n8n adapter with version=${input.version} (the source MCP version), then /retry-publish?step=n8n.`,
    );
  }

  // Idempotency probe against npm.
  const probe = await checkTargetVersion('npm', pkg.name, {
    ...(probeExec ? { exec: probeExec } : {}),
    ...(deps.probeOptions ?? {}),
  });
  if (probe.status === 'present' && probe.version === input.version) {
    const duration = now() - started;
    log.info('target.publish_skipped', { ...baseEvent, reason: 'already_published', attempts: probe.attempts });
    return validate({
      target: 'n8n',
      status: 'skipped',
      target_url: npmTargetUrl(pkg.name, probe.version),
      version_published: probe.version,
      duration_ms: duration,
      attempts: probe.attempts,
      dry_run: isDryRun,
    });
  }
  if (probe.status === 'error') {
    return failed(
      input,
      pkg.name,
      isDryRun,
      now() - started,
      probe.attempts,
      probe.error.message,
      'npm view repeatedly failed; cannot confirm idempotency safely.',
      'Check https://status.npmjs.org and retry via /retry-publish?step=n8n once the registry is healthy.',
    );
  }

  // Install deps + build dist/. The generated tsconfig outDir is dist/.
  // We treat install + build failures as publisher failures (they should
  // have been caught by Track B Layer 2, but if the workflow skipped
  // that gate this is the last defense).
  const install = await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: input.package_dir });
  if (install.exitCode !== 0) {
    return failed(
      input,
      pkg.name,
      isDryRun,
      now() - started,
      probe.attempts + 1,
      `npm install in the generated n8n adapter exited ${install.exitCode}: ${install.stderr.trim().slice(0, 400)}`,
      'Cannot install the n8n adapter dependencies — likely a malformed package.json or unresolved source-MCP version.',
      'Re-run the Track B Layer 2 gate locally; if it passes, retry via /retry-publish?step=n8n.',
    );
  }

  const build = await exec('npm', ['run', 'build'], { cwd: input.package_dir });
  if (build.exitCode !== 0) {
    return failed(
      input,
      pkg.name,
      isDryRun,
      now() - started,
      probe.attempts + 2,
      `npm run build exited ${build.exitCode}: ${build.stderr.trim().slice(0, 400)}`,
      'The generated n8n adapter does not compile.',
      'Run the Track B Layer 2 gate (`pnpm tsx src/gates/run-track-b-layer-2.ts ...`) to see the full TS diagnostics, fix the codegen template, regenerate, and retry.',
    );
  }

  // Auth setup.
  const npmToken = env.NPM_TOKEN?.trim();
  const npmrcPath = path.join(input.package_dir, '.npmrc');
  const npmrcWritten = npmToken !== undefined && npmToken !== '';
  if (npmrcWritten) {
    const lines = [
      `//registry.npmjs.org/:_authToken=${npmToken}`,
      'always-auth=true',
      'registry=https://registry.npmjs.org/',
    ];
    await writeNpmrc(npmrcPath, lines.join('\n') + '\n');
  }

  try {
    const publishArgs = ['publish', '--access', 'public'];
    if (isDryRun) publishArgs.push('--dry-run');
    if (!isDryRun && !npmrcWritten) publishArgs.push('--provenance');
    const result = await exec('npm', publishArgs, {
      cwd: input.package_dir,
      env: { npm_config_userconfig: npmrcWritten ? npmrcPath : '' },
    });
    const duration = now() - started;
    if (result.exitCode !== 0) {
      log.error('target.publish_failed', {
        ...baseEvent,
        reason: 'npm_publish_failed',
        exit_code: result.exitCode,
      });
      return failed(
        input,
        pkg.name,
        isDryRun,
        duration,
        probe.attempts + 3,
        `npm publish exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
        classifyNpmFailure(result.stderr),
        remediationForNpmFailure(result.stderr, pkg.name, input.version),
      );
    }

    log.info('target.publish_succeeded', {
      ...baseEvent,
      attempts: probe.attempts + 3,
      auth_mode: npmrcWritten ? 'npm_token' : 'oidc',
    });
    return validate({
      target: 'n8n',
      status: 'succeeded',
      target_url: isDryRun
        ? dryRunPlaceholderUrl('n8n', pkg.name, input.version)
        : npmTargetUrl(pkg.name, input.version),
      version_published: input.version,
      duration_ms: duration,
      attempts: probe.attempts + 3,
      dry_run: isDryRun,
      metadata: { auth_mode: npmrcWritten ? 'npm_token' : 'oidc', package_name: pkg.name },
    });
  } finally {
    if (npmrcWritten) await removeNpmrc(npmrcPath);
  }
}

function classifyNpmFailure(stderr: string): string {
  if (/E403|forbidden/i.test(stderr)) {
    return 'npm rejected the publish (E403). Most common cause: NPM_TOKEN missing/expired, or the package name is taken by another account.';
  }
  if (/E409|conflict|cannot publish over/i.test(stderr)) {
    return 'Version conflict — that exact semver is already published. Bump the version and retry.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(stderr)) {
    return 'Transient network failure while contacting the npm registry.';
  }
  if (/OIDC|trusted publisher|provenance/i.test(stderr)) {
    return 'npm OIDC/trusted-publisher rejected the request. Verify the trusted publisher is configured on npmjs.com for this exact (repo, workflow) pair.';
  }
  return 'npm publish failed for an unclassified reason — see stderr.';
}

function remediationForNpmFailure(stderr: string, name: string, version: string): string {
  if (/E409|cannot publish over/i.test(stderr)) {
    return `Bump the source MCP version above ${version} and re-tag; the n8n adapter version tracks it 1:1 (FR32).`;
  }
  if (/OIDC|trusted publisher|provenance/i.test(stderr)) {
    const callerRepo = process.env.GITHUB_REPOSITORY ?? 'g-digital-by-Garrigues/<mcp-source-repo>';
    return `Bootstrap with NPM_TOKEN for the first publish of ${name}, then configure trusted publishing on npmjs.com at https://www.npmjs.com/package/${name}/access for repository ${callerRepo} + workflow publish.yml.`;
  }
  return `Check the npm publish output above, fix the underlying issue, then /retry-publish?step=n8n.`;
}

function validate(output: PublisherOutput): PublisherOutput {
  publisherOutputSchema.parse(output);
  return output;
}
