import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ErrorReport } from '../schemas/error-report.schema.js';
import type { McpbBundleSpec } from '../adapters/mcpb-adapter/types.js';
import { MCPB_MANIFEST_VERSION } from '../adapters/mcpb-adapter/types.js';

// Story 5.10a: Track C — Layer 1 (structural lint).
//
// Cheap, deterministic pass over the pre-pack MCPB bundle tree (the
// directory that run-mcpb-adapter-build.ts produces). Asserts the
// generator wrote a manifest that matches the spec and the bundle
// has the file layout MCPB hosts expect, WITHOUT shelling out to
// `mcpb validate` (that's Layer 2).
//
// Checks (each maps to one ErrorReport):
//   - file_layout: manifest.json + README.md + server/<entry> + server/node_modules + .mcpb file all on disk
//   - manifest:    manifest_version, name, version, author.name, server.type/entry_point/mcp_config shape
//   - user_config: every spec.userConfig field is declared in manifest.user_config AND
//                  surfaces in manifest.server.mcp_config.env as ${user_config.<key>}
//   - readme:      every operation + every user_config field is mentioned
//
// Reads the spec from `<bundleDir>/.spec.json` when not passed via opts
// (so the CLI invocation matches Track B's pattern).

function gateError(
  check: string,
  fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>,
): ErrorReport {
  return { stage: 'gate', layer: 1, target: 'smithery', check, ...fields };
}

export interface TrackCLayer1CheckResult {
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackCLayer1Result {
  passed: boolean;
  mcpName: string;
  checks: TrackCLayer1CheckResult[];
  errors: ErrorReport[];
  log: {
    event: 'gate.track_c_layer_1_passed' | 'gate.track_c_layer_1_failed';
    pipeline_run_id?: string;
  };
}

export interface RunTrackCLayer1Options {
  /** MCP id (kebab-case). */
  mcpName: string;
  /**
   * Absolute path to the pre-pack bundle directory (output of
   * run-mcpb-adapter-build.ts). Contains manifest.json, README.md,
   * server/, the packed .mcpb, plus .spec.json and .mcpb-build.json.
   */
  bundleDir: string;
  /** The McpbBundleSpec the codegen consumed. Truth source for the lint. */
  spec: McpbBundleSpec;
  pipelineRunId?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function expectedBundleFileName(spec: McpbBundleSpec): string {
  return `${spec.name}-v${spec.version}.mcpb`;
}

async function checkFileLayout(opts: RunTrackCLayer1Options): Promise<TrackCLayer1CheckResult> {
  const { bundleDir, spec } = opts;
  const missing: string[] = [];

  for (const rel of ['manifest.json', 'README.md']) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await fileExists(path.join(bundleDir, rel)))) missing.push(rel);
  }
  if (!(await fileExists(path.join(bundleDir, spec.entryPoint)))) {
    missing.push(spec.entryPoint);
  }
  if (!(await dirExists(path.join(bundleDir, 'server', 'node_modules')))) {
    missing.push('server/node_modules/ (CLI shim should populate this via `npm install --omit=dev`)');
  }
  if (!(await fileExists(path.join(bundleDir, expectedBundleFileName(spec))))) {
    missing.push(expectedBundleFileName(spec));
  }

  if (missing.length === 0) return { name: 'file_layout', passed: true };
  return {
    name: 'file_layout',
    passed: false,
    error: gateError('file_layout', {
      observation: `Generated MCPB bundle tree is missing required files: ${missing.join(', ')}.`,
      cause: 'The mcpb-adapter generator or the CLI shim (run-mcpb-adapter-build.ts) did not produce the canonical pre-pack layout.',
      action: 'Re-run the MCPB adapter build with clean=true and inspect for write failures or non-zero exits from `npm install` / `mcpb pack`.',
    }),
  };
}

interface ManifestShape {
  manifest_version?: string;
  name?: string;
  version?: string;
  description?: string;
  author?: { name?: string };
  homepage?: string;
  repository?: { type?: string; url?: string };
  icon?: string;
  keywords?: string[];
  tools_generated?: boolean;
  tools?: Array<{ name?: string; description?: string }>;
  server?: {
    type?: string;
    entry_point?: string;
    mcp_config?: {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    };
  };
  user_config?: Record<string, { type?: string; title?: string; sensitive?: boolean; required?: boolean }>;
}

