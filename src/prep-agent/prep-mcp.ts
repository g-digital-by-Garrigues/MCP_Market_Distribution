import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  mcpPipelineConfigSchema,
  type McpPipelineConfig,
  type McpEntry,
} from '../schemas/mcp-pipeline-config.schema.js';
import {
  loadDistributionConfig,
  DistributionConfigError,
} from '../distribution/load-distribution-config.js';
import { validateSourceFolder } from '../validators/validate-source-folder.js';
import { generateEnvironmentVariables } from '../generators/generate-environment-variables.js';
import { generateServerJson } from '../generators/generate-server-json.js';
import { generateSmitheryYaml } from '../generators/generate-smithery-yaml.js';
import {
  generateAllInstallBlocks,
  SUPPORTED_CLIENT_IDS,
} from '../generators/generate-install-block.js';
import { generateReadme } from '../generators/generate-readme.js';
import { ensureSkillBundle } from '../generators/ensure-skill-bundle.js';
import { createReleaseTag } from '../state/create-release-tag.js';
import { safeStableStringify } from '../utils/stable-stringify.js';

export interface PrepMcpOptions {
  mcpName: string;
  repoRoot: string;
  skipCommit?: boolean;
  skipTag?: boolean;
}

export interface PrepMcpArtifact {
  relativePath: string;
  bytes: number;
}

export interface PrepMcpResult {
  mcpName: string;
  version: string;
  artifacts: PrepMcpArtifact[];
  tagName: string | null;
  commitSha: string | null;
}

export interface PrepMcpStepError {
  step: string;
  cause: string;
  action: string;
}

export class PrepMcpError extends Error {
  readonly step: string;
  readonly cause: string;
  readonly action: string;
  constructor(step: string, cause: string, action: string) {
    super(`[${step}] ${cause}`);
    this.name = 'PrepMcpError';
    this.step = step;
    this.cause = cause;
    this.action = action;
  }
  toReport(): PrepMcpStepError {
    return { step: this.step, cause: this.cause, action: this.action };
  }
}

