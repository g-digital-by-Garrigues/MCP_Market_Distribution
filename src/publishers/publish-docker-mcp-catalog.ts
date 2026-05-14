import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
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

// Story 4.3: Docker MCP Catalog publisher.
//
// The Docker MCP Catalog (docker/mcp-registry) accepts submissions via PR.
// We:
//   1. Render 3 files (server.yaml + tools.json + readme.md) from
//      Handlebars templates under templates/store-descriptions/
//      docker-mcp-catalog/.
//   2. Use the `gh` CLI (authenticated with BOT_PAT) to fork
//      docker/mcp-registry, create a branch, push the files, and open a
//      PR back to upstream.
//   3. Search for an existing open PR with the same title before doing
//      any work — that's our idempotency check.
//
// We never commit the rendered files to OUR repo; everything lives in
// the bot's fork of docker/mcp-registry.

const UPSTREAM_REPO = 'docker/mcp-registry';
const PR_TITLE_PREFIX = '[MCP] add';

export interface PublishDockerMcpCatalogInput {
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

export interface PublishDockerMcpCatalogDeps {
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

async function renderTemplate(
  repoRoot: string,
  fileName: string,
  data: Record<string, unknown>,
): Promise<string> {
  const tpl = await fs.readFile(
    path.join(repoRoot, 'templates', 'store-descriptions', 'docker-mcp-catalog', fileName),
    'utf8',
  );
  return Handlebars.compile(tpl, { noEscape: true })(data);
}

async function readEnvironmentVariables(packageDir: string): Promise<Array<{ name: string; example: string; description: string }>> {
  // Best-effort: parse the .env.example shipped with the source. We only
  // need a list of names + examples + descriptions for the template.
  try {
    const raw = await fs.readFile(path.join(packageDir, '.env.example'), 'utf8');
    const entries: Array<{ name: string; example: string; description: string }> = [];
    let pendingComment = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        pendingComment = trimmed.replace(/^#\s*/, '');
        continue;
      }
      const m = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) {
        pendingComment = '';
        continue;
      }
      entries.push({ name: m[1]!, example: m[2] ?? '', description: pendingComment });
      pendingComment = '';
    }
    return entries;
  } catch {
    return [];
  }
}