async function readManifest(bundleDir: string): Promise<ManifestShape | { __error: string }> {
  const filePath = path.join(bundleDir, 'manifest.json');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return { __error: `manifest.json could not be read: ${(err as Error).message}` };
  }
  try {
    return JSON.parse(raw) as ManifestShape;
  } catch (err) {
    return { __error: `manifest.json is not valid JSON: ${(err as Error).message}` };
  }
}

async function checkManifest(opts: RunTrackCLayer1Options): Promise<TrackCLayer1CheckResult> {
  const { bundleDir, spec } = opts;
  const m = await readManifest(bundleDir);
  if ('__error' in m) {
    return {
      name: 'manifest',
      passed: false,
      error: gateError('manifest', {
        observation: m.__error,
        cause: 'The codegen pass did not write manifest.json OR wrote invalid JSON.',
        action: 'Inspect templates/mcpb-adapter/manifest.json.hbs for syntax errors and re-run the generator.',
        source_path: 'manifest.json',
      }),
    };
  }

  const issues: string[] = [];
  if (m.manifest_version !== MCPB_MANIFEST_VERSION) {
    issues.push(`manifest_version='${m.manifest_version}' expected '${MCPB_MANIFEST_VERSION}'`);
  }
  if (m.name !== spec.name) issues.push(`name='${m.name}' expected '${spec.name}'`);
  if (m.version !== spec.version) issues.push(`version='${m.version}' expected '${spec.version}'`);
  if (!m.author?.name || m.author.name.length === 0) {
    issues.push("author.name is required and must be a non-empty string");
  }
  if (m.server?.type !== 'node') issues.push(`server.type='${m.server?.type}' expected 'node'`);
  if (m.server?.entry_point !== spec.entryPoint) {
    issues.push(`server.entry_point='${m.server?.entry_point}' expected '${spec.entryPoint}'`);
  }
  if (m.server?.mcp_config?.command !== 'node') {
    issues.push(`server.mcp_config.command='${m.server?.mcp_config?.command}' expected 'node'`);
  }
  const args = m.server?.mcp_config?.args ?? [];
  if (!args.some((a) => a.includes(spec.entryPoint))) {
    issues.push(`server.mcp_config.args must reference '${spec.entryPoint}'`);
  }
  // Manifest metadata that materially affects how Smithery indexes the
  // bundle. We discovered in the first real publish (v1.0.7, run
  // #26110512056) that omitting these fields left the Smithery listing
  // looking abandoned (`description: ""`, `tools: null`). Layer 1 now
  // catches drift instead of letting it ship.
  if (!m.repository?.url || m.repository.url.length === 0) {
    issues.push("repository.url must be set so Smithery surfaces the GitHub repo link");
  }
  if (!m.homepage || m.homepage.length === 0) {
    issues.push("homepage must be set");
  }
  if (m.tools_generated !== false) {
    issues.push("tools_generated must be explicitly false (we declare the full tool set at manifest-build time)");
  }
  if (!Array.isArray(m.tools) || m.tools.length !== spec.operations.length) {
    issues.push(`tools[] must have ${spec.operations.length} entries (got ${Array.isArray(m.tools) ? m.tools.length : 'undefined'})`);
  } else {
    const expected = new Set(spec.operations.map((o) => o.name));
    const got = new Set(m.tools.map((t) => t.name ?? ''));
    const missing = [...expected].filter((n) => !got.has(n));
    if (missing.length > 0) {
      issues.push(`tools[] missing entries for: ${missing.join(', ')}`);
    }
  }
  if (spec.iconPath && m.icon !== spec.iconPath) {
    issues.push(`icon='${m.icon}' expected '${spec.iconPath}'`);
  }

  if (issues.length === 0) return { name: 'manifest', passed: true };
  return {
    name: 'manifest',
    passed: false,
    error: gateError('manifest', {
      observation: `manifest.json structural lint failed: ${issues.join('; ')}.`,
      cause: 'The codegen produced a manifest that does not match the spec it was built from — template drift.',
      action: 'Diff templates/mcpb-adapter/manifest.json.hbs against the McpbBundleSpec contract; each listed field must thread through.',
      source_path: 'manifest.json',
    }),
  };
}

