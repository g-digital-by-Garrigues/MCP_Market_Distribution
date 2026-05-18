import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { mcpPipelineConfigSchema } from '../schemas/mcp-pipeline-config.schema.js';
import {
  loadDistributionConfig,
  DistributionConfigError,
} from '../distribution/load-distribution-config.js';

export type GrantClassification =
  | 'configured'
  | 'already-configured'
  | 'package-not-published'
  | 'failed';

export interface GrantOutcome {
  packageName: string;
  classification: GrantClassification;
  detail: string;
}

export interface RunTrustedPublishersResult {
  owner: string;
  repo: string;
  workflow: string;
  outcomes: GrantOutcome[];
  counts: Record<GrantClassification, number>;
}

export interface RunTrustedPublishersOptions {
  repoRoot: string;
  owner?: string;
  repo?: string;
  workflow?: string;
  /** When true, do not actually invoke npm. Used by unit tests. */
  dryRun?: boolean;
  /** Test hook: replaces spawnSync. */
  exec?: (cmd: string, args: readonly string[]) => { status: number; stdout: string; stderr: string };
}

const PUBLISH_WORKFLOW_DEFAULT = 'publish.yml';

function defaultExec(cmd: string, args: readonly string[]) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    status: result.status ?? -1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function inferOwnerRepoFromGit(repoRoot: string): { owner: string; repo: string } | null {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  const url = result.stdout?.toString().trim() ?? '';
  const match = url.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

function classifyTrustGrantOutput(
  status: number,
  stdout: string,
  stderr: string,
): { classification: GrantClassification; detail: string } {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (status === 0) {
    if (combined.includes('already') && combined.includes('trust')) {
      return { classification: 'already-configured', detail: 'Trust grant already in place.' };
    }
    return { classification: 'configured', detail: stdout.trim() || 'Trust grant created.' };
  }
  if (combined.includes('404') || combined.includes('not found') || combined.includes('does not exist')) {
    return {
      classification: 'package-not-published',
      detail: 'Publish a 0.0.0-bootstrap version first, then re-run /setup-trusted-publishers.',
    };
  }
  return { classification: 'failed', detail: (stderr || stdout).trim() };
}

export async function runTrustedPublishers(
  opts: RunTrustedPublishersOptions,
): Promise<RunTrustedPublishersResult> {
  const exec = opts.exec ?? defaultExec;
  const configPath = path.join(opts.repoRoot, 'mcp-pipeline.yaml');
  const configRaw = await fs.readFile(configPath, 'utf8');
  const parsed = mcpPipelineConfigSchema.parse(yaml.load(configRaw));

  let owner = opts.owner;
  let repo = opts.repo;
  if (!owner || !repo) {
    const inferred = inferOwnerRepoFromGit(opts.repoRoot);
    if (!inferred) {
      throw new Error(
        "Could not infer owner/repo from 'git remote get-url origin'. Pass --owner and --repo explicitly.",
      );
    }
    owner = owner ?? inferred.owner;
    repo = repo ?? inferred.repo;
  }
  const workflow = opts.workflow ?? PUBLISH_WORKFLOW_DEFAULT;

  // Per-MCP fields now live in each MCP repo's .distribution.yaml. The
  // operator must have cloned the MCP repo into pending-to-publish/<id>/
  // before running /setup-trusted-publishers (mirrors what the publish
  // workflow does via the checkout-mcp-source composite action). MCPs
  // without a local .distribution.yaml are skipped with a warning.
  const packages: string[] = [];
  for (const mcpName of Object.keys(parsed.mcps)) {
    let distribution;
    try {
      distribution = await loadDistributionConfig(opts.repoRoot, mcpName);
    } catch (err) {
      const msg = err instanceof DistributionConfigError ? err.message : (err as Error).message;
      process.stderr.write(
        `Skipping '${mcpName}': ${msg}\n  Clone the MCP source into pending-to-publish/${mcpName}/ first, then re-run.\n`,
      );
      continue;
    }
    packages.push(distribution.npm_package_name);
    const scope = distribution.npm_scope.startsWith('@')
      ? distribution.npm_scope
      : `@${distribution.npm_scope}`;
    packages.push(`${scope}/${distribution.n8n_adapter_target_name}`);
  }

  const seen = new Set<string>();
  const uniquePackages = packages.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));

  const outcomes: GrantOutcome[] = [];
  const counts: Record<GrantClassification, number> = {
    configured: 0,
    'already-configured': 0,
    'package-not-published': 0,
    failed: 0,
  };

  for (const packageName of uniquePackages) {
    if (opts.dryRun) {
      outcomes.push({
        packageName,
        classification: 'configured',
        detail: '(dry-run) would invoke npm trust grant',
      });
      counts.configured += 1;
      continue;
    }
    const result = exec('npm', [
      'trust',
      'grant',
      '--provider',
      'github',
      '--owner',
      owner,
      '--repo',
      repo,
      '--workflow',
      workflow,
      '--package',
      packageName,
    ]);
    const { classification, detail } = classifyTrustGrantOutput(
      result.status,
      result.stdout,
      result.stderr,
    );
    outcomes.push({ packageName, classification, detail });
    counts[classification] += 1;
  }

  return { owner, repo, workflow, outcomes, counts };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ownerIdx = args.indexOf('--owner');
  const repoIdx = args.indexOf('--repo');
  const workflowIdx = args.indexOf('--workflow');
  const result = await runTrustedPublishers({
    repoRoot: process.cwd(),
    owner: ownerIdx >= 0 ? args[ownerIdx + 1] : undefined,
    repo: repoIdx >= 0 ? args[repoIdx + 1] : undefined,
    workflow: workflowIdx >= 0 ? args[workflowIdx + 1] : undefined,
    dryRun,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.counts.failed > 0 ? 1 : 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
