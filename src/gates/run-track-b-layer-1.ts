import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ErrorReport } from '../schemas/error-report.schema.js';
import type { N8nNodeSpec } from '../adapters/n8n-adapter/types.js';

// Story 5.2: Track B — Layer 1 (structural lint).
//
// Cheap, deterministic, side-effect-free pass over the generated n8n
// node tree. Asserts the codegen produced a valid n8n-community-node
// package WITHOUT installing deps or running tsc (that's Layer 2).
// Lets a broken codegen change fail fast before we ship a half-baked
// node to npm.
//
// Checks (each maps to one ErrorReport):
//   - file_layout: all expected files exist
//   - package_json: n8n loader hints, source-MCP dep pinned, valid name
//   - node_class:   right class name, INodeType impl, every spec
//                   operation in the dropdown, OPERATION_PROPERTY_NAMES
//                   table complete
//   - credentials:  right class name, ICredentialType impl, every spec
//                   credential field present
//   - readme:       every operation and credential mentioned in a table
//
// Out of scope for v1: ESLint rules from eslint-plugin-n8n-nodes-base —
// can be layered on later. The checks here cover the breakage modes our
// own codegen can actually produce.

function gateError(
  check: string,
  fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>,
): ErrorReport {
  return { stage: 'gate', layer: 1, target: 'n8n', check, ...fields };
}

export interface TrackBLayer1CheckResult {
  name: string;
  passed: boolean;
  error?: ErrorReport;
}

export interface TrackBLayer1Result {
  passed: boolean;
  mcpName: string;
  checks: TrackBLayer1CheckResult[];
  errors: ErrorReport[];
  log: {
    event: 'gate.track_b_layer_1_passed' | 'gate.track_b_layer_1_failed';
    pipeline_run_id?: string;
  };
}

