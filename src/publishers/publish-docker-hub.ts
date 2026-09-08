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
import {
  DOCKER_HUB_FULL_DESCRIPTION_MAX,
  readSourceRepoUrl,
  renderDockerHubOverview,
  type DockerHubDescriptions,
} from './render-docker-hub-overview.js';

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
    // The image is already pushed, but the repository PAGE is not the image:
    // it can be stale while the tag is correct, which is exactly the state both
    // products were left in. So a retry still refreshes the metadata — that is
    // the only way to repair a page without inventing a new version.
    const skipMeta: Record<string, unknown> = { image_name: imageName, tags: [input.version, 'latest'] };
    if (!isDryRun) {
      const result = await updateDockerHubMetadata(
        imageName,
        input.package_dir,
        log,
        await buildOverview(input, distribution, log),
        env,
      );
      skipMeta.metadata_refresh = result;
      if (result.description === 'failed') {
        log.error('target.publish_failed', { ...baseEvent, reason: 'description_update_failed' });
        return descriptionFailure(
          input, imageName, isDryRun, now() - started, probe.attempts, skipMeta,
          result.descriptionError ?? 'the update was rejected',
        );
      }
    }
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
      metadata: skipMeta,
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

  const metadata: Record<string, unknown> = { image_name: imageName, tags: [input.version, 'latest'] };
  if (digest) metadata.digest = digest;

  // Update Docker Hub metadata. The description half is fatal; see
  // descriptionFailure() for why.
  if (!isDryRun) {
    const result = await updateDockerHubMetadata(
      imageName,
      input.package_dir,
      log,
      await buildOverview(input, distribution, log),
      env,
    );
    metadata.metadata_refresh = result;
    if (result.description === 'failed') {
      log.error('target.publish_failed', { ...baseEvent, reason: 'description_update_failed' });
      return descriptionFailure(
        input, imageName, isDryRun, now() - started, probe.attempts + 1, metadata,
        result.descriptionError ?? 'the update was rejected',
      );
    }
  }

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

async function buildOverview(
  input: PublishDockerHubInput,
  distribution: DistributionConfig,
  log: Pick<typeof defaultLogger, 'warn'>,
): Promise<DockerHubDescriptions | null> {
  try {
    return await renderDockerHubOverview({
      mcpName: input.mcp_name,
      packageDir: input.package_dir,
      repoRoot: input.repo_root,
      version: input.version,
      dockerImageName: distribution.docker_image_name,
      npmPackageName: distribution.npm_package_name,
      repoUrl: await readSourceRepoUrl(input.repo_root, input.mcp_name),
      license: distribution.license,
      releaseTag: `${distribution.git_tag_prefix ?? 'v'}${input.version}`,
    });
  } catch (err) {
    log.warn('docker_hub_metadata.render_failed', { reason: (err as Error).message });
    return null;
  }
}

/**
 * Failure of the repository description, expressed as a PublisherOutput.
 *
 * A Docker Hub page is documentation: if it cannot be refreshed, the page keeps
 * describing an older release. That went unnoticed for two releases precisely
 * because it was a log warning on a green publish, so it fails the target now.
 * Categories and logo stay advisory — they are presentation, and their
 * endpoints are independently broken (405 / 404) in a way that would otherwise
 * red-flag every publish.
 */
