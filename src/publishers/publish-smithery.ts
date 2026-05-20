import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import process from 'node:process';

import { dryRunEnabled } from '../ci/dry-run.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  dryRunPlaceholderUrl,
  publisherOutputSchema,
  type PublisherOutput,
} from '../schemas/publisher-output.schema.js';

// Story 5.11: Smithery publisher (MCPB-bundle flow).
//
// Replaces the v1.0 implementation that polled Smithery's repo
// auto-deploy API (model retired by Smithery in 2026). The new flow:
//   1. Verify the .mcpb bundle file exists at bundle_path.
//   2. Idempotency probe — GET smithery.ai/api/servers/<ns>/<name> and
//      treat status='skipped' (with version_published set) if the same
//      version is already live. The release-reporter renders this as
//      ♻️ already-published (see PR #98), preserving the "this release
//      reached the target" semantic.
//   3. Real publish: shell out to `smithery mcp publish <bundle> -n <ns>/<name>`
//      with SMITHERY_TOKEN in env. The Smithery CLI handles the upload,
//      verification, and Smithery-side indexing.
//   4. Idempotent error handling: when the CLI surfaces "duplicate
//      version" we also return status='skipped' instead of failed so a
//      partial-failure retry doesn't flip the report to red on this leg.
//   5. Dry-run: short-circuit BEFORE the CLI invocation. Returns
//      status='succeeded' with a placeholder URL so the release report
//      still renders consistently.

const SMITHERY_CLI_PACKAGE = '@smithery/cli@^4.11.1';
const DEFAULT_SMITHERY_NAMESPACE = 'g-digital';
const PUBLISH_TIMEOUT_MS = 5 * 60_000;

export interface PublishSmitheryInput {
  readonly mcp_name: string;
  readonly version: string;
  readonly pipeline_run_id: string;
  readonly dry_run: boolean;
  /** Absolute path to the packed .mcpb file (output of Story 5.9d CLI shim). */
  readonly bundle_path: string;
  /**
   * Smithery org namespace. Defaults to `g-digital-by-Garrigues` to
   * match our GitHub org. Future MCPs from a different org override
   * via `.distribution.yaml#smithery_namespace` (schema field added
   * when the second org onboards).
   */
  readonly smithery_namespace?: string;
}

export interface SmitheryServerInfo {
  /** Version Smithery reports as currently deployed. */
  version?: string;
  /** Status field from Smithery's API (e.g. 'active'). */
  status?: string;
}

export type SmitheryFetch = (qualifiedName: string) => Promise<SmitheryServerInfo>;

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

export interface PublishSmitheryDeps {
  fetchSmithery?: SmitheryFetch;
  exec?: ExecFn;
  now?: () => number;
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv;
}

function smitheryWebUrl(qualifiedName: string): string {
  return `https://smithery.ai/server/${qualifiedName}`;
}

