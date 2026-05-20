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

// Story 3.2: npm publish composite action — TypeScript core.
//
// The composite action (actions/publish-npm/action.yml) is a thin wrapper
// that invokes this module. Keeping the orchestration here (rather than in
// YAML shell scripts) means we can unit-test the publisher with mocked
// exec/fs/logger and assert the PublisherOutput shape end-to-end.
//
// Auth strategy:
//   - If process.env.NPM_TOKEN is set, write a temp ~/.npmrc with the auth
//     line and use it for `npm publish`. This is the "first publish" path:
//     the package doesn't exist yet, so we can't have a trusted publisher
//     configured for it (npm trusted-publishers are per-package).
//   - Otherwise, rely on the OIDC integration: `npm publish --provenance`
//     auto-requests an OIDC token from the GH Actions runtime, which the
//     npm registry validates against the configured trusted publisher.
//
// Once `@g-digital/mcp-ead-factory` exists post-first-publish and the
// trusted publisher is set up via the npm UI, NPM_TOKEN can be removed
// and the action transparently switches to OIDC.

export interface PublishNpmInput {
  /** Pipeline-internal kebab-case MCP id (e.g. "ead-factory"). */
  readonly mcp_name: string;
  /** Semver to publish (without leading "v"). */
  readonly version: string;
  /** Used in structured logs; correlates across the run. */
  readonly pipeline_run_id: string;
  /** When true, run `npm publish --dry-run` and never push. */
  readonly dry_run: boolean;
  /** Path to the directory containing the publishable package.json. */
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

export interface PublishNpmDeps {
  /** Inject for tests; defaults to spawn-based exec. */
  exec?: ExecFn;
  /** Probe-side exec (for the idempotency call). */
  probeExec?: ProbeExecFn;
  /** Override probe retry timing for tests. */
  probeOptions?: Pick<CheckOptions, 'retryDelaysMs' | 'sleep'>;
  /** Inject for tests; defaults to ./node_modules + Date.now. */
  now?: () => number;
  /** Inject for tests; defaults to the module-level logger. */
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
  /** Inject for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Inject for tests; defaults to writing a temp .npmrc next to the package. */
  writeNpmrc?: (npmrcPath: string, content: string) => Promise<void>;
  /** Inject for tests; defaults to deleting the temp .npmrc. */
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
      `package.json at ${packageDir} is missing a "name" field — cannot publish to npm.`,
    );
  }
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(
      `package.json at ${packageDir} is missing a "version" field.`,
    );
  }
  return { name: parsed.name, version: parsed.version };
}

