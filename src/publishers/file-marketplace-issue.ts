import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import Handlebars from 'handlebars';
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

// Shared core for Stories 4.4 (Cline) and 4.5 (mcp.so): both file a
// GitHub issue against an external repository using the bot PAT, with
// idempotency via existing-issue search and 403-as-rate-limit handling.
//
// The two publishers differ only in:
//   - upstream repo name
//   - template file name
//   - target identifier (the 'target' field in PublisherOutput)
//   - issue-title pattern
//
// We collapse them into one parameterised helper rather than duplicating
// 200 lines per publisher.

export interface IssuePublisherConfig {
  /** PublisherOutput.target identifier (e.g. 'cline', 'mcpso'). */
  readonly target: string;
  /** Upstream repo to file the issue against ('cline/mcp-marketplace'). */
  readonly upstreamRepo: string;
  /** Handlebars template filename under templates/store-descriptions/. */
  readonly templateFile: string;
  /** Issue title pattern; receives { reverseDns, mcpName, version }. */
  readonly titlePattern: (data: { reverseDns: string; mcpName: string; version: string }) => string;
}

export interface FileMarketplaceIssueInput {
  readonly mcp_name: string;
  readonly version: string;
  readonly pipeline_run_id: string;
  readonly dry_run: boolean;
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
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export interface FileMarketplaceIssueDeps {
  exec?: ExecFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

async function readPackageDescription(packageDir: string, mcpName: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { description?: unknown };
    if (typeof pkg.description === 'string' && pkg.description.trim().length > 0) {
      return pkg.description.trim();
    }
  } catch {
    // Fall through to the generic fallback.
  }
  return `${mcpName} MCP server — published from g-digital by Garrigues`;
}

async function readEnvVars(packageDir: string): Promise<Array<{ name: string; description: string }>> {
  try {
    const raw = await fs.readFile(path.join(packageDir, '.env.example'), 'utf8');
    const entries: Array<{ name: string; description: string }> = [];
    let pendingComment = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        pendingComment = trimmed.replace(/^#\s*/, '');
        continue;
      }
      const m = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=/);
      if (!m) {
        pendingComment = '';
        continue;
      }
      entries.push({ name: m[1]!, description: pendingComment || '(no description)' });
      pendingComment = '';
    }
    return entries;
  } catch {
    return [];
  }
}