export interface RunTrackBLayer1Options {
  /** MCP id (kebab-case). */
  mcpName: string;
  /** Absolute path to the generated n8n node tree. */
  nodeDir: string;
  /** The N8nNodeSpec the codegen consumed — used as the truth source for the lint. */
  spec: N8nNodeSpec;
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

async function checkFileLayout(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const expected = [
    'package.json',
    'tsconfig.json',
    'README.md',
    'index.ts',
    path.posix.join('nodes', spec.className, `${spec.className}.node.ts`),
    path.posix.join('credentials', `${spec.credentialClassName}.credentials.ts`),
  ];
  const missing: string[] = [];
  for (const rel of expected) {
    // eslint-disable-next-line no-await-in-loop
    const present = await fileExists(path.join(nodeDir, rel));
    if (!present) missing.push(rel);
  }
  if (missing.length === 0) return { name: 'file_layout', passed: true };
  return {
    name: 'file_layout',
    passed: false,
    error: gateError('file_layout', {
      observation: `Generated n8n node tree is missing required files: ${missing.join(', ')}.`,
      cause: 'The codegen pass did not write one or more expected files — likely a template error or partial write.',
      action: 'Re-run the n8n adapter generator and inspect for write failures; rebuild from a clean output dir.',
    }),
  };
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

interface PackageJsonShape {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  n8n?: {
    n8nNodesApiVersion?: number;
    nodes?: string[];
    credentials?: string[];
  };
}

// Reads the adapter-build summary `run-adapter-build.ts` drops next to
// the tree. Returns null when absent (older builds, tests) so the
// caller falls back to "expect the registry-pinned form".
async function readAdapterBuildSummary(
  nodeDir: string,
): Promise<{ dry_run?: boolean; source_substituted?: boolean } | null> {
  const summaryPath = path.join(nodeDir, '.adapter-build.json');
  try {
    return await readJson<{ dry_run?: boolean; source_substituted?: boolean }>(summaryPath);
  } catch {
    return null;
  }
}

async function checkPackageJson(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const pkgPath = path.join(nodeDir, 'package.json');
  let pkg: PackageJsonShape;
  try {
    pkg = await readJson<PackageJsonShape>(pkgPath);
  } catch (err) {
    return {
      name: 'package_json',
      passed: false,
      error: gateError('package_json', {
        observation: `package.json failed to parse: ${(err as Error).message}`,
        cause: 'The generated package.json is missing or malformed.',
        action: 'Inspect templates/n8n-adapter/package.json.hbs and the codegen output for syntax errors.',
        source_path: 'package.json',
      }),
    };
  }

  // `run-adapter-build.ts` rewrites the source-MCP dep to a local
  // `file:./<tarball>.tgz` URL whenever it runs in dry_run mode (so
  // Layer 2/3/publish-n8n can install without the source MCP being
  // live on the registry). Layer 1 has to recognise that legitimate
  // form; otherwise it would flag the dry-run path as drift. Source
  // of truth: .adapter-build.json#source_substituted, written by
  // run-adapter-build.ts.
  const buildSummary = await readAdapterBuildSummary(nodeDir);
  const substitutedSourceDepExpected = buildSummary?.dry_run === true && buildSummary?.source_substituted === true;

  const issues: string[] = [];
  if (pkg.name !== spec.packageName) {
    issues.push(`name='${pkg.name}' expected '${spec.packageName}'`);
  }
  if (pkg.version !== spec.version) {
    issues.push(`version='${pkg.version}' expected '${spec.version}'`);
  }
  if (pkg.n8n?.n8nNodesApiVersion !== 1) {
    issues.push("n8n.n8nNodesApiVersion must be 1");
  }
  const expectedNodePath = `dist/nodes/${spec.className}/${spec.className}.node.js`;
  if (!pkg.n8n?.nodes?.includes(expectedNodePath)) {
    issues.push(`n8n.nodes must include '${expectedNodePath}'`);
  }
  const expectedCredPath = `dist/credentials/${spec.credentialClassName}.credentials.js`;
  if (!pkg.n8n?.credentials?.includes(expectedCredPath)) {
    issues.push(`n8n.credentials must include '${expectedCredPath}'`);
  }
  // n8n Verified Community Node requirement: zero runtime dependencies.
  // @modelcontextprotocol/sdk and the source MCP are bundled by tsup
  // into dist/; they belong in devDependencies, not dependencies.
  const runtimeDepKeys = Object.keys(pkg.dependencies ?? {});
  if (runtimeDepKeys.length > 0) {
    issues.push(
      `dependencies must be empty (n8n Verified requires zero runtime deps); found: ${runtimeDepKeys.join(', ')}`,
    );
  }
  // Source MCP and SDK must be in devDependencies (bundled by tsup).
  const sourceDep = pkg.devDependencies?.[spec.sourceMcpPackageName];
  if (!sourceDep) {
    issues.push(`devDependencies must include '${spec.sourceMcpPackageName}'`);
  } else if (substitutedSourceDepExpected) {
    // Dry-run with substitution applied — accept a `file:./<...>.tgz`
    // form. Sanity-check that the filename references spec.version so
    // we still catch a stale-tarball drift.
    if (!sourceDep.startsWith('file:')) {
      issues.push(
        `dry-run substitution active but devDependencies['${spec.sourceMcpPackageName}'] is '${sourceDep}' — expected a 'file:./<...>.tgz' link`,
      );
    } else if (!sourceDep.includes(spec.version)) {
      issues.push(
        `dry-run substituted devDependencies['${spec.sourceMcpPackageName}']='${sourceDep}' does not reference spec.version='${spec.version}'`,
      );
    }
  } else if (sourceDep !== spec.version) {
    issues.push(
      `devDependencies['${spec.sourceMcpPackageName}'] must pin version '${spec.version}', got '${sourceDep}'`,
    );
  }
  if (!pkg.devDependencies?.['@modelcontextprotocol/sdk']) {
    issues.push("devDependencies must include '@modelcontextprotocol/sdk'");
  }
  if (!pkg.peerDependencies?.['n8n-workflow']) {
    issues.push("peerDependencies must include 'n8n-workflow'");
  }

  if (issues.length === 0) return { name: 'package_json', passed: true };
  return {
    name: 'package_json',
    passed: false,
    error: gateError('package_json', {
      observation: `package.json structural lint failed: ${issues.join('; ')}.`,
      cause: 'The codegen produced a package.json that does not satisfy the n8n community-node contract or the pipeline pinning rules.',
      action: 'Update templates/n8n-adapter/package.json.hbs (or the spec builder) so each listed field matches the spec.',
      source_path: 'package.json',
    }),
  };
}

async function checkNodeClass(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const filePath = path.join(nodeDir, 'nodes', spec.className, `${spec.className}.node.ts`);
  let src: string;
  try {
    src = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      name: 'node_class',
      passed: false,
      error: gateError('node_class', {
        observation: `Node class file is missing at ${path.relative(nodeDir, filePath)}.`,
        cause: 'The codegen pass did not write the node class.',
        action: 'Re-run the n8n adapter generator and inspect for write failures.',
        source_path: path.relative(nodeDir, filePath),
      }),
    };
  }

  const issues: string[] = [];
  if (!src.includes(`export class ${spec.className} implements INodeType`)) {
    issues.push(`missing 'export class ${spec.className} implements INodeType'`);
  }
  if (!src.includes(`name: '${spec.paramName}'`)) {
    issues.push(`description.name must be '${spec.paramName}'`);
  }
  if (!src.includes(`credentials: [{ name: '${spec.credentialParamName}', required: true }]`)) {
    issues.push(`description.credentials must reference '${spec.credentialParamName}'`);
  }
  // Story 5.8: require the AI-Tool flag so n8n's CLI generates a virtual
  // tool sibling at startup. Without it the node is invisible to AI
  // Agent nodes — the very regression we want this lint to catch if the
  // template ever drifts.
  if (!src.includes('usableAsTool: true')) {
    issues.push('description must include `usableAsTool: true` (Story 5.8 — needed so n8n AI Agent can consume the node)');
  }
  // Every operation must appear in the dropdown AND in OPERATION_PROPERTY_NAMES.
  for (const op of spec.operations) {
    if (!src.includes(`value: '${op.name}'`)) {
      issues.push(`Operation dropdown is missing value '${op.name}'`);
    }
    if (!src.includes(`'${op.name}':`)) {
      issues.push(`OPERATION_PROPERTY_NAMES is missing entry for '${op.name}'`);
    }
  }

  if (issues.length === 0) return { name: 'node_class', passed: true };
  return {
    name: 'node_class',
    passed: false,
    error: gateError('node_class', {
      observation: `Node class structural lint failed: ${issues.join('; ')}.`,
      cause: 'The generated <ClassName>.node.ts does not match the spec it was built from — codegen template likely drifted.',
      action: 'Diff templates/n8n-adapter/node.ts.hbs against the spec contract; ensure every operation in spec.operations is emitted in both the Operation dropdown and the OPERATION_PROPERTY_NAMES table.',
      source_path: path.relative(nodeDir, filePath),
    }),
  };
}

async function checkCredentialsClass(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const filePath = path.join(nodeDir, 'credentials', `${spec.credentialClassName}.credentials.ts`);
  let src: string;
  try {
    src = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      name: 'credentials',
      passed: false,
      error: gateError('credentials', {
        observation: `Credentials class file is missing at ${path.relative(nodeDir, filePath)}.`,
        cause: 'The codegen pass did not write the credentials class.',
        action: 'Re-run the n8n adapter generator and inspect for write failures.',
        source_path: path.relative(nodeDir, filePath),
      }),
    };
  }

