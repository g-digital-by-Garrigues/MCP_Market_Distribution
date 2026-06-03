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

// Story 3.3: Docker Hub publisher.
//
// Builds the MCP image from pending-to-publish/<mcp_name>/Dockerfile, tags
// it as `<docker_image_name>:<version>` and `:latest`, pushes both tags,
// and returns a PublisherOutputSchema-conforming JSON. The image name
// comes from the MCP repo's `.distribution.yaml#docker_image_name`
// (cloned into pending-to-publish/<mcp_name>/) so each MCP controls its
// own Docker Hub namespace.
//
// Auth: stored credentials (DOCKERHUB_USERNAME + DOCKERHUB_TOKEN). The
// audit guard (Story 2.7 / NFR-S3) already allows-lists those two secret
// names. We use `docker login` so the credentials live only in the
// runner's docker config, not in env vars exposed to subsequent steps.
//
// BuildKit caching: --cache-from registry / --cache-to registry,mode=max
// against an `:cache` tag on the same image. Subsequent runs reuse the
// previous build's layers when the source hasn't changed materially.

export interface PublishDockerHubInput {
  readonly mcp_name: string;
  readonly version: string;
  readonly pipeline_run_id: string;
  readonly dry_run: boolean;
  /** pending-to-publish/<mcp_name>/ — must contain a Dockerfile. */
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string },
) => Promise<ExecResult>;