export async function fileMarketplaceIssue(
  config: IssuePublisherConfig,
  input: FileMarketplaceIssueInput,
  deps: FileMarketplaceIssueDeps = {},
): Promise<PublisherOutput> {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? defaultLogger;
  const env = deps.env ?? process.env;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const isDryRun = dryRunEnabled({ input: String(input.dry_run), env: env.DRY_RUN });
  const started = now();
  const baseEvent = {
    mcp_name: input.mcp_name,
    version: input.version,
    pipeline_run_id: input.pipeline_run_id,
    target: config.target,
    dry_run: isDryRun,
  };
  log.info('target.publish_started', baseEvent);

  let entry: McpEntry;
  try {
    entry = await loadEntry(input.repo_root, input.mcp_name);
  } catch (err) {
    return failed(config, input, isDryRun, now() - started, 1,
      (err as Error).message,
      `mcp-pipeline.yaml has no entry for '${input.mcp_name}'.`,
      `Add mcps.${input.mcp_name} in mcp-pipeline.yaml.`);
  }

  if (!env.BOT_PAT?.trim()) {
    return failed(config, input, isDryRun, now() - started, 1,
      'BOT_PAT env var is empty.',
      `The ${config.target} publisher cannot file marketplace issues without a bot PAT.`,
      `Add BOT_PAT as a repo secret (Personal Access Token with public_repo scope) and re-run /retry-publish?step=${config.target}.`);
  }

  const title = config.titlePattern({
    reverseDns: entry.reverse_dns_name,
    mcpName: input.mcp_name,
    version: input.version,
  });

  // Idempotency: gh issue list --search by exact title.
  const search = await exec('gh', [
    'issue', 'list',
    '--repo', config.upstreamRepo,
    '--state', 'open',
    '--search', title,
    '--json', 'number,title,url',
    '--limit', '5',
  ], { env: { GH_TOKEN: env.BOT_PAT } });
  if (search.exitCode === 0) {
    try {
      const issues = JSON.parse(search.stdout.trim() || '[]') as Array<{ number: number; title: string; url: string }>;
      const exact = issues.find((i) => i.title === title);
      if (exact) {
        log.info('target.publish_skipped', { ...baseEvent, reason: 'open_issue_exists' });
        return success(config, input, isDryRun, now() - started, 1, exact.url, 'skipped');
      }
    } catch {
      // Couldn't parse — fall through.
    }
  }

  if (isDryRun) {
    return success(config, input, isDryRun, now() - started, 1,
      dryRunPlaceholderUrl(config.target, input.mcp_name, input.version), 'succeeded');
  }

  // Render the issue body.
  const tpl = await fs.readFile(
    path.join(input.repo_root, 'templates', 'store-descriptions', config.templateFile),
    'utf8',
  );
  const packageDir = path.join(input.repo_root, 'pending-to-publish', input.mcp_name);
  const envVars = await readEnvVars(packageDir);
  // Read the canonical description from package.json#description so the
  // marketplace body matches what npm and the MCP Registry show. Falls
  // back to a generic line if package.json isn't readable (shouldn't
  // normally happen — Layer 1 enforces its presence).
  const description = await readPackageDescription(packageDir, input.mcp_name);
  const repoUrl = 'https://github.com/g-digital-by-Garrigues/MCP_Market_Distribution';
  const logoUrl = `${repoUrl}/raw/main/pending-to-publish/${input.mcp_name}/${entry.logo_path}`;
  const body = Handlebars.compile(tpl, { noEscape: true })({
    mcp_name: input.mcp_name,
    version: input.version,
    description,
    npm_package_name: entry.npm_package_name,
    docker_image_name: entry.docker_image_name,
    license: entry.license,
    repo_url: repoUrl,
    logo_url: logoUrl,
    pipeline_run_id: input.pipeline_run_id,
    environment_variables: envVars,
  });

  // Custom transient classifier: treat 403 as transient because for these
  // marketplaces 403 typically means rate-limit, not permission.
  const isTransient = (err: unknown): boolean => {
    if (!err) return false;
    const e = err as { status?: number; code?: string };
    if (e.status === 403 || e.status === 429 || (typeof e.status === 'number' && e.status >= 500)) return true;
    if (typeof e.code === 'string' && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(e.code)) return true;
    return false;
  };

  let attempts = 0;
  let url: string;
  try {
    url = await retryWithBackoff(
      async () => {
        attempts += 1;
        const r = await exec('gh', [
          'issue', 'create',
          '--repo', config.upstreamRepo,
          '--title', title,
          '--body', body,
        ], { env: { GH_TOKEN: env.BOT_PAT } });
        if (r.exitCode !== 0) {
          // Try to extract HTTP status from stderr so the classifier sees it.
          const statusMatch = r.stderr.match(/HTTP (\d{3})/);
          const status = statusMatch ? parseInt(statusMatch[1]!, 10) : undefined;
          throw Object.assign(new Error(r.stderr.trim().slice(0, 300)), status ? { status } : {});
        }
        return r.stdout.trim();
      },
      { retryDelaysMs: [60_000, 300_000], sleep, isTransient },
    );
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const stderr = e.message ?? '';
    if (e.status === 403 || /HTTP 403/.test(stderr)) {
      return failed(config, input, isDryRun, now() - started, attempts || 1,
        `gh issue create returned 403: ${stderr.slice(0, 300)}`,
        `GitHub rate limit on bot account.`,
        `Wait for the rate limit reset (~47 minutes) or retry via /retry-publish?step=${config.target}.`);
    }
    return failed(config, input, isDryRun, now() - started, attempts || 1,
      `gh issue create failed: ${stderr.slice(0, 300)}`,
      `Could not open issue against ${config.upstreamRepo}.`,
      `/retry-publish?step=${config.target}.`);
  }

  log.info('target.publish_succeeded', { ...baseEvent, issue_url: url });
  return success(config, input, isDryRun, now() - started, attempts, url, 'succeeded');
}

function success(
  config: IssuePublisherConfig,
  input: FileMarketplaceIssueInput,
  isDryRun: boolean,
  duration: number,
  attempts: number,
  url: string,
  status: 'succeeded' | 'skipped',
): PublisherOutput {
  return validate({
    target: config.target,
    status,
    target_url: url,
    version_published: input.version,
    duration_ms: duration,
    attempts,
    dry_run: isDryRun,
  });
}

function failed(
  config: IssuePublisherConfig,
  input: FileMarketplaceIssueInput,
  isDryRun: boolean,
  duration: number,
  attempts: number,
  message: string,
  cause: string,
  action: string,
): PublisherOutput {
  return validate({
    target: config.target,
    status: 'failed',
    target_url: dryRunPlaceholderUrl(config.target, input.mcp_name, input.version),
    version_published: null,
    duration_ms: duration,
    attempts,
    dry_run: isDryRun,
    error: { message, cause, action },
  });
}

function validate(output: PublisherOutput): PublisherOutput {
  publisherOutputSchema.parse(output);
  return output;
}