async function checkUserConfig(opts: RunTrackCLayer1Options): Promise<TrackCLayer1CheckResult> {
  const { bundleDir, spec } = opts;
  const m = await readManifest(bundleDir);
  if ('__error' in m) {
    return { name: 'user_config', passed: true }; // manifest check already reported it
  }

  const issues: string[] = [];
  const userConfig = m.user_config ?? {};
  const envBlock = m.server?.mcp_config?.env ?? {};
  for (const field of spec.userConfig) {
    const entry = userConfig[field.configKey];
    if (!entry) {
      issues.push(`user_config['${field.configKey}'] missing`);
      continue;
    }
    if (entry.sensitive !== field.sensitive) {
      issues.push(`user_config['${field.configKey}'].sensitive=${entry.sensitive}, expected ${field.sensitive}`);
    }
    if (entry.required !== field.required) {
      issues.push(`user_config['${field.configKey}'].required=${entry.required}, expected ${field.required}`);
    }
    // The substitution must reference the right config key.
    const envValue = envBlock[field.envName];
    const expectedSub = `\${user_config.${field.configKey}}`;
    if (envValue !== expectedSub) {
      issues.push(`mcp_config.env['${field.envName}']='${envValue}' expected '${expectedSub}'`);
    }
  }
  if (issues.length === 0) return { name: 'user_config', passed: true };
  return {
    name: 'user_config',
    passed: false,
    error: gateError('user_config', {
      observation: `manifest.user_config structural lint failed: ${issues.join('; ')}.`,
      cause: 'The manifest does not declare a user_config entry (or the right substitution) for every env var the spec carries.',
      action: 'Re-run the adapter build; this almost always means a template drift in manifest.json.hbs or a bug in build-mcpb-spec.ts envName → configKey mapping.',
      source_path: 'manifest.json',
    }),
  };
}

async function checkReadme(opts: RunTrackCLayer1Options): Promise<TrackCLayer1CheckResult> {
  const { bundleDir, spec } = opts;
  const filePath = path.join(bundleDir, 'README.md');
  let src: string;
  try {
    src = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      name: 'readme',
      passed: false,
      error: gateError('readme', {
        observation: 'README.md is missing from the bundle dir.',
        cause: 'The codegen pass did not write the README.',
        action: 'Re-run the MCPB adapter build.',
        source_path: 'README.md',
      }),
    };
  }
  const missing: string[] = [];
  for (const op of spec.operations) {
    if (!src.includes('`' + op.name + '`')) missing.push(`operation '${op.name}'`);
  }
  for (const cfg of spec.userConfig) {
    if (!src.includes('`' + cfg.envName + '`')) missing.push(`env '${cfg.envName}'`);
  }
  if (missing.length === 0) return { name: 'readme', passed: true };
  return {
    name: 'readme',
    passed: false,
    error: gateError('readme', {
      observation: `README.md does not mention: ${missing.join(', ')}.`,
      cause: 'README was generated against a different spec than the manifest — partial re-render likely.',
      action: 'Re-run the MCPB adapter build with clean=true so README.md is overwritten alongside the other files.',
      source_path: 'README.md',
    }),
  };
}

export async function runTrackCLayer1(
  opts: RunTrackCLayer1Options,
): Promise<TrackCLayer1Result> {
  const checks: TrackCLayer1CheckResult[] = [];
  checks.push(await checkFileLayout(opts));
  checks.push(await checkManifest(opts));
  checks.push(await checkUserConfig(opts));
  checks.push(await checkReadme(opts));

  const errors = checks.filter((c) => !c.passed).map((c) => c.error!);
  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    checks,
    errors,
    log: {
      event: passed ? 'gate.track_c_layer_1_passed' : 'gate.track_c_layer_1_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

async function readSpec(specPath: string): Promise<McpbBundleSpec> {
  const raw = await fs.readFile(specPath, 'utf8');
  return JSON.parse(raw) as McpbBundleSpec;
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const bundleDir = process.argv[3];
  const specPath = process.argv[4] ?? (bundleDir ? path.join(bundleDir, '.spec.json') : undefined);
  if (!mcpName || !bundleDir || !specPath) {
    process.stderr.write('Usage: tsx src/gates/run-track-c-layer-1.ts <mcp-name> <bundle-dir> [<spec-json>]\n');
    return 2;
  }
  let spec: McpbBundleSpec;
  try {
    spec = await readSpec(specPath);
  } catch (err) {
    process.stderr.write(`Could not read spec at ${specPath}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = await runTrackCLayer1({
    mcpName,
    bundleDir,
    spec,
    ...(process.env.PIPELINE_RUN_ID ? { pipelineRunId: process.env.PIPELINE_RUN_ID } : {}),
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
