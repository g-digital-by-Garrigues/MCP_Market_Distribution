import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  mcpPipelineConfigSchema,
  type McpEntry,
} from '../schemas/mcp-pipeline-config.schema.js';
import { validateSourceFolder } from '../validators/validate-source-folder.js';
import type { ErrorReport } from '../schemas/error-report.schema.js';

const requireCjs = createRequire(import.meta.url);
const addFormats = requireCjs('ajv-formats') as (ajv: InstanceType<typeof Ajv2020>) => void;

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
  'server-json',
  'server-schema-v2025-12-11.json',
);

const MIT_PATTERN = /MIT License/i;
const APACHE_PATTERN = /Apache License[\s\S]{0,200}Version\s*2\.0/i;

export interface CheckResult {
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackALayer1Result {
  passed: boolean;
  mcpName: string;
  checks: CheckResult[];
  errors: ErrorReport[];
  log: { event: 'gate.layer_1_passed' | 'gate.layer_1_failed'; pipeline_run_id?: string };
}

export interface RunTrackALayer1Options {
  repoRoot: string;
  mcpName: string;
  pipelineRunId?: string;
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

async function checkSource(
  mcpFolder: string,
  entry: McpEntry,
): Promise<CheckResult> {
  const report = await validateSourceFolder({
    folder: mcpFolder,
    expectedMcpName: entry.reverse_dns_name,
  });
  if (!report.hasMissing) {
    return { name: 'source-folder', passed: true };
  }
  const missing = report.checks
    .filter((c) => c.status === 'missing')
    .map((c) => `${c.name}: ${c.remediation ?? '(no remediation)'}`)
    .join(' | ');
  return {
    name: 'source-folder',
    passed: false,
    error: {
      step: 'gate.layer_1.source_folder',
      cause: `Source folder is missing required elements: ${missing}`,
      action: 'Run /preflight-mcp <mcp-name> locally, apply each remediation, then re-tag the release.',
      level: 'error',
      source_path: path.relative(path.dirname(mcpFolder), mcpFolder),
    },
  };
}

let cachedValidator: ReturnType<InstanceType<typeof Ajv2020>['compile']> | null = null;
async function loadServerSchemaValidator(): Promise<
  ReturnType<InstanceType<typeof Ajv2020>['compile']>
> {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemaRaw = await fs.readFile(SCHEMA_PATH, 'utf8');
  cachedValidator = ajv.compile(JSON.parse(schemaRaw));
  return cachedValidator;
}

async function checkServerJson(mcpFolder: string): Promise<CheckResult> {
  const filePath = path.join(mcpFolder, 'server.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      name: 'server-json',
      passed: false,
      error: {
        step: 'gate.layer_1.server_json',
        cause: `server.json is missing at ${filePath}.`,
        action: 'Run /prep-mcp <mcp-name> to regenerate the artifact, commit the result, and re-tag.',
        level: 'error',
        source_path: 'server.json',
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      name: 'server-json',
      passed: false,
      error: {
        step: 'gate.layer_1.server_json',
        cause: `server.json is not valid JSON: ${(err as Error).message}`,
        action: 'Run /prep-mcp <mcp-name> to regenerate the artifact and commit the result.',
        level: 'error',
        source_path: 'server.json',
      },
    };
  }
  const validate = await loadServerSchemaValidator();
  if (!validate(parsed)) {
    const messages = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
      .join('; ');
    return {
      name: 'server-json',
      passed: false,
      error: {
        step: 'gate.layer_1.server_json',
        cause: `server.json failed schema validation: ${messages}`,
        action: 'Run /prep-mcp <mcp-name> to regenerate; if the failure persists, sync the pinned schema snapshot under templates/server-json/.',
        level: 'error',
        source_path: 'server.json',
      },
    };
  }
  return { name: 'server-json', passed: true };
}

async function checkSmitheryYaml(mcpFolder: string): Promise<CheckResult> {
  const filePath = path.join(mcpFolder, 'smithery.yaml');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      name: 'smithery-yaml',
      passed: false,
      error: {
        step: 'gate.layer_1.smithery_yaml',
        cause: `smithery.yaml is missing at ${filePath}.`,
        action: 'Run /prep-mcp <mcp-name> to regenerate the artifact and commit the result.',
        level: 'error',
        source_path: 'smithery.yaml',
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      name: 'smithery-yaml',
      passed: false,
      error: {
        step: 'gate.layer_1.smithery_yaml',
        cause: `smithery.yaml does not parse as YAML: ${(err as Error).message}`,
        action: 'Run /prep-mcp <mcp-name> to regenerate the artifact and commit the result.',
        level: 'error',
        source_path: 'smithery.yaml',
      },
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      name: 'smithery-yaml',
      passed: false,
      error: {
        step: 'gate.layer_1.smithery_yaml',
        cause: 'smithery.yaml parsed but the root is not an object.',
        action: 'Run /prep-mcp <mcp-name> to regenerate; the template should emit a top-level mapping (runtime, env, configSchema).',
        level: 'error',
        source_path: 'smithery.yaml',
      },
    };
  }
  return { name: 'smithery-yaml', passed: true };
}

async function findLicenseFile(mcpFolder: string): Promise<string | null> {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const candidate = path.join(mcpFolder, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* not present */
    }
  }
  return null;
}