export interface PublishDockerHubDeps {
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
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

function targetUrl(imageName: string): string {
  return `https://hub.docker.com/r/${imageName}`;
}

function extractDigest(pushStdout: string): string | undefined {
  // `docker push` emits a final line like:
  //   "1.0.0: digest: sha256:abc... size: 1234"
  const match = pushStdout.match(/digest:\s*(sha256:[a-f0-9]+)/);
  return match?.[1];
}

export async function publishDockerHub(
  input: PublishDockerHubInput,
  deps: PublishDockerHubDeps = {},
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
    target: 'docker-hub',
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
      target: 'docker-hub',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('docker-hub', input.mcp_name, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message: msg,
        cause: `.distribution.yaml missing or invalid for '${input.mcp_name}'.`,
        action: `Ensure the MCP repo has a valid .distribution.yaml with docker_image_name set.`,
      },
    });
  }

  const imageName = distribution.docker_image_name;
  const versionedTag = `${imageName}:${input.version}`;
  const latestTag = `${imageName}:latest`;
  const cacheTag = `${imageName}:cache`;

  // Idempotency check (Story 3.1). The Docker Hub probe answers "is any
  // version published" — we layer the "is THIS version published" check
  // here.
  const probe = await checkTargetVersion('docker-hub', imageName, {
    ...(probeExec ? { exec: probeExec } : {}),
    ...(deps.probeOptions ?? {}),
  });
  if (probe.status === 'present' && probe.version === input.version) {
    const duration = now() - started;
    log.info('target.publish_skipped', { ...baseEvent, reason: 'already_published' });
    return validate({
      target: 'docker-hub',
      status: 'skipped',
      target_url: targetUrl(imageName),
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
      target: 'docker-hub',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('docker-hub', imageName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: probe.attempts,
      dry_run: isDryRun,
      error: {
        message: probe.error.message,
        cause: 'Docker Hub tags API repeatedly failed; cannot confirm idempotency.',
        action: 'Check https://status.docker.com and retry via /retry-publish?step=docker-hub.',
      },
    });
  }

  // Auth — only required for pushing. In dry-run we skip login entirely
  // (no point talking to Docker Hub when we're not going to push).
  if (!isDryRun) {
    const username = env.DOCKERHUB_USERNAME?.trim();
    const token = env.DOCKERHUB_TOKEN?.trim();
    if (!username || !token) {
      const duration = now() - started;
      log.error('target.publish_failed', { ...baseEvent, reason: 'missing_credentials' });
      return validate({
        target: 'docker-hub',
        status: 'failed',
        target_url: dryRunPlaceholderUrl('docker-hub', imageName, input.version),
        version_published: null,
        duration_ms: duration,
        attempts: probe.attempts,
        dry_run: isDryRun,
        error: {
          message: 'DOCKERHUB_USERNAME and/or DOCKERHUB_TOKEN are not set in the action environment.',
          cause: 'The Docker Hub publisher cannot push without stored credentials.',
          action: 'Add DOCKERHUB_USERNAME and DOCKERHUB_TOKEN as repo secrets and re-run /retry-publish?step=docker-hub.',
        },
      });
    }
    const loginResult = await exec('docker', ['login', '--username', username, '--password-stdin'], {
      stdin: token,
    });
    if (loginResult.exitCode !== 0) {
      const duration = now() - started;
      log.error('target.publish_failed', { ...baseEvent, reason: 'docker_login_failed' });
      return validate({
        target: 'docker-hub',
        status: 'failed',
        target_url: dryRunPlaceholderUrl('docker-hub', imageName, input.version),
        version_published: null,
        duration_ms: duration,
        attempts: probe.attempts,
        dry_run: isDryRun,
        error: {
          message: `docker login failed: ${loginResult.stderr.trim().slice(0, 400)}`,
          cause: 'DOCKERHUB_TOKEN may be expired or scoped incorrectly.',
          action: 'Rotate the token at https://hub.docker.com/settings/security and update the DOCKERHUB_TOKEN repo secret.',
        },
      });
    }
  }

  // Build the image. We always build (even in dry-run) so the build step
  // itself acts as part of the gate — a Dockerfile that doesn't compile
  // shouldn't be allowed through, dry-run or not.
  //
  // Cache-from/cache-to type=registry both authenticate against Docker
  // Hub (writing the :cache tag pushes layers). In dry-run we skip
  // docker login, so we MUST also skip the cache flags or buildx fails
  // auth before the build even starts. Without the cache the dry-run
  // builds from scratch — that's the right trade-off for verifying the
  // Dockerfile without touching the registry.
  // Platform list: full multi-arch (amd64 + arm64) for real publish; only
  // amd64 in dry-run. arm64 is cross-compiled via QEMU on a stock GH
  // runner (10-20x slower than native), which doubles dry-run time from
  // ~1 min to ~5-10 min without adding diagnostic value — a Dockerfile
  // that builds on amd64 is overwhelmingly likely to build on arm64 too
  // (the arch-specific failure modes are rare and not what dry-run is
  // for). Real publishes still build both arches because we WANT the
  // arm64 image on Docker Hub.
  const platforms = isDryRun ? 'linux/amd64' : 'linux/amd64,linux/arm64';
  const buildArgs: string[] = [
    'buildx', 'build',
    '--platform', platforms,
    '--tag', versionedTag,
    '--tag', latestTag,
  ];
  if (isDryRun) {
    buildArgs.push('--output=type=cacheonly');
  } else {
    // Supply-chain attestations (Docker Scout score gate):
    //   --sbom=true            attaches a Software Bill of Materials
    //                          (buildkit uses syft under the hood) to the
    //                          pushed manifest. Without this, Scout flags
    //                          "Missing supply chain attestation(s)".
    //   --provenance=mode=max  upgrades the default mode=min provenance
    //                          (which `--push` emits implicitly) to include
    //                          the full build invocation metadata. Note that
    //                          mode=max embeds build args — we don't pass
    //                          secrets via build args (DOCKERHUB_TOKEN goes
    //                          through `docker login` env), so there's
    //                          nothing sensitive to leak here.
    buildArgs.push(
      '--cache-from', `type=registry,ref=${cacheTag}`,
      '--cache-to', `type=registry,ref=${cacheTag},mode=max`,
      '--sbom=true',
      '--provenance=mode=max',
      '--push',
    );
  }
  buildArgs.push('.');
  const buildResult = await exec('docker', buildArgs, { cwd: input.package_dir });
  if (buildResult.exitCode !== 0) {
    const duration = now() - started;
    log.error('target.publish_failed', {
      ...baseEvent,
      reason: 'docker_build_failed',
      exit_code: buildResult.exitCode,
    });
    return validate({
      target: 'docker-hub',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('docker-hub', imageName, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: probe.attempts + 1,
      dry_run: isDryRun,
      error: {
        message: `docker buildx build exited ${buildResult.exitCode}: ${buildResult.stderr.trim().slice(0, 400)}`,
        cause: 'The Dockerfile failed to build or push. See the runner logs for the full BuildKit trace.',
        action: `Fix the Dockerfile under pending-to-publish/${input.mcp_name}/Dockerfile, then /retry-publish?step=docker-hub.`,
      },
    });
  }

  const duration = now() - started;
  const digest = extractDigest(buildResult.stdout) ?? extractDigest(buildResult.stderr);
  log.info('target.publish_succeeded', {
    ...baseEvent,
    attempts: probe.attempts + 1,
    digest,
  });

  // Update Docker Hub metadata (description, categories, logo) — non-fatal
  if (!isDryRun) {
    await updateDockerHubMetadata(imageName, input.package_dir, log);
  }

  const metadata: Record<string, unknown> = { image_name: imageName, tags: [input.version, 'latest'] };
  if (digest) metadata.digest = digest;

  return validate({
    target: 'docker-hub',
    status: 'succeeded',
    target_url: isDryRun
      ? dryRunPlaceholderUrl('docker-hub', imageName, input.version)
      : targetUrl(imageName),
    version_published: input.version,
    duration_ms: duration,
    attempts: probe.attempts + 1,
    dry_run: isDryRun,
    metadata,
  });
}

function validate(output: PublisherOutput): PublisherOutput {
  publisherOutputSchema.parse(output);
  return output;
}

// Docker Hub categories for all g-digital MCP servers.
const DOCKER_HUB_CATEGORIES = ['machine-learning-and-ai', 'security', 'api-management'];

async function getDockerHubJwt(username: string, password: string): Promise<string | null> {
  try {
    const res = await fetch('https://hub.docker.com/v2/users/login/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { token?: string };
    return data.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Updates Docker Hub repository metadata after a successful push:
 * - short description (from server.json#description)
 * - full description / overview (from README.md)
 * - categories: machine-learning-and-ai, security, api-management
 * - repository icon (from assets/logo-400x400.png)
 * Non-fatal: logs warnings on failure so publish still succeeds.
 */
async function updateDockerHubMetadata(
  imageName: string,
  packageDir: string,
  log: Pick<typeof defaultLogger, 'info' | 'warn'>,
): Promise<void> {
  const parts = imageName.split('/');
  const namespace = parts[0];
  const repoName = parts[1];
  if (!namespace || !repoName) return;

  const username = process.env.DOCKERHUB_USERNAME?.trim();
  const tokenSecret = process.env.DOCKERHUB_TOKEN?.trim();
  if (!username || !tokenSecret) {
    log.warn('docker_hub_metadata.skip', { reason: 'no DOCKERHUB_USERNAME or DOCKERHUB_TOKEN' });
    return;
  }
  const jwt = await getDockerHubJwt(username, tokenSecret);
  if (!jwt) {
    log.warn('docker_hub_metadata.skip', { reason: 'login failed' });
    return;
  }

  const baseUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repoName}`;
  const authHeaders = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

  // Short + full description
  let shortDesc = '';
  let fullDesc = '';
  try { shortDesc = (JSON.parse(await fs.readFile(path.join(packageDir, 'server.json'), 'utf8')) as { description?: string }).description ?? ''; } catch { /* ok */ }
  try { fullDesc = await fs.readFile(path.join(packageDir, 'README.md'), 'utf8'); } catch { /* ok */ }

  if (shortDesc || fullDesc) {
    const r = await fetch(`${baseUrl}/`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ description: shortDesc, full_description: fullDesc }),
    }).catch(() => null);
    if (r?.ok) log.info('docker_hub_metadata.description_updated', { repo: imageName });
    else log.warn('docker_hub_metadata.description_failed', { status: r?.status });
  }

  // Categories
  const catRes = await fetch(`${baseUrl}/categories/`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ categories: DOCKER_HUB_CATEGORIES.map(slug => ({ slug })) }),
  }).catch(() => null);
  if (catRes?.ok) log.info('docker_hub_metadata.categories_updated', { categories: DOCKER_HUB_CATEGORIES });
  else log.warn('docker_hub_metadata.categories_failed', { status: catRes?.status });

  // Logo upload (multipart)
  try {
    const logoBytes = await fs.readFile(path.join(packageDir, 'assets', 'logo-400x400.png'));
    const form = new FormData();
    form.append('image', new Blob([logoBytes], { type: 'image/png' }), 'logo.png');
    const logoRes = await fetch(`${baseUrl}/icon/`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    }).catch(() => null);
    if (logoRes?.ok) log.info('docker_hub_metadata.logo_updated', { repo: imageName });
    else log.warn('docker_hub_metadata.logo_failed', { status: logoRes?.status });
  } catch { /* logo missing or upload failed — non-fatal */ }
}