  const issues: string[] = [];
  if (!src.includes(`export class ${spec.credentialClassName} implements ICredentialType`)) {
    issues.push(`missing 'export class ${spec.credentialClassName} implements ICredentialType'`);
  }
  if (!src.includes(`name = '${spec.credentialParamName}'`)) {
    issues.push(`credential.name must be '${spec.credentialParamName}'`);
  }
  for (const cred of spec.credentials) {
    if (!src.includes(`name: '${cred.envName}'`)) {
      issues.push(`credential property is missing for env var '${cred.envName}'`);
    }
  }
  if (issues.length === 0) return { name: 'credentials', passed: true };
  return {
    name: 'credentials',
    passed: false,
    error: gateError('credentials', {
      observation: `Credentials class structural lint failed: ${issues.join('; ')}.`,
      cause: 'The generated credentials class is missing one or more env-var fields the source MCP requires.',
      action: 'Diff templates/n8n-adapter/credentials.ts.hbs against spec.credentials; every env var in server.json#packages[0].environmentVariables must produce a property entry.',
      source_path: path.relative(nodeDir, filePath),
    }),
  };
}

async function checkReadme(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const filePath = path.join(nodeDir, 'README.md');
  let src: string;
  try {
    src = await fs.readFile(filePath, 'utf8');
  } catch {
    return {
      name: 'readme',
      passed: false,
      error: gateError('readme', {
        observation: 'README.md is missing.',
        cause: 'The codegen pass did not write the README.',
        action: 'Re-run the n8n adapter generator.',
        source_path: 'README.md',
      }),
    };
  }
  const missing: string[] = [];
  for (const op of spec.operations) {
    if (!src.includes('`' + op.name + '`')) {
      missing.push(`operation '${op.name}'`);
    }
  }
  for (const cred of spec.credentials) {
    if (!src.includes('`' + cred.envName + '`')) {
      missing.push(`credential '${cred.envName}'`);
    }
  }
  if (missing.length === 0) return { name: 'readme', passed: true };
  return {
    name: 'readme',
    passed: false,
    error: gateError('readme', {
      observation: `README.md does not mention: ${missing.join(', ')}.`,
      cause: 'The README template was generated against a different spec than the node + credentials classes — a partial regeneration likely.',
      action: 'Re-run the n8n adapter generator with clean=true (the default) so README.md is overwritten alongside the other files.',
      source_path: 'README.md',
    }),
  };
}

