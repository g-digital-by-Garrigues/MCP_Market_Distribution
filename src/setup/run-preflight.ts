import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { mcpPipelineConfigSchema } from '../schemas/mcp-pipeline-config.schema.js';
import {
  validateSourceFolder,
  type SourceFolderReport,
} from '../validators/validate-source-folder.js';

export interface PreflightResult {
  mcpName: string;
  ready: boolean;
  sourceReport: SourceFolderReport;
  configErrors: string[];
}

export interface RunPreflightOptions {
  mcpName: string;
  repoRoot: string;
}

export async function runPreflight(opts: RunPreflightOptions): Promise<PreflightResult> {
  const { mcpName, repoRoot } = opts;
  const configPath = path.join(repoRoot, 'mcp-pipeline.yaml');
  let configRaw: string;
  try {
    configRaw = await fs.readFile(configPath, 'utf8');
  } catch {
    return {
      mcpName,
      ready: false,
      sourceReport: { folder: '', expectedMcpName: '', checks: [], hasMissing: true },
      configErrors: [`mcp-pipeline.yaml not found at ${configPath}.`],
    };
  }

  const parsed = mcpPipelineConfigSchema.safeParse(yaml.load(configRaw));
  if (!parsed.success) {
    return {
      mcpName,
      ready: false,
      sourceReport: { folder: '', expectedMcpName: '', checks: [], hasMissing: true },
      configErrors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }

  const entry = parsed.data.mcps[mcpName];
  if (!entry) {
    return {
      mcpName,
      ready: false,
      sourceReport: { folder: '', expectedMcpName: '', checks: [], hasMissing: true },
      configErrors: [
        `mcp-pipeline.yaml has no entry for '${mcpName}'. Available keys: ${Object.keys(parsed.data.mcps).join(', ') || '(none)'}.`,
      ],
    };
  }

  const folder = path.join(repoRoot, 'pending-to-publish', mcpName);
  const sourceReport = await validateSourceFolder({
    folder,
    expectedMcpName: entry.reverse_dns_name,
  });

  return {
    mcpName,
    ready: !sourceReport.hasMissing && parsed.success,
    sourceReport,
    configErrors: [],
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0]?.startsWith('-')) {
    process.stderr.write('Usage: tsx src/setup/run-preflight.ts <mcp-name>\n');
    return 2;
  }
  const mcpName = args[0] as string;
  const result = await runPreflight({ mcpName, repoRoot: process.cwd() });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.ready ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
