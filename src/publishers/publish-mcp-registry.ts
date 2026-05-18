import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { dryRunEnabled } from '../ci/dry-run.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  loadDistributionConfig,
  DistributionConfigError,
} from '../distribution/load-distribution-config.js';
import type { DistributionConfig } from '../schemas/distribution-config.schema.js';
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

// Story 3.4: MCP Official Registry publisher.
//
// Drives the `mcp-publisher` CLI (https://github.com/modelcontextprotocol/registry):
//   1. `mcp-publisher login github-oidc` — exchanges the workflow's
//      $ACTIONS_ID_TOKEN_REQUEST_TOKEN for a registry session. This is
//      transparent: no client secret to manage.
//   2. `mcp-publisher publish --dry-run` — pre-flight validates server.json
//      against the registry schema. We always run this even in real mode,
//      because catching a schema error pre-publish is cheaper than after.
//   3. `mcp-publisher publish` — the real call. Skipped in dry_run mode.
//
// The registry's reverse-DNS namespace `io.github.<owner>/*` is auto-claimed
// by the first OIDC publish from that GitHub org's repo — no manual
// pre-registration. Subsequent publishes overwrite the version_detail.
//
// We pin the mcp-publisher CLI version to keep CI deterministic; bumping
// is a deliberate change to MCP_PUBLISHER_VERSION below.

// Bumped 2026-05-14 from 1.2.0 → 1.7.9 to fix OIDC audience mismatch:
// the registry server (v1.7.6+) requires the JWT audience to be
// `https://registry.modelcontextprotocol.io`, but mcp-publisher v1.2.0
// hardcoded `mcp-registry` and got a 401 'invalid audience' on every
// `login github-oidc` call. v1.7.x ships the matching client audience.
export const MCP_PUBLISHER_VERSION = '1.7.9';