export async function runTrackBLayer1(
  opts: RunTrackBLayer1Options,
): Promise<TrackBLayer1Result> {
  const checks: TrackBLayer1CheckResult[] = [];
  checks.push(await checkFileLayout(opts));
  checks.push(await checkPackageJson(opts));
  checks.push(await checkNodeClass(opts));
  checks.push(await checkCredentialsClass(opts));
  checks.push(await checkReadme(opts));

  const errors = checks.filter((c) => !c.passed).map((c) => c.error!);
  const passed = errors.length === 0;
  return {
    passed,
    mcpName: opts.mcpName,
    checks,
    errors,
    log: {
      event: passed ? 'gate.track_b_layer_1_passed' : 'gate.track_b_layer_1_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

// CLI entry: read the spec from `<repoRoot>/pending-to-publish/<mcp>/.n8n-adapter-spec.json`
// (the path the adapter codegen will eventually checkpoint to) plus the
// node dir. For v1 the CLI is mostly used by the workflow job.
async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const nodeDir = process.argv[3];
  const specPath = process.argv[4];
  if (!mcpName || !nodeDir || !specPath) {
    process.stderr.write('Usage: tsx src/gates/run-track-b-layer-1.ts <mcp-name> <node-dir> <spec-json>\n');
    return 2;
  }
  let spec: N8nNodeSpec;
  try {
    spec = await readJson<N8nNodeSpec>(specPath);
  } catch (err) {
    process.stderr.write(`Could not read spec at ${specPath}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = await runTrackBLayer1({
    mcpName,
    nodeDir,
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