async function defaultFetchSmithery(qualifiedName: string): Promise<SmitheryServerInfo> {
  const url = `https://smithery.ai/api/servers/${encodeURIComponent(qualifiedName)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) return {};
  if (!response.ok) {
    throw Object.assign(new Error(`Smithery API returned ${response.status}`), {
      status: response.status,
    });
  }
  return (await response.json()) as SmitheryServerInfo;
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

function isDuplicateVersionError(stderr: string): boolean {
  // Smithery CLI surfaces same-version-already-published as either a 409
  // or an explicit "version already exists" string. We accept both.
  return (
    /version.*already.*(?:published|exists)/i.test(stderr) ||
    /duplicate version/i.test(stderr) ||
    /status:?\s*409/i.test(stderr)
  );
}

function isMissingTokenError(stderr: string): boolean {
  return /unauthor|forbidden|401|403|missing.*token|not authenticated/i.test(stderr);
}

export async function publishSmithery(
  input: PublishSmitheryInput,
  deps: PublishSmitheryDeps = {},
): Promise<PublisherOutput> {
  const fetchSmithery = deps.fetchSmithery ?? defaultFetchSmithery;
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;

  const namespace = input.smithery_namespace ?? DEFAULT_SMITHERY_NAMESPACE;
  const qualifiedName = `${namespace}/${input.mcp_name}`;
  const isDryRun = dryRunEnabled({ input: String(input.dry_run), env: env.DRY_RUN });
  const started = now();
  const baseEvent = {
    mcp_name: input.mcp_name,
    version: input.version,
    pipeline_run_id: input.pipeline_run_id,
    target: 'smithery',
    dry_run: isDryRun,
  };
  log.info('target.publish_started', baseEvent);

  // 1. Verify the bundle file exists on disk.
  try {
    const stat = await fs.stat(input.bundle_path);
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
  } catch (err) {
    const duration = now() - started;
    log.error('target.publish_failed', { ...baseEvent, reason: 'bundle_missing' });
    return validate({
      target: 'smithery',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message: `bundle file ${input.bundle_path} not found: ${(err as Error).message}`,
        cause: 'The mcpb adapter build did not produce a packed .mcpb at the expected path, or the workflow artifact was not downloaded into this job.',
        action: 'Inspect the generate-mcpb-bundle job artifact upload and the publish-smithery job artifact download steps in publish.yml.',
      },
    });
  }

  // 2. Idempotency probe. If the registry already carries this exact
  //    version, return skipped(version_published=...) so the release
  //    reporter renders ♻️ already-published rather than wasting a
  //    publish attempt.
  let probe: SmitheryServerInfo = {};
  try {
    probe = await fetchSmithery(qualifiedName);
  } catch (err) {
    log.warn('target.publish_warn', {
      ...baseEvent,
      reason: 'idempotency_probe_failed',
      message: (err as Error).message,
    });
    // Probe failure is not fatal — proceed to publish; the CLI itself
    // will tell us about duplicates if any.
  }
  if (probe.version === input.version) {
    const duration = now() - started;
    log.info('target.publish_skipped', { ...baseEvent, reason: 'already_published' });
    return validate({
      target: 'smithery',
      status: 'skipped',
      target_url: smitheryWebUrl(qualifiedName),
      version_published: probe.version,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
    });
  }

  // 3. Dry-run: short-circuit BEFORE the CLI invocation.
  if (isDryRun) {
    const duration = now() - started;
    log.info('target.publish_succeeded', { ...baseEvent, mode: 'dry_run', attempts: 1 });
    return validate({
      target: 'smithery',
      status: 'succeeded',
      target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
      version_published: input.version,
      duration_ms: duration,
      attempts: 1,
      dry_run: true,
    });
  }

  // 4. Real publish via the Smithery CLI.
  if (!env.SMITHERY_TOKEN) {
    const duration = now() - started;
    log.error('target.publish_failed', { ...baseEvent, reason: 'smithery_token_missing' });
    return validate({
      target: 'smithery',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: false,
      error: {
        message: 'SMITHERY_TOKEN env var is not set; cannot authenticate with the Smithery CLI.',
        cause: 'The publish-smithery job is missing the SMITHERY_TOKEN secret pass-through.',
        action: 'Verify the SMITHERY_TOKEN repo secret is set and that actions/publish-smithery/action.yml forwards it as an env var.',
      },
    });
  }

  // The @smithery/cli reads `SMITHERY_API_KEY` (NOT SMITHERY_TOKEN) for
  // non-interactive auth. We accept the secret under SMITHERY_TOKEN at
  // the pipeline level (consistent with the rest of the *_TOKEN secrets)
  // but rename on the way into the CLI's child env. Source:
  // smithery-ai/cli src/utils/smithery-settings.ts + the user-visible
  // "Set SMITHERY_API_KEY=<token>" tip the CLI prints after
  // `smithery auth token`. Caught in real-publish run #26109827581
  // where the CLI prompted interactively for an API key (exit 130 from
  // inquirer's EOF on closed stdin) despite SMITHERY_TOKEN being set.
  const publishArgs = ['--yes', SMITHERY_CLI_PACKAGE, 'mcp', 'publish', input.bundle_path, '-n', qualifiedName];
  const result = await exec('npx', publishArgs, {
    timeoutMs: PUBLISH_TIMEOUT_MS,
    env: { SMITHERY_API_KEY: env.SMITHERY_TOKEN },
  });

  if (result.exitCode === 0) {
    const duration = now() - started;
    log.info('target.publish_succeeded', { ...baseEvent, attempts: 1 });
    return validate({
      target: 'smithery',
      status: 'succeeded',
      target_url: smitheryWebUrl(qualifiedName),
      version_published: input.version,
      duration_ms: duration,
      attempts: 1,
      dry_run: false,
      metadata: { qualified_name: qualifiedName, cli_version: SMITHERY_CLI_PACKAGE },
    });
  }

  // Idempotency catch on the publish side: a concurrent retry may have
  // pushed the same version between our probe and our publish. Treat
  // duplicate-version as skipped, not failed.
  if (isDuplicateVersionError(result.stderr)) {
    const duration = now() - started;
    log.info('target.publish_skipped', {
      ...baseEvent,
      reason: 'version_already_in_smithery',
      stderr_excerpt: trim(result.stderr, 200),
    });
    return validate({
      target: 'smithery',
      status: 'skipped',
      target_url: smitheryWebUrl(qualifiedName),
      version_published: input.version,
      duration_ms: duration,
      attempts: 1,
      dry_run: false,
    });
  }

  // Specific error: missing/invalid token.
  if (isMissingTokenError(result.stderr)) {
    const duration = now() - started;
    log.error('target.publish_failed', { ...baseEvent, reason: 'smithery_auth_failed' });
    return validate({
      target: 'smithery',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: false,
      error: {
        message: `Smithery CLI auth failed (exit ${result.exitCode}): ${trim(result.stderr, 200)}`,
        cause: 'SMITHERY_TOKEN is set but invalid, expired, or lacks publish scope on this namespace.',
        action: `Re-mint a service token with publish scope on '${namespace}/*' via \`smithery auth token --policy '{"resources":["${namespace}/*"],"operations":["publish"]}'\` and update the SMITHERY_TOKEN repo secret.`,
      },
    });
  }

  // Everything else: surface as failed with the stderr.
  const duration = now() - started;
  process.stderr.write(
    `[publish-smithery] exit ${result.exitCode}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n--- end ---\n`,
  );
  log.error('target.publish_failed', {
    ...baseEvent,
    reason: 'smithery_cli_failed',
    exit_code: result.exitCode,
    stderr_excerpt: trim(result.stderr, 400),
  });
  return validate({
    target: 'smithery',
    status: 'failed',
    target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
    version_published: null,
    duration_ms: duration,
    attempts: 1,
    dry_run: false,
    error: {
      message: `\`smithery mcp publish\` exited ${result.exitCode}: ${trim(result.stderr || result.stdout, 400)}`,
      cause: 'The Smithery CLI rejected the publish for a non-idempotent, non-auth reason.',
      action: `Inspect the stderr above. Re-run /retry-publish?step=smithery after addressing the underlying issue. Bundle was at ${input.bundle_path}.`,
    },
  });
}

function validate(output: PublisherOutput): PublisherOutput {
  publisherOutputSchema.parse(output);
  return output;
}