export interface PublishMcpRegistryInput {
  readonly mcp_name: string;
  readonly version: string;
  readonly pipeline_run_id: string;
  readonly dry_run: boolean;
  /** pending-to-publish/<mcp_name>/ — must contain a generated server.json. */
  readonly package_dir: string;
  /** Repo root for reading mcp-pipeline.yaml. */
  readonly repo_root: string;
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

export interface PublishMcpRegistryDeps {
  exec?: ExecFn;
  probeExec?: ProbeExecFn;
  probeOptions?: Pick<CheckOptions, 'retryDelaysMs' | 'sleep'>;
  now?: () => number;
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv;
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

function registryUrl(reverseDnsName: string): string {
  return `https://registry.modelcontextprotocol.io/v0/servers/${reverseDnsName}`;
}

async function assertServerJsonExists(packageDir: string): Promise<void> {
  const serverJsonPath = path.join(packageDir, 'server.json');
  await fs.access(serverJsonPath);
}

export async function publishMcpRegistry(
  input: PublishMcpRegistryInput,
  deps: PublishMcpRegistryDeps = {},
): Promise<PublisherOutput> {
  const exec = deps.exec ?? defaultExec;
  const probeExec = deps.probeExec;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;

  const isDryRun = dryRunEnabled({ input: String(input.dry_run), env: env.DRY_RUN });
  const started = now();
  const baseEvent = {
    mcp_name: input.mcp_name,
    version: input.version,
    pipeline_run_id: input.pipeline_run_id,
    target: 'mcp-publisher',
    dry_run: isDryRun,
  };
  log.info('target.publish_started', baseEvent);

  let distribution: DistributionConfig;
  try {
    distribution = await loadDistributionConfig(input.repo_root, input.mcp_name);
  } catch (err) {
    const duration = now() - started;
    log.error('target.publish_failed', { ...baseEvent, reason: 'config_load_failed' });
    const msg = err instanceof DistributionConfigError ? err.message : (err as Error).message;
    return validate({
      target: 'mcp-publisher',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('mcp-publisher', input.mcp_name, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message: msg,
        cause: `.distribution.yaml missing or invalid for '${input.mcp_name}'.`,
        action: `Ensure the MCP repo has a valid .distribution.yaml with reverse_dns_name set.`,
      },
    });
  }

  const reverseDnsName = distribution.reverse_dns_name;

  try {
    await assertServerJsonExists(input.package_dir);
  } catch {
    const duration = now() - started;
    log.error('target.publish_failed', { ...baseEvent, reason: 'server_json_missing' });
    return validate({
      target: 'mcp-publisher',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('mcp-publisher', reverseDnsName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message: `pending-to-publish/${input.mcp_name}/server.json is missing.`,
        cause: 'mcp-publisher requires a generated server.json next to the publish call.',
        action: `Re-run /prep-mcp ${input.mcp_name} ${input.version} so Story 1.6's generator writes server.json into pending-to-publish/${input.mcp_name}/.`,
      },
    });
  }

  // Idempotency check (Story 3.1). The registry probe takes the canonical
  // reverse-DNS name and returns the live version_detail.version.
  const probe = await checkTargetVersion('mcp-publisher', reverseDnsName, {
    ...(probeExec ? { exec: probeExec } : {}),
    ...(deps.probeOptions ?? {}),
  });
  if (probe.status === 'present' && probe.version === input.version) {
    const duration = now() - started;
    log.info('target.publish_skipped', { ...baseEvent, reason: 'already_published' });
    return validate({
      target: 'mcp-publisher',
      status: 'skipped',
      target_url: registryUrl(reverseDnsName),
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
      target: 'mcp-publisher',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('mcp-publisher', reverseDnsName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: probe.attempts,
      dry_run: isDryRun,
      error: {
        message: probe.error.message,
        cause: 'MCP Registry search API repeatedly failed; cannot confirm idempotency.',
        action: 'Check https://github.com/modelcontextprotocol/registry/issues for an active outage and retry /retry-publish?step=mcp-publisher.',
      },
    });
  }

  // OIDC login. We always do this — the registry session is required for
  // both `publish --dry-run` and `publish`, so dry-run still hits this step.
  const loginResult = await exec('mcp-publisher', ['login', 'github-oidc'], { cwd: input.package_dir });
  if (loginResult.exitCode !== 0) {
    const duration = now() - started;
    // Surface the CLI's raw stdout + stderr to OUR stderr so the workflow
    // log shows the exact failure reason inline. Without this, the only
    // signal is the orchestrator's structured event with `reason:
    // 'oidc_login_failed'` — the CLI's actual error message gets buried
    // inside the PublisherOutput JSON that bash echoes at the very end of
    // the step, and engineers have to scroll/grep to find it.
    process.stderr.write(
      `[mcp-publisher login github-oidc] exit ${loginResult.exitCode}\n--- stdout ---\n${loginResult.stdout}\n--- stderr ---\n${loginResult.stderr}\n--- end ---\n`,
    );
    log.error('target.publish_failed', {
      ...baseEvent,
      reason: 'oidc_login_failed',
      exit_code: loginResult.exitCode,
      stderr_excerpt: loginResult.stderr.trim().slice(0, 400),
    });
    return validate({
      target: 'mcp-publisher',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('mcp-publisher', reverseDnsName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: probe.attempts,
      dry_run: isDryRun,
      error: {
        message: `mcp-publisher login github-oidc exited ${loginResult.exitCode}: ${loginResult.stderr.trim().slice(0, 400)}`,
        cause: 'OIDC token exchange with the MCP Registry failed.',
        action: 'Verify the workflow has `permissions: id-token: write` and the runner is a GitHub-hosted runner (self-hosted runners cannot mint OIDC tokens by default).',
      },
    });
  }

  // Dry-run preflight — ALWAYS run, including in real publish mode, so a
  // schema error surfaces before we mutate the registry.
  const preflight = await exec('mcp-publisher', ['publish', '--dry-run'], { cwd: input.package_dir });
  if (preflight.exitCode !== 0) {
    // Expected-in-dry-run case: the registry's `publish --dry-run` does
    // BOTH schema validation AND package-ownership verification in a
    // single server-side call. The ownership check verifies that the npm
    // package referenced in server.json actually exists on npmjs.com.
    // In our dry-run, npm hasn't published yet (publish-npm runs in dry-
    // run mode too), so the registry gets a 404 looking up the package —
    // not a real bug.
    //
    // We treat the "NPM package ... not found (status: 404)" error as
    // expected-in-dry-run and continue to the success branch. Any other
    // error (schema mismatch, namespace conflict, malformed json, etc.)
    // still fails the gate.
    const isPackageNotFoundInDryRun =
      isDryRun &&
      /NPM package .* not found.*status:\s*404/i.test(preflight.stderr);

    if (!isPackageNotFoundInDryRun) {
      const duration = now() - started;
      // Surface the CLI output to OUR stderr so the workflow log shows the
      // actual schema error inline (same rationale as the login-failure
      // branch added in PR #50).
      process.stderr.write(
        `[mcp-publisher publish --dry-run] exit ${preflight.exitCode}\n--- stdout ---\n${preflight.stdout}\n--- stderr ---\n${preflight.stderr}\n--- end ---\n`,
      );
      log.error('target.publish_failed', {
        ...baseEvent,
        reason: 'dry_run_validation_failed',
        exit_code: preflight.exitCode,
        stderr_excerpt: preflight.stderr.trim().slice(0, 400),
      });
      return validate({
        target: 'mcp-publisher',
        status: 'failed',
        target_url: dryRunPlaceholderUrl('mcp-publisher', reverseDnsName, input.version),
        version_published: null,
        duration_ms: duration,
        attempts: probe.attempts + 1,
        dry_run: isDryRun,
        error: {
          message: `mcp-publisher publish --dry-run exited ${preflight.exitCode}: ${preflight.stderr.trim().slice(0, 400)}`,
          cause: classifyRegistryFailure(preflight.stderr),
          action: `Open pending-to-publish/${input.mcp_name}/server.json and fix the reported issue. Layer 1 (Story 2.2) should normally catch these — file an issue if this fired without Layer 1 also failing.`,
        },
      });
    }

    // Expected dry-run case: surface as a structured info event (not
    // error) so engineers see in the log that the schema passed and
    // only the package-ownership check failed because npm hasn't
    // published yet.
    log.info('target.publish_skipped', {
      ...baseEvent,
      reason: 'dry_run_package_not_published_yet',
      detail: 'mcp-publisher schema validation passed; ownership check skipped because npm has no real package in dry-run.',
    });
  }

  if (isDryRun) {
    const duration = now() - started;
    log.info('target.publish_succeeded', { ...baseEvent, attempts: probe.attempts + 1, mode: 'dry_run_validation_only' });
    return validate({
      target: 'mcp-publisher',
      status: 'succeeded',
      target_url: dryRunPlaceholderUrl('mcp-publisher', reverseDnsName, input.version),
      version_published: input.version,
      duration_ms: duration,
      attempts: probe.attempts + 1,
      dry_run: true,
    });
  }

  // Real publish.
  const publishResult = await exec('mcp-publisher', ['publish'], { cwd: input.package_dir });
  if (publishResult.exitCode !== 0) {
    // Idempotency: the registry returns 400 with "cannot publish duplicate
    // version" when this exact (name, version) tuple is already in its
    // database. The probe at the top of the function only checks the
    // LATEST version in version_detail — if v1.0.1 was published earlier
    // but a higher version became "latest" since, or if the probe missed
    // it for any reason (race, cached response, etc.), we'd land here.
    // Treat this as 'skipped' instead of 'failed' so a re-run of a
    // partially-failed release doesn't flip the report to red just
    // because mcp-publisher had nothing to do this time.
    if (isDuplicateVersionError(publishResult.stderr)) {
      const duration = now() - started;
      log.info('target.publish_skipped', {
        ...baseEvent,
        reason: 'version_already_in_registry',
        stderr_excerpt: publishResult.stderr.trim().slice(0, 400),
      });
      return validate({
        target: 'mcp-publisher',
        status: 'skipped',
        target_url: registryUrl(reverseDnsName),
        version_published: input.version,
        duration_ms: duration,
        attempts: probe.attempts + 2,
        dry_run: isDryRun,
      });
    }

    const duration = now() - started;
    process.stderr.write(
      `[mcp-publisher publish] exit ${publishResult.exitCode}\n--- stdout ---\n${publishResult.stdout}\n--- stderr ---\n${publishResult.stderr}\n--- end ---\n`,
    );
    log.error('target.publish_failed', {
      ...baseEvent,
      reason: 'mcp_publisher_failed',
      exit_code: publishResult.exitCode,
      stderr_excerpt: publishResult.stderr.trim().slice(0, 400),
    });
    return validate({
      target: 'mcp-publisher',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('mcp-publisher', reverseDnsName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: probe.attempts + 2,
      dry_run: isDryRun,
      error: {
        message: `mcp-publisher publish exited ${publishResult.exitCode}: ${publishResult.stderr.trim().slice(0, 400)}`,
        cause: classifyRegistryFailure(publishResult.stderr),
        action: remediationForRegistryFailure(publishResult.stderr, input.mcp_name),
      },
    });
  }

  const duration = now() - started;
  log.info('target.publish_succeeded', {
    ...baseEvent,
    attempts: probe.attempts + 2,
  });
  return validate({
    target: 'mcp-publisher',
    status: 'succeeded',
    target_url: registryUrl(reverseDnsName),
    version_published: input.version,
    duration_ms: duration,
    attempts: probe.attempts + 2,
    dry_run: false,
    metadata: { reverse_dns_name: reverseDnsName, cli_version: MCP_PUBLISHER_VERSION },
  });
}

// Detects the registry's "this exact version is already published" error,
// which mcp-publisher v1.7.x surfaces as a 400 with body
// {"errors":[{"message":"invalid version: cannot publish duplicate version"}]}.
// We also accept the older 409 + "version already published" wording in case
// the registry tightens or relaxes the contract.
function isDuplicateVersionError(stderr: string): boolean {
  return (
    /cannot publish duplicate version/i.test(stderr) ||
    /version.*already published/i.test(stderr) ||
    /status:?\s*409/i.test(stderr)
  );
}

function classifyRegistryFailure(stderr: string): string {
  if (/schema|validation/i.test(stderr)) {
    return 'server.json does not conform to the registry schema.';
  }
  if (/version.*already published|409/i.test(stderr)) {
    return 'Version conflict — that exact version is already in the registry. Bump the version and retry.';
  }
  if (/namespace|unauthorized|forbidden/i.test(stderr)) {
    return 'Registry rejected the publish for the requested namespace. The reverse-DNS name must match the GitHub org running the workflow (io.github.<owner>/*).';
  }
  if (/package.*ownership|verification|mcpName/i.test(stderr)) {
    return 'Package-ownership verification failed: the published npm/Docker package does not declare the matching MCP name.';
  }
  if (/timeout|ECONN|network/i.test(stderr)) {
    return 'Transient network failure talking to registry.modelcontextprotocol.io.';
  }
  return 'mcp-publisher exited non-zero for an unclassified reason — see stderr.';
}

function remediationForRegistryFailure(stderr: string, mcpName: string): string {
  if (/mcpName|ownership/i.test(stderr)) {
    return `Add a top-level "mcpName" field to pending-to-publish/${mcpName}/package.json that matches server.json#name, then re-run /retry-publish?step=mcp-publisher.`;
  }
  if (/namespace|unauthorized/i.test(stderr)) {
    return `Verify pending-to-publish/${mcpName}/server.json's "name" is "io.github.g-digital-by-Garrigues/<something>". The first segment must match the GitHub org running publish.yml.`;
  }
  return `Inspect the mcp-publisher output above, fix the underlying issue, then /retry-publish?step=mcp-publisher.`;
}

function validate(output: PublisherOutput): PublisherOutput {
  publisherOutputSchema.parse(output);
  return output;
}
