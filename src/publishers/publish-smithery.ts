import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import yaml from 'js-yaml';

import { dryRunEnabled } from '../ci/dry-run.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { retryWithBackoff } from '../utils/retry.js';
import {
  mcpPipelineConfigSchema,
  type McpEntry,
} from '../schemas/mcp-pipeline-config.schema.js';
import {
  dryRunPlaceholderUrl,
  publisherOutputSchema,
  type PublisherOutput,
} from '../schemas/publisher-output.schema.js';

// Story 4.2: Smithery publisher.
//
// Smithery's publication model is git-push based: it watches the linked
// GitHub repo for changes to smithery.yaml. By the time this action runs,
// /prep-mcp (Story 1.7) has already committed the new smithery.yaml to
// main and the tag push triggered the workflow. The composite action's
// job is to verify the deploy completed by polling Smithery's API.
//
// Polling contract (per AC): every 30s, for up to 15 minutes, check that
// Smithery reports the deployed version matches the requested version.
// Timeout → status='failed' with a "manual verification" remediation.

const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

export interface PublishSmitheryInput {
  readonly mcp_name: string;
  readonly version: string;
  readonly pipeline_run_id: string;
  readonly dry_run: boolean;
  readonly repo_root: string;
}

export interface SmitheryServerInfo {
  /** Version Smithery reports as currently deployed. */
  version?: string;
  /** Status field from Smithery's API. */
  status?: string;
}

export type SmitheryFetch = (qualifiedName: string) => Promise<SmitheryServerInfo>;

export interface PublishSmitheryDeps {
  fetchSmithery?: SmitheryFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv;
  /** Override poll timeout for tests. */
  pollTimeoutMs?: number;
  /** Override poll interval for tests. */
  pollIntervalMs?: number;
}

async function loadEntry(repoRoot: string, mcpName: string): Promise<McpEntry> {
  const configPath = path.join(repoRoot, 'mcp-pipeline.yaml');
  const raw = await fs.readFile(configPath, 'utf8');
  const config = mcpPipelineConfigSchema.parse(yaml.load(raw));
  const entry = config.mcps[mcpName];
  if (!entry) {
    throw new Error(
      `mcp-pipeline.yaml has no entry for '${mcpName}'. Available: ${Object.keys(config.mcps).join(', ') || '(none)'}.`,
    );
  }
  return entry;
}

function smitheryUrl(qualifiedName: string): string {
  return `https://smithery.ai/server/${qualifiedName}`;
}

async function defaultFetchSmithery(qualifiedName: string): Promise<SmitheryServerInfo> {
  // Smithery's public read API: GET /api/servers/<qualifiedName>.
  // We wrap the network call so callers don't have to import fetch.
  const url = `https://smithery.ai/api/servers/${encodeURIComponent(qualifiedName)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) {
    return {}; // not yet deployed → empty info
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Smithery API returned ${response.status}`), {
      status: response.status,
    });
  }
  const body = (await response.json()) as { version?: string; status?: string };
  return body;
}

export async function publishSmithery(
  input: PublishSmitheryInput,
  deps: PublishSmitheryDeps = {},
): Promise<PublisherOutput> {
  const fetchSmithery = deps.fetchSmithery ?? defaultFetchSmithery;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;
  const pollTimeoutMs = deps.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;

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

  let entry: McpEntry;
  try {
    entry = await loadEntry(input.repo_root, input.mcp_name);
  } catch (err) {
    const duration = now() - started;
    log.error('target.publish_failed', { ...baseEvent, reason: 'config_load_failed' });
    return validate({
      target: 'smithery',
      status: 'failed',
      target_url: dryRunPlaceholderUrl('smithery', input.mcp_name, input.version),
      version_published: null,
      duration_ms: duration,
      attempts: 1,
      dry_run: isDryRun,
      error: {
        message: (err as Error).message,
        cause: `mcp-pipeline.yaml has no entry for '${input.mcp_name}'.`,
        action: `Add mcps.${input.mcp_name}.reverse_dns_name in mcp-pipeline.yaml.`,
      },
    });
  }

  const qualifiedName = entry.reverse_dns_name;

  if (isDryRun) {
    const duration = now() - started;
    log.info('target.publish_skipped', { ...baseEvent, reason: 'dry_run' });
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

  // Poll Smithery's API every pollIntervalMs for up to pollTimeoutMs.
  // Each individual fetch is wrapped in retryWithBackoff so a transient
  // 5xx doesn't kill the whole verification.
  const deadline = started + pollTimeoutMs;
  let attempts = 0;
  let lastInfo: SmitheryServerInfo = {};
  while (now() < deadline) {
    attempts += 1;
    try {
      lastInfo = await retryWithBackoff(() => fetchSmithery(qualifiedName), {
        retryDelaysMs: [5_000, 15_000],
        sleep,
      });
    } catch (err) {
      const duration = now() - started;
      log.error('target.publish_failed', { ...baseEvent, reason: 'smithery_api_unreachable', attempts });
      return validate({
        target: 'smithery',
        status: 'failed',
        target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
        version_published: null,
        duration_ms: duration,
        attempts,
        dry_run: isDryRun,
        error: {
          message: `Smithery API repeatedly failed: ${(err as Error).message}`,
          cause: 'Could not reach smithery.ai to verify deployment status.',
          action: 'Check https://status.smithery.ai and /retry-publish?step=smithery once recovered. Or verify manually at https://smithery.ai/server/' + qualifiedName + '.',
        },
      });
    }

    if (lastInfo.version === input.version) {
      const duration = now() - started;
      log.info('target.publish_succeeded', { ...baseEvent, attempts });
      return validate({
        target: 'smithery',
        status: 'succeeded',
        target_url: smitheryUrl(qualifiedName),
        version_published: input.version,
        duration_ms: duration,
        attempts,
        dry_run: false,
        metadata: { qualified_name: qualifiedName, smithery_status: lastInfo.status ?? null },
      });
    }

    // Not yet at the target version — wait the poll interval before
    // re-checking (unless we're past the deadline already).
    if (now() + pollIntervalMs < deadline) {
      await sleep(pollIntervalMs);
    } else {
      break;
    }
  }

  // Timeout. The deploy may complete eventually (Smithery builds can be
  // slow); the remediation directs the engineer to check manually rather
  // than auto-retry, since the work IS happening on Smithery's side.
  const duration = now() - started;
  log.warn('target.publish_failed', { ...baseEvent, reason: 'deploy_verification_timeout', attempts });
  return validate({
    target: 'smithery',
    status: 'failed',
    target_url: dryRunPlaceholderUrl('smithery', qualifiedName, input.version),
    version_published: null,
    duration_ms: duration,
    attempts,
    dry_run: false,
    error: {
      message: `Smithery did not report version ${input.version} within ${Math.round(pollTimeoutMs / 60_000)} minutes. Last reported: version=${lastInfo.version ?? 'unknown'}, status=${lastInfo.status ?? 'unknown'}.`,
      cause: 'Smithery auto-deploy did not converge within the polling window.',
      action: `Check the dashboard at ${smitheryUrl(qualifiedName)} — the deploy may still be in progress. If it failed, look at the build log there for the root cause. /retry-publish?step=smithery polls again from scratch.`,
    },
  });
}

function validate(output: PublisherOutput): PublisherOutput {
  publisherOutputSchema.parse(output);
  return output;
}