async function loadConfig(repoRoot: string): Promise<McpPipelineConfig> {
  const configPath = path.join(repoRoot, 'mcp-pipeline.yaml');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new PrepMcpError(
      'load-config',
      `mcp-pipeline.yaml not found at ${configPath}.`,
      'Run /prep-mcp from the pipeline repo root, or create mcp-pipeline.yaml.',
    );
  }
  const parsed = yaml.load(raw);
  const result = mcpPipelineConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new PrepMcpError(
      'load-config',
      `mcp-pipeline.yaml failed schema validation: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      'Fix the offending fields in mcp-pipeline.yaml and re-run /prep-mcp.',
    );
  }
  return result.data;
}

function resolveEntry(config: McpPipelineConfig, mcpName: string): McpEntry {
  const entry = config.mcps[mcpName];
  if (!entry) {
    throw new PrepMcpError(
      'load-config',
      `mcp-pipeline.yaml has no entry for '${mcpName}'.`,
      `Add an mcps['${mcpName}'] entry, or pick one of: ${Object.keys(config.mcps).join(', ') || '(none defined yet)'}.`,
    );
  }
  return entry;
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeFileSafely(filePath: string, content: string): Promise<number> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return Buffer.byteLength(content, 'utf8');
}

function gitInRepo(
  repoRoot: string,
  args: readonly string[],
  input?: string,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

export async function prepMcp(opts: PrepMcpOptions): Promise<PrepMcpResult> {
  const { mcpName, repoRoot, skipCommit = false, skipTag = false } = opts;

  const config = await loadConfig(repoRoot);
  resolveEntry(config, mcpName); // ensure repo_url entry exists; per-MCP fields come from .distribution.yaml
  const mcpFolder = path.join(repoRoot, 'pending-to-publish', mcpName);

  let distribution;
  try {
    distribution = await loadDistributionConfig(repoRoot, mcpName);
  } catch (err) {
    if (err instanceof DistributionConfigError) {
      throw new PrepMcpError(
        'load-config',
        err.message,
        `Add a valid .distribution.yaml at the root of the ${mcpName} source repo, re-clone, and re-run /prep-mcp.`,
      );
    }
    throw err;
  }

  // Step 1: source validation (Story 1.3)
  const sourceReport = await validateSourceFolder({
    folder: mcpFolder,
    expectedMcpName: distribution.reverse_dns_name,
  });
  if (sourceReport.hasMissing) {
    const missing = sourceReport.checks
      .filter((c) => c.status === 'missing')
      .map((c) => `  • ${c.name}: ${c.remediation ?? '(no remediation provided)'}`)
      .join('\n');
    throw new PrepMcpError(
      'validate-source',
      `Source folder '${mcpFolder}' is missing required elements:\n${missing}`,
      'Fix the missing elements above and re-run /prep-mcp.',
    );
  }

  // Step 2: version from package.json (v1 — engineer-managed; Story 1.4 used in CI when commits are available)
  const sourcePkgPath = path.join(mcpFolder, 'package.json');
  const sourcePkgInitial = await readJson(sourcePkgPath);
  const version = sourcePkgInitial.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new PrepMcpError(
      'resolve-version',
      `package.json#version is missing or not semver in ${sourcePkgPath}.`,
      'Set a valid semver value (e.g., "1.0.0") in package.json#version.',
    );
  }

  // Step 3: env vars manifest (Story 1.5)
  const envExamplePath = path.join(mcpFolder, '.env.example');
  const envExampleContent = await fs.readFile(envExamplePath, 'utf8');
  const envManifest = generateEnvironmentVariables({
    envExampleContent,
    credentialHelpUrl: distribution.credential_help_url,
  });

  // Step 4: server.json (Story 1.6)
  const serverJson = await generateServerJson({
    config: {
      reverse_dns_name: distribution.reverse_dns_name,
      npm_package_name: distribution.npm_package_name,
      mcp_schema_version: config.mcp_schema_version,
    },
    packageJson: sourcePkgInitial as {
      description?: string;
      repository?: string | { type?: string; url: string };
    },
    environmentVariables: envManifest.environmentVariables,
    version,
  });

  // Step 5: smithery.yaml (Story 1.7)
  const smithery = await generateSmitheryYaml({
    environmentVariables: envManifest.environmentVariables,
  });

  // Step 6: install blocks (Story 1.8)
  const installBlocks = await generateAllInstallBlocks({
    config: {
      reverse_dns_name: distribution.reverse_dns_name,
      npm_package_name: distribution.npm_package_name,
      credential_help_url: distribution.credential_help_url,
    },
    environmentVariables: envManifest.environmentVariables,
  });

  // Step 7: README (Story 1.9)
  const sourceReadme = await fs.readFile(path.join(mcpFolder, 'README.md'), 'utf8');
  const readme = generateReadme({
    sourceReadme,
    installBlocks,
    environmentVariables: envManifest.environmentVariables,
  });

  // Step 8: ensure skill bundle in package.json (Story 1.10)
  const { packageJson: updatedPkg } = ensureSkillBundle({ packageJson: sourcePkgInitial });

  // Write all artifacts to the source folder
  const artifacts: PrepMcpArtifact[] = [];
  const writes: Array<[string, string]> = [
    ['server.json', serverJson.json + '\n'],
    ['smithery.yaml', smithery.yaml],
    ['README.md', readme.markdown],
    ['environmentVariables.json', safeStableStringify(envManifest, 2) + '\n'],
    ['package.json', safeStableStringify(updatedPkg, 2) + '\n'],
  ];
  for (const [rel, content] of writes) {
    const bytes = await writeFileSafely(path.join(mcpFolder, rel), content);
    artifacts.push({ relativePath: rel, bytes });
  }
  for (const clientId of SUPPORTED_CLIENT_IDS) {
    const rel = path.join('install-blocks', `${clientId}.md`);
    const block = installBlocks[clientId];
    const bytes = await writeFileSafely(path.join(mcpFolder, rel), block.markdown);
    artifacts.push({ relativePath: rel.replace(/\\/g, '/'), bytes });
  }

  // Step 9: commit
  let commitSha: string | null = null;
  if (!skipCommit) {
    const stagePaths = [path.join('pending-to-publish', mcpName)];
    const add = gitInRepo(repoRoot, ['add', '--', ...stagePaths]);
    if (add.status !== 0) {
      throw new PrepMcpError(
        'commit',
        `git add failed: ${add.stderr.trim()}`,
        'Resolve git state (e.g., conflicts, missing repo) and re-run /prep-mcp.',
      );
    }
    const statusOut = gitInRepo(repoRoot, ['status', '--porcelain', '--', ...stagePaths]);
    if (statusOut.stdout.trim().length === 0) {
      // No changes to commit — artifacts already match disk, treat as success-no-op
    } else {
      const summary = `chore(${mcpName}): prep v${version} artifacts\n\n${artifacts.map((a) => `- ${a.relativePath} (${a.bytes} bytes)`).join('\n')}\n`;
      const commit = gitInRepo(repoRoot, ['commit', '--file=-'], summary);
      if (commit.status !== 0) {
        throw new PrepMcpError(
          'commit',
          `git commit failed: ${commit.stderr.trim()}`,
          'Resolve git state and re-run /prep-mcp.',
        );
      }
      const revparse = gitInRepo(repoRoot, ['rev-parse', 'HEAD']);
      commitSha = revparse.stdout.trim() || null;
    }
  }

  // Step 10: tag (Story 1.11)
  let tagName: string | null = null;
  if (!skipTag) {
    const result = createReleaseTag({
      version,
      summaryLines: artifacts.map((a) => a.relativePath),
      cwd: repoRoot,
    });
    tagName = result.tagName;
  }

  return { mcpName, version, artifacts, tagName, commitSha };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0]?.startsWith('-')) {
    process.stderr.write(
      'Usage: tsx src/prep-agent/prep-mcp.ts <mcp-name> [--skip-commit] [--skip-tag]\n',
    );
    return 2;
  }
  const mcpName = args[0] as string;
  const skipCommit = args.includes('--skip-commit');
  const skipTag = args.includes('--skip-tag');

  try {
    const result = await prepMcp({
      mcpName,
      repoRoot: process.cwd(),
      skipCommit,
      skipTag,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof PrepMcpError) {
      process.stderr.write(JSON.stringify(err.toReport(), null, 2) + '\n');
      return 1;
    }
    process.stderr.write(
      JSON.stringify(
        {
          step: 'unknown',
          cause: (err as Error).message ?? String(err),
          action: 'Inspect the stack trace and re-run /prep-mcp once the underlying issue is fixed.',
        },
        null,
        2,
      ) + '\n',
    );
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