function descriptionFailure(
  input: PublishDockerHubInput,
  imageName: string,
  isDryRun: boolean,
  durationMs: number,
  attempts: number,
  metadata: Record<string, unknown>,
  reason: string,
): PublisherOutput {
  return validate({
    target: 'docker-hub',
    status: 'failed',
    target_url: targetUrl(imageName),
    version_published: input.version,
    duration_ms: durationMs,
    attempts,
    dry_run: isDryRun,
    metadata,
    error: {
      message: `Docker Hub repository description was not updated: ${reason}.`,
      cause:
        'The image is on Docker Hub, but its overview page still describes an earlier ' +
        'release. That page is how people configure the server, so stale content there ' +
        'hands out wrong setup instructions.',
      action: `Fix the cause above, then /retry-publish?step=docker-hub. The retry refreshes the page even though ${input.version} is already pushed.`,
    },
  });
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

export interface DockerHubMetadataResult {
  /** The overview/short-description PATCH — the user-facing documentation. */
  description: 'updated' | 'failed' | 'skipped';
  categories: 'updated' | 'failed' | 'skipped';
  logo: 'updated' | 'failed' | 'skipped';
  /** Set when description !== 'updated'; carries the reason for the caller. */
  descriptionError?: string;
}

/**
 * Updates Docker Hub repository metadata:
 * - short description (from server.json#description)
 * - full description / overview (RENDERED — see render-docker-hub-overview.ts)
 * - categories: machine-learning-and-ai, security, api-management
 * - repository icon (from assets/logo-400x400.png)
 *
 * The overview used to be the whole README, which stopped fitting Docker Hub's
 * 25,000-character cap at gocertius v1.5.1. Every publish since then got a 400
 * here, logged a warning, and reported success — so both product pages sat on
 * v1.5.0 documentation telling users to set `MCP_AUTH_PASSWORD`, a variable
 * retired two majors earlier. Rendering a purpose-built overview fixes the size
 * AND the staleness: it is built from the server's own `.env.example`, so it
 * cannot describe variables the image does not read.
 *
 * The result is returned rather than swallowed. The caller fails the publish on
 * a description failure — a repository page giving wrong setup instructions is
 * not a cosmetic defect — while categories and logo stay advisory and surface
 * in the publisher output.
 */
async function updateDockerHubMetadata(
  imageName: string,
  packageDir: string,
  log: Pick<typeof defaultLogger, 'info' | 'warn'>,
  overview: { full: string; short: string } | null,
  // Taken from deps rather than process.env: reading the global directly made
  // this whole function unreachable from a test, which is a large part of why
  // it could fail on every publish for two releases without anyone noticing.
  env: NodeJS.ProcessEnv,
): Promise<DockerHubMetadataResult> {
  const skipped = (reason: string): DockerHubMetadataResult => ({
    description: 'skipped',
    categories: 'skipped',
    logo: 'skipped',
    descriptionError: reason,
  });

  const parts = imageName.split('/');
  const namespace = parts[0];
  const repoName = parts[1];
  if (!namespace || !repoName) return skipped(`image name '${imageName}' is not <namespace>/<repo>`);

  const username = env.DOCKERHUB_USERNAME?.trim();
  const tokenSecret = env.DOCKERHUB_TOKEN?.trim();
  if (!username || !tokenSecret) {
    log.warn('docker_hub_metadata.skip', { reason: 'no DOCKERHUB_USERNAME or DOCKERHUB_TOKEN' });
    return skipped('DOCKERHUB_USERNAME or DOCKERHUB_TOKEN is not set on this run');
  }
  const jwt = await getDockerHubJwt(username, tokenSecret);
  if (!jwt) {
    log.warn('docker_hub_metadata.skip', { reason: 'login failed' });
    return skipped('Docker Hub rejected DOCKERHUB_USERNAME / DOCKERHUB_TOKEN at login');
  }

  const baseUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repoName}`;
  const authHeaders = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

  // Short + full description
  let description: DockerHubMetadataResult['description'] = 'skipped';
  let descriptionError: string | undefined;
  if (!overview) {
    descriptionError = 'the overview could not be rendered';
  } else if (overview.full.length > DOCKER_HUB_FULL_DESCRIPTION_MAX) {
    // Checked here rather than learned from a 400: Docker Hub's rejection body
    // says nothing, and this is the failure that hid for two releases.
    description = 'failed';
    descriptionError =
      `the rendered overview is ${overview.full.length} characters, over Docker Hub's ` +
      `${DOCKER_HUB_FULL_DESCRIPTION_MAX}-character limit for full_description`;
    log.warn('docker_hub_metadata.description_too_long', {
      length: overview.full.length,
      max: DOCKER_HUB_FULL_DESCRIPTION_MAX,
    });
  } else {
    const r = await fetch(`${baseUrl}/`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ description: overview.short, full_description: overview.full }),
    }).catch(() => null);
    if (r?.ok) {
      description = 'updated';
      log.info('docker_hub_metadata.description_updated', {
        repo: imageName,
        length: overview.full.length,
      });
    } else {
      description = 'failed';
      descriptionError = `Docker Hub answered HTTP ${r?.status ?? 'no response'} to the description update`;
      log.warn('docker_hub_metadata.description_failed', { status: r?.status });
    }
  }

  // Categories
  const catRes = await fetch(`${baseUrl}/categories/`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ categories: DOCKER_HUB_CATEGORIES.map(slug => ({ slug })) }),
  }).catch(() => null);
  const categories: DockerHubMetadataResult['categories'] = catRes?.ok ? 'updated' : 'failed';
  if (catRes?.ok) log.info('docker_hub_metadata.categories_updated', { categories: DOCKER_HUB_CATEGORIES });
  else log.warn('docker_hub_metadata.categories_failed', { status: catRes?.status });

  // Logo upload (multipart)
  let logo: DockerHubMetadataResult['logo'] = 'skipped';
  try {
    const logoBytes = await fs.readFile(path.join(packageDir, 'assets', 'logo-400x400.png'));
    const form = new FormData();
    form.append('image', new Blob([logoBytes], { type: 'image/png' }), 'logo.png');
    const logoRes = await fetch(`${baseUrl}/icon/`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    }).catch(() => null);
    logo = logoRes?.ok ? 'updated' : 'failed';
    if (logoRes?.ok) log.info('docker_hub_metadata.logo_updated', { repo: imageName });
    else log.warn('docker_hub_metadata.logo_failed', { status: logoRes?.status });
  } catch { /* logo missing — advisory */ }

  return { description, categories, logo, ...(descriptionError ? { descriptionError } : {}) };
}