function npmTargetUrl(name: string, version: string): string {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

// Top-level orchestrator. Always returns a PublisherOutput — never throws.
// The composite action serializes this as JSON to $GITHUB_OUTPUT so the
// final-report job (Story 3.7) can deserialize it.
export async function publishNpm(
  input: PublishNpmInput,
  deps: PublishNpmDeps = {},
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
        // Best-effort cleanup; .npmrc removal failure is not a publish failure.
      }
    });

  const isDryRun = dryRunEnabled({ input: String(input.dry_run), env: env.DRY_RUN });
  const started = now();
  const baseEvent = {
    mcp_name: input.mcp_name,
    version: input.version,
    pipeline_run_id: input.pipeline_run_id,
    target: 'npm',
    dry_run: isDryRun,
  };
  log.info('target.publish_started', baseEvent);

  // Read the package.json so we know the exact npm-scoped name (the npm
  // package name is NOT always the same as the pipeline-internal mcp_name
  // — e.g. internal 'ead-factory' → npm '@g-digital/mcp-ead-factory').
  let pkg: PackageJsonShape;
  try {
    pkg = await readPackageJson(input.package_dir);
  } catch (err) {
    const duration = now() - started;
    log.error('target.publish_failed', {
      ...baseEvent,
      reason: 'package_json_read_failed',
      error: (err as Error).message,
    });
    return validate({
      target: 'npm',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('npm', input.mcp_name, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message: (err as Error).message,
        cause: 'Prep Agent output is missing or malformed.',
        action: `Re-run /prep-mcp ${input.mcp_name} ${input.version} to regenerate pending-to-publish/${input.mcp_name}/package.json.`,
      },
    });
  }

  if (pkg.version !== input.version) {
    const duration = now() - started;
    const message = `package.json version (${pkg.version}) does not match the requested publish version (${input.version}).`;
    log.error('target.publish_failed', {
      ...baseEvent,
      reason: 'version_mismatch',
      package_json_version: pkg.version,
    });
    return validate({
      target: 'npm',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('npm', pkg.name, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message,
        cause: 'Prep Agent did not bump package.json#version, or the tag was created out of sync.',
        action: `Run /prep-mcp ${input.mcp_name} ${input.version} again, then re-tag from the resulting commit.`,
      },
    });
  }

  // Idempotency check (Story 3.1).
  const probe = await checkTargetVersion('npm', pkg.name, {
    ...(probeExec ? { exec: probeExec } : {}),
    ...(deps.probeOptions ?? {}),
  });
  if (probe.status === 'present' && probe.version === input.version) {
    const duration = now() - started;
    log.info('target.publish_skipped', {
      ...baseEvent,
      reason: 'already_published',
      attempts: probe.attempts,
    });
    return validate({
      target: 'npm',
      status: 'skipped',
      target_url: npmTargetUrl(pkg.name, probe.version),
      version_published: probe.version,
      duration_ms: duration,
      attempts: probe.attempts,
      dry_run: isDryRun,
    });
  }
  if (probe.status === 'error') {
    const duration = now() - started;
    log.error('target.publish_failed', {
      ...baseEvent,
      reason: 'idempotency_probe_failed',
      attempts: probe.attempts,
    });
    return validate({
      target: 'npm',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('npm', pkg.name, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: probe.attempts,
      dry_run: isDryRun,
      error: {
        message: probe.error.message,
        cause: 'npm view repeatedly failed; cannot confirm idempotency safely.',
        action: 'Check https://status.npmjs.org and retry via /retry-publish?step=npm once the registry is healthy.',
      },
    });
  }

  // Auth setup. Order of preference:
  //   1. OIDC trusted publisher — when GitHub Actions has granted
  //      `id-token: write` (signalled by ACTIONS_ID_TOKEN_REQUEST_URL +
  //      ACTIONS_ID_TOKEN_REQUEST_TOKEN being present in env). Required
  //      once npm enforces TP on the package — token publishes then
  //      get rejected with the bizarre `404 PUT` error. Caught on the
  //      v1.0.8 publish run #26156942921 right after npm's security
  //      mailout auto-invalidated all existing tokens.
  //   2. NPM_TOKEN fallback — kept for local-publish and for any future
  //      package that doesn't have TP configured yet. With TP enforced
  //      AND a token present, we deliberately ignore the token to
  //      avoid the 404 PUT trap.
  const hasOidc =
    typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_URL.length > 0 &&
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0;
  const npmToken = env.NPM_TOKEN?.trim();
  const npmrcPath = path.join(input.package_dir, '.npmrc');
  const useTokenAuth = !hasOidc && npmToken !== undefined && npmToken !== '';
  if (useTokenAuth) {
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
    // --provenance triggers the OIDC token exchange; only valid when
    // the workflow exposed id-token: write and there's no .npmrc
    // shadowing it with a long-lived token.
    if (!isDryRun && !useTokenAuth) publishArgs.push('--provenance');
    const result = await exec('npm', publishArgs, {
      cwd: input.package_dir,
      // Token path: point npm at the publisher's .npmrc with the
      // literal token. OIDC path: leave npm_config_userconfig unset
      // so npm reads the runner's default config (with whatever
      // setup-node@v4 wrote at $RUNNER_TEMP/.npmrc) and lets
      // --provenance + the ACTIONS_ID_TOKEN_REQUEST_URL env do the
      // OIDC exchange directly.
      env: useTokenAuth ? { npm_config_userconfig: npmrcPath } : {},
    });
    const duration = now() - started;
    if (result.exitCode !== 0) {
      // Surface the CLI's raw stdout + stderr to OUR stderr so the
      // workflow log shows the full error inline. Without this, the
      // only signal is the orchestrator's 400-char-trimmed
      // PublisherOutput.error.message, which masks anything past the
      // tarball-contents listing (caught on v1.0.8 publish run
      // #26156390122 where the actual failure reason was beyond the
      // trim). Same rationale + pattern as publish-mcp-registry's
      // login-failure branch.
      process.stderr.write(
        `[publish-npm] exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n--- end ---\n`,
      );
      log.error('target.publish_failed', {
        ...baseEvent,
        reason: 'npm_publish_failed',
        exit_code: result.exitCode,
      });
      return validate({
        target: 'npm',
        status: 'failed',
        target_url: dryRunPlaceholderUrl('npm', pkg.name, input.version),
        version_published: null,
        duration_ms: duration,
        attempts: probe.attempts + 1,
        dry_run: isDryRun,
        error: {
          message: `npm publish exited ${result.exitCode}: ${result.stderr.trim().slice(0, 400)}`,
          cause: classifyNpmFailure(result.stderr),
          action: remediationForNpmFailure(result.stderr, pkg.name, input.version),
        },
      });
    }

    log.info('target.publish_succeeded', {
      ...baseEvent,
      attempts: probe.attempts + 1,
      auth_mode: useTokenAuth ? 'npm_token' : 'oidc',
    });
    return validate({
      target: 'npm',
      status: 'succeeded',
      target_url: isDryRun
        ? dryRunPlaceholderUrl('npm', pkg.name, input.version)
        : npmTargetUrl(pkg.name, input.version),
      version_published: input.version,
      duration_ms: duration,
      attempts: probe.attempts + 1,
      dry_run: isDryRun,
      metadata: { auth_mode: useTokenAuth ? 'npm_token' : 'oidc' },
    });
  } finally {
    if (useTokenAuth) await removeNpmrc(npmrcPath);
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
    return `Bump the version above ${version} and re-tag, OR if this re-run is intended to be idempotent, the version was already published — re-run /retry-publish?step=npm and the idempotency check will skip.`;
  }
  if (/OIDC|trusted publisher|provenance/i.test(stderr)) {
    return `Visit https://www.npmjs.com/package/${name}/access and configure trusted publishing for repository g-digital-by-Garrigues/MCP_Market_Distribution + workflow publish.yml.`;
  }
  return `Check the npm publish output above, fix the underlying issue, then /retry-publish?step=npm.`;
}

function validate(output: PublisherOutput): PublisherOutput {
  // Defensive: every code path through this module emits a
  // PublisherOutputSchema-conforming record. If we ever drift, fail loudly
  // in tests rather than letting a malformed JSON reach the final reporter.
  publisherOutputSchema.parse(output);
  return output;
}