async function checkLicense(mcpFolder: string, entry: McpEntry): Promise<CheckResult> {
  const filePath = await findLicenseFile(mcpFolder);
  if (!filePath) {
    return {
      name: 'license',
      passed: false,
      error: {
        step: 'gate.layer_1.license',
        cause: `No LICENSE file found in ${mcpFolder}.`,
        action: 'Add a LICENSE file (MIT or Apache-2.0) at the MCP root and re-tag.',
        level: 'error',
        source_path: 'LICENSE',
      },
    };
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const isMit = MIT_PATTERN.test(raw);
  const isApache = APACHE_PATTERN.test(raw);
  if (!isMit && !isApache) {
    return {
      name: 'license',
      passed: false,
      error: {
        step: 'gate.layer_1.license',
        cause: `${path.basename(filePath)} content is neither MIT License nor Apache License, Version 2.0.`,
        action: 'Change LICENSE to MIT or Apache-2.0; Docker MCP Catalog rejects GPL.',
        level: 'error',
        source_path: path.basename(filePath),
      },
    };
  }
  const expected = entry.license;
  if (expected === 'MIT' && !isMit) {
    return {
      name: 'license',
      passed: false,
      error: {
        step: 'gate.layer_1.license',
        cause: `mcp-pipeline.yaml declares license: MIT but ${path.basename(filePath)} content matches Apache-2.0.`,
        action: 'Align mcp-pipeline.yaml#license with the LICENSE file content, then re-tag.',
        level: 'error',
        source_path: path.basename(filePath),
      },
    };
  }
  if (expected === 'Apache-2.0' && !isApache) {
    return {
      name: 'license',
      passed: false,
      error: {
        step: 'gate.layer_1.license',
        cause: `mcp-pipeline.yaml declares license: Apache-2.0 but ${path.basename(filePath)} content matches MIT.`,
        action: 'Align mcp-pipeline.yaml#license with the LICENSE file content, then re-tag.',
        level: 'error',
        source_path: path.basename(filePath),
      },
    };
  }
  return { name: 'license', passed: true };
}

export async function runTrackALayer1(
  opts: RunTrackALayer1Options,
): Promise<TrackALayer1Result> {
  const entry = await loadEntry(opts.repoRoot, opts.mcpName);
  const mcpFolder = path.join(opts.repoRoot, 'pending-to-publish', opts.mcpName);

  const checks: CheckResult[] = [];
  checks.push(await checkSource(mcpFolder, entry));
  checks.push(await checkServerJson(mcpFolder));
  checks.push(await checkSmitheryYaml(mcpFolder));
  checks.push(await checkLicense(mcpFolder, entry));

  const errors = checks.filter((c) => !c.passed).map((c) => c.error!);
  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    checks,
    errors,
    log: {
      event: passed ? 'gate.layer_1_passed' : 'gate.layer_1_failed',
      pipeline_run_id: opts.pipelineRunId,
    },
  };
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  if (!mcpName || mcpName.startsWith('-')) {
    process.stderr.write('Usage: tsx src/gates/run-track-a-layer-1.ts <mcp-name>\n');
    return 2;
  }
  const result = await runTrackALayer1({
    repoRoot: process.cwd(),
    mcpName,
    pipelineRunId: process.env.PIPELINE_RUN_ID,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.passed ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