export async function publishDockerMcpCatalog(
  input: PublishDockerMcpCatalogInput,
  deps: PublishDockerMcpCatalogDeps = {},
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
    target: 'docker-mcp-catalog',
    dry_run: isDryRun,
  };
  log.info('target.publish_started', baseEvent);

  let entry: McpEntry;
  try {
    entry = await loadEntry(input.repo_root, input.mcp_name);
  } catch (err) {
    return failedOutput(input, isDryRun, now() - started, 1, (err as Error).message,
      `mcp-pipeline.yaml has no entry for '${input.mcp_name}'.`,
      `Add mcps.${input.mcp_name} in mcp-pipeline.yaml.`);
  }

  if (!env.BOT_PAT?.trim()) {
    return failedOutput(input, isDryRun, now() - started, 1,
      'BOT_PAT env var is empty.',
      'The Docker MCP Catalog publisher cannot open PRs without a bot PAT.',
      'Add BOT_PAT as a repo secret (Personal Access Token with public_repo + workflow scopes) and re-run /retry-publish?step=docker-mcp-catalog.');
  }

  const prTitle = `${PR_TITLE_PREFIX} ${input.mcp_name} v${input.version}`;
  const branchName = `add-${input.mcp_name}-${input.version}`;

  // Idempotency: search for an existing open PR with the same title.
  // gh pr list returns one match per line: <num>\t<title>\t<state>.
  const search = await exec('gh', [
    'pr', 'list',
    '--repo', UPSTREAM_REPO,
    '--state', 'open',
    '--search', prTitle,
    '--json', 'number,title,url',
    '--limit', '5',
  ], { env: { GH_TOKEN: env.BOT_PAT } });
  if (search.exitCode === 0) {
    try {
      const prs = JSON.parse(search.stdout.trim() || '[]') as Array<{ number: number; title: string; url: string }>;
      const exact = prs.find((p) => p.title === prTitle);
      if (exact) {
        log.info('target.publish_skipped', { ...baseEvent, reason: 'open_pr_exists', pr: exact.number });
        return successOutput(input, isDryRun, now() - started, 1, exact.url, 'skipped');
      }
    } catch {
      // Fall through — couldn't parse, treat as no match.
    }
  }

  if (isDryRun) {
    return successOutput(input, isDryRun, now() - started, 1,
      dryRunPlaceholderUrl('docker-mcp-catalog', input.mcp_name, input.version), 'succeeded');
  }

  // Render the 3 files into a temp checkout, push branch, open PR.
  const packageDir = path.join(input.repo_root, 'pending-to-publish', input.mcp_name);
  const envVars = await readEnvironmentVariables(packageDir);

  // Read the canonical description from package.json#description so the
  // catalog server.yaml matches what npm + MCP Registry show. Falls
  // back to a generic line if package.json isn't readable.
  let description = `${input.mcp_name} MCP server — published from g-digital-by-Garrigues/MCP_Market_Distribution.`;
  try {
    const pkgRaw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { description?: unknown };
    if (typeof pkg.description === 'string' && pkg.description.trim().length > 0) {
      description = pkg.description.trim();
    }
  } catch {
    // Keep the generic fallback.
  }
  const data = {
    mcp_name: input.mcp_name,
    version: input.version,
    docker_image_name: entry.docker_image_name,
    license: entry.license,
    description,
    environment_variables: envVars,
    tools: [], // We don't statically know the tools at this layer; an enhancement would call tools/list.
  };
  const serverYaml = await renderTemplate(input.repo_root, 'server.yaml.hbs', data);
  const toolsJson = await renderTemplate(input.repo_root, 'tools.json.hbs', data);
  const readmeMd = await renderTemplate(input.repo_root, 'readme.md.hbs', data);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-mcp-catalog-'));
  try {
    // 1. Fork the upstream repo (idempotent — gh repo fork no-ops if fork exists).
    const fork = await exec('gh', ['repo', 'fork', UPSTREAM_REPO, '--clone=false', '--remote=false'],
      { env: { GH_TOKEN: env.BOT_PAT } });
    if (fork.exitCode !== 0 && !/already exists/i.test(fork.stderr)) {
      return failedOutput(input, isDryRun, now() - started, 1,
        `gh repo fork failed: ${fork.stderr.trim().slice(0, 300)}`,
        'Bot PAT may lack public_repo scope or has hit a fork rate limit.',
        'Verify PAT at github.com/settings/tokens; ensure public_repo scope is granted.');
    }

    // 2. Get the bot's login so we know the fork URL.
    const me = await exec('gh', ['api', 'user', '--jq', '.login'], { env: { GH_TOKEN: env.BOT_PAT } });
    const botLogin = me.stdout.trim();
    if (me.exitCode !== 0 || !botLogin) {
      return failedOutput(input, isDryRun, now() - started, 1,
        'Could not resolve bot user login via gh api user.', 'BOT_PAT is invalid or revoked.',
        'Verify BOT_PAT at github.com/settings/tokens.');
    }
    const forkRepo = `${botLogin}/mcp-registry`;
    const cloneUrl = `https://${botLogin}:${env.BOT_PAT}@github.com/${forkRepo}.git`;

    // 3. Clone the fork into a temp dir.
    const clone = await retryWithBackoff(
      async () => {
        const r = await exec('git', ['clone', '--depth', '1', cloneUrl, tmp]);
        if (r.exitCode !== 0) throw Object.assign(new Error(r.stderr), { code: 'ENETUNREACH' });
        return r;
      },
      { retryDelaysMs: [1_000, 3_000], sleep },
    ).catch((err) => err as Error);
    if (clone instanceof Error) {
      return failedOutput(input, isDryRun, now() - started, 1,
        `git clone failed: ${clone.message.slice(0, 300)}`,
        'Network failure cloning the bot fork.',
        '/retry-publish?step=docker-mcp-catalog once GitHub is reachable.');
    }

    // 4. Write the 3 files.
    const serverDir = path.join(tmp, 'servers', input.mcp_name);
    await fs.mkdir(serverDir, { recursive: true });
    await fs.writeFile(path.join(serverDir, 'server.yaml'), serverYaml, 'utf8');
    await fs.writeFile(path.join(serverDir, 'tools.json'), toolsJson, 'utf8');
    await fs.writeFile(path.join(serverDir, 'readme.md'), readmeMd, 'utf8');

    // 5. Commit + push on a fresh branch.
    const steps: ReadonlyArray<ReadonlyArray<string>> = [
      ['-C', tmp, 'config', 'user.email', `${botLogin}@users.noreply.github.com`],
      ['-C', tmp, 'config', 'user.name', botLogin],
      ['-C', tmp, 'checkout', '-b', branchName],
      ['-C', tmp, 'add', '.'],
      ['-C', tmp, 'commit', '-m', `${prTitle}\n\nPipeline run: ${input.pipeline_run_id}`],
      ['-C', tmp, 'push', '-u', 'origin', branchName],
    ];
    for (const args of steps) {
      const r = await exec('git', args);
      if (r.exitCode !== 0) {
        return failedOutput(input, isDryRun, now() - started, 1,
          `git ${args.join(' ')} failed: ${r.stderr.trim().slice(0, 300)}`,
          'Could not prepare the catalog PR locally.',
          `/retry-publish?step=docker-mcp-catalog.`);
      }
    }

    // 6. Open the PR upstream.
    const prBody = `Adds ${input.mcp_name} v${input.version} to the Docker MCP Catalog.\n\nGenerated by g-digital by Garrigues' distribution pipeline (run \`${input.pipeline_run_id}\`).\n\nSource: https://github.com/g-digital-by-Garrigues/MCP_Market_Distribution/tree/main/pending-to-publish/${input.mcp_name}`;
    const prCreate = await exec('gh', [
      'pr', 'create',
      '--repo', UPSTREAM_REPO,
      '--head', `${botLogin}:${branchName}`,
      '--base', 'main',
      '--title', prTitle,
      '--body', prBody,
    ], { env: { GH_TOKEN: env.BOT_PAT } });
    if (prCreate.exitCode !== 0) {
      const stderr = prCreate.stderr;
      if (/403/.test(stderr)) {
        return failedOutput(input, isDryRun, now() - started, 1,
          `gh pr create returned 403: ${stderr.trim().slice(0, 300)}`,
          'Bot PAT lacks public-repo issues permission.',
          'Verify PAT scope at github.com/settings/tokens (needs public_repo).');
      }
      return failedOutput(input, isDryRun, now() - started, 1,
        `gh pr create failed: ${stderr.trim().slice(0, 300)}`,
        'Could not open PR against docker/mcp-registry.',
        '/retry-publish?step=docker-mcp-catalog.');
    }

    const prUrl = prCreate.stdout.trim();
    log.info('target.publish_succeeded', { ...baseEvent, pr_url: prUrl });
    return successOutput(input, isDryRun, now() - started, 1, prUrl, 'succeeded');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function successOutput(
  input: PublishDockerMcpCatalogInput,
  isDryRun: boolean,
  duration: number,
  attempts: number,
  url: string,
  status: 'succeeded' | 'skipped',
): PublisherOutput {
  return validate({
    target: 'docker-mcp-catalog',
    status,
    target_url: url,
    version_published: input.version,
    duration_ms: duration,
    attempts,
    dry_run: isDryRun,
  });
}

function failedOutput(
  input: PublishDockerMcpCatalogInput,
  isDryRun: boolean,
  duration: number,
  attempts: number,
  message: string,
  cause: string,
  action: string,
): PublisherOutput {
  return validate({
    target: 'docker-mcp-catalog',
    status: 'failed',
    target_url: dryRunPlaceholderUrl('docker-mcp-catalog', input.mcp_name, input.version),
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
