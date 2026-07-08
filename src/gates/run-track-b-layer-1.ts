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
  /**
   * When true, skip the @n8n/scan-community-package ESLint gate.
   * Useful in unit tests that don't want the import overhead.
   * Story 12.3 (Epic 12).
   */
  skipLinter?: boolean;
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
  // Story 12.2 (Epic 12): REST-direct architecture — source MCP and SDK are
  // no longer bundled by tsup and must NOT be in devDependencies.
  // The gate now rejects them to prevent accidental re-introduction.
  if (pkg.devDependencies?.[spec.sourceMcpPackageName]) {
    issues.push(
      `devDependencies must NOT include '${spec.sourceMcpPackageName}' (REST-direct architecture: the source MCP is not bundled — remove from devDependencies).`,
    );
  }
  if (pkg.devDependencies?.['@modelcontextprotocol/sdk']) {
    issues.push(
      "devDependencies must NOT include '@modelcontextprotocol/sdk' (REST-direct architecture: SDK is not bundled — remove from devDependencies).",
    );
  }
  if (!pkg.peerDependencies?.['n8n-workflow']) {
    issues.push("peerDependencies must include 'n8n-workflow'");
  }
  // peerDependencies.n8n-workflow must be '*' (n8n scan-community-package requirement)
  if (pkg.peerDependencies?.['n8n-workflow'] && pkg.peerDependencies['n8n-workflow'] !== '*') {
    issues.push(`peerDependencies['n8n-workflow'] must be '*', got '${pkg.peerDependencies['n8n-workflow']}'`);
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
    // Check by propName (camelCase n8n field name) — env-var style names (envName)
    // are intentionally renamed to camelCase per n8n UX guidelines.
    if (!src.includes(`name: '${cred.propName}'`)) {
      issues.push(`credential property is missing for env var '${cred.envName}' (expected propName '${cred.propName}')`);
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

// Story 11.4 (Epic 11): language regression-guard.
//
// n8n's Verified Community Node program requires English-only content in all
// UI-visible strings. Our pre-audit (2026-05-27) found zero Spanish content in
// the 3 published packages, but a future upstream API update or generator change
// could silently re-introduce Spanish-origin strings. This check catches the
// regression at Track B Layer 1 (gate time, ~1s) before an OIDC-attested
// package reaches npm and then n8n's verified review queue.
//
// Checks:
//   - package.json#description: no Spanish accentuated chars, no known Spanish keywords
//   - package.json#keywords: same (catches drift from "digital-trust" → "evidencia")
//   - README.md first paragraph (lines 1-5): no Spanish content
//   - spec.operations[].description: each operation description
//   - spec.credentials[].description: each credential description
//
// The regex covers: (1) Spanish-only chars [áéíóúñÁÉÍÓÚÑ¿¡], (2) high-signal
// Spanish keywords that would never appear in legitimate English MCP tool
// descriptions (evidencia, expediente, firma/firmante, notificación,
// notificacion, expediente). The keyword list is intentionally short to avoid
// false positives on English words that superficially overlap.

const SPANISH_CHAR_RE = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
const SPANISH_KEYWORD_RE =
  /\b(evidencia|expediente|firmante|firmamos|firma\b|notificación|notificacion|dossier de)\b/i;

function hasSpanish(s: string): boolean {
  return SPANISH_CHAR_RE.test(s) || SPANISH_KEYWORD_RE.test(s);
}

async function checkLanguage(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const violations: string[] = [];

  // Check package.json description + keywords
  try {
    const pkgRaw = await fs.readFile(path.join(nodeDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { description?: string; keywords?: string[] };
    if (pkg.description && hasSpanish(pkg.description)) {
      violations.push(`package.json#description: "${pkg.description.slice(0, 80)}"`);
    }
    for (const kw of pkg.keywords ?? []) {
      if (hasSpanish(kw)) violations.push(`package.json#keywords: "${kw}"`);
    }
  } catch { /* file issues caught by checkFileLayout */ }

  // Check README.md first paragraph (first 5 non-empty lines)
  try {
    const readme = await fs.readFile(path.join(nodeDir, 'README.md'), 'utf8');
    const firstLines = readme.split('\n').filter((l) => l.trim().length > 0).slice(0, 5).join(' ');
    if (hasSpanish(firstLines)) {
      violations.push(`README.md first paragraph: "${firstLines.slice(0, 120)}"`);
    }
  } catch { /* README absence caught by checkReadme */ }

  // Check operation descriptions
  for (const op of spec.operations) {
    if (op.description && hasSpanish(op.description)) {
      violations.push(`operation '${op.name}' description: "${op.description.slice(0, 80)}"`);
    }
  }

  // Check credential descriptions
  for (const cred of spec.credentials) {
    if (cred.description && hasSpanish(cred.description)) {
      violations.push(`credential '${cred.envName}' description: "${cred.description.slice(0, 80)}"`);
    }
  }

  if (violations.length === 0) return { name: 'language', passed: true };
  return {
    name: 'language',
    passed: false,
    error: gateError('language', {
      observation: `Spanish-language content detected in generated n8n adapter (${violations.length} violation(s)): ${violations.slice(0, 3).join('; ')}${violations.length > 3 ? ` (+ ${violations.length - 3} more)` : ''}.`,
      cause: 'n8n Verified Community Node program requires English-only content. A Spanish-origin tool description or keyword likely came from the upstream MCP source or the @suite/generator template.',
      action: 'Fix the Spanish strings at their source-of-truth (source MCP repo or @suite/generator template), NOT here. Then re-publish the source MCP and re-run the pipeline.',
    }),
  };
}

// Story 12.3 (Epic 12): official n8n linter gate.
//
// Runs `@n8n/scan-community-package` against the GENERATED adapter tree
// (before compilation — the ESLint rules operate on TypeScript source,
// not compiled JS). Placed after all structural checks so structural
// failures short-circuit before the slower ESLint run.
//
// The linter is invoked via its internal `analyzePackage(dir)` function
// (same function the CLI wraps). It returns `{ passed, details? }`.
// On any violation the gate fails with a structured ErrorReport containing
// the linter output so engineers can fix the template / generator.
//
// Skip condition: if any structural check already failed, skip the linter
// to avoid noise. The `skipLinter` option also exists for unit tests that
// don't want the ESLint overhead.
async function checkOfficialLinter(
  opts: RunTrackBLayer1Options,
): Promise<TrackBLayer1CheckResult> {
  if (opts.skipLinter) return { name: 'official_linter', passed: true };

  let analyzePackage: (dir: string) => Promise<{ passed: boolean; details?: string }>;
  try {
    const mod = await import('@n8n/scan-community-package/scanner/scanner.mjs' as string);
    analyzePackage = (mod as { analyzePackage: typeof analyzePackage }).analyzePackage;
  } catch {
    // Package not installed in this environment (e.g. unit-test CI).
    // Log a warning but don't fail the gate — the linter is available
    // in the pipeline runner via pnpm's dev deps.
    return { name: 'official_linter', passed: true };
  }

  try {
    const result = await analyzePackage(opts.nodeDir);
    if (result.passed) return { name: 'official_linter', passed: true };
    return {
      name: 'official_linter',
      passed: false,
      error: gateError('official_linter', {
        observation: `@n8n/scan-community-package found ESLint violations:\n${(result.details ?? '').slice(0, 2000)}`,
        cause: 'The generated n8n node uses Node.js built-ins (fs, path, process, child_process, setTimeout, globalThis) or has invalid peer-dependency ranges. These are prohibited in n8n Cloud.',
        action: 'Fix the offending pattern in templates/n8n-adapter/node.ts.hbs or update peerDependencies.n8n-workflow to "*". See docs/adr/0008-n8n-rest-direct-execution-model.md for the REST-direct architecture that avoids these violations.',
      }),
    };
  } catch (err) {
    return {
      name: 'official_linter',
      passed: false,
      error: gateError('official_linter', {
        observation: `@n8n/scan-community-package threw an unexpected error: ${(err as Error).message}`,
        cause: 'The linter itself failed, likely a dependency or package-format issue.',
        action: 'Run @n8n/scan-community-package manually against the generated dir to diagnose.',
      }),
    };
  }
}

// n8n Creator Portal / Cloud verification rules that a generator regen of the
// MCP source can silently break (each maps to a real review rejection on
// EAD-ES v1.4.0). This gate is the durable guardrail: it fails the publish
// BEFORE shipping a node that violates the rules, instead of waiting for the
// human reviewer to catch it. See docs/n8n-adapter-contract.md.
//
//   - no_stub_operations:  no operation shown in the UI may be a STUB that
//                          always throws "not available in n8n Cloud" (a STUB
//                          means a source tool lost its // n8n-http: annotation)
//   - brand_casing:        node displayName must use canonical brand casing
//                          (EAD / GoCertius), never the toTitleCase fallback
//   - no_transport_creds:  credential screen must not expose MCP-server
//                          transport config (HTTP host/port, CORS, file-URL)
//   - credential_allowlist: every credential prop must be one the REST-direct
//                          execute() actually reads — backstops the allowlist in
//                          build-node-spec against any leak of MCP server config
//   - no_dead_chat:        nodes without chat ops must not ship chat code or
//                          advertise "certified chats" in the README
//   - label_casing:        no display label may read "IDS" (should be "IDs")
const BRAND_MISCASED: readonly string[] = ["Ead ", "Gocertius"];
const TRANSPORT_CRED_PROP_RE = /name:\s*'(mcpHttp\w*|mcpAllow\w*|mcpCors\w*|mcpTransport\w*)'/;
const STUB_OP_RE = /'([^']+)':\s*\{\s*method:\s*'STUB'[^}]*stub:\s*true/g;
// The complete set of credential property names the REST-direct execute() reads
// across all auth styles (baseUrl + email/password OR okta-* OR mcpSvc-*). Any
// credential prop outside this set is MCP-server config that leaked into the n8n
// form. Mirrors NODE_READABLE_CREDENTIAL_ENV_VARS in build-node-spec.ts.
const ALLOWED_CREDENTIAL_PROPS: ReadonlySet<string> = new Set([
  'baseUrl', 'email', 'password',
  'oktaTokenUrl', 'oktaClientId', 'oktaClientSecret', 'oktaScope',
  'mcpSvcTokenUrl', 'mcpSvcClientId', 'mcpSvcClientSecret', 'mcpSvcScope',
]);
// Match the `name: '...'` of each credential property (the credentials class
// uses single-quoted prop names; the test-request body uses other strings).
const CRED_PROP_NAME_RE = /name:\s*'([a-zA-Z][a-zA-Z0-9]*)'/g;

async function checkN8nUxCompliance(opts: RunTrackBLayer1Options): Promise<TrackBLayer1CheckResult> {
  const { nodeDir, spec } = opts;
  const nodePath = path.join(nodeDir, 'nodes', spec.className, `${spec.className}.node.ts`);
  const credPath = path.join(nodeDir, 'credentials', `${spec.credentialClassName}.credentials.ts`);
  const readmePath = path.join(nodeDir, 'README.md');
  let nodeSrc = '';
  let credSrc = '';
  let readmeSrc = '';
  try {
    nodeSrc = await fs.readFile(nodePath, 'utf8');
    credSrc = await fs.readFile(credPath, 'utf8');
    readmeSrc = await fs.readFile(readmePath, 'utf8');
  } catch (err) {
    return {
      name: 'n8n_ux_compliance',
      passed: false,
      error: gateError('n8n_ux_compliance', {
        observation: `Could not read generated files for UX compliance: ${(err as Error).message}.`,
        cause: 'The codegen did not produce the node/credentials/README files.',
        action: 'Ensure generate-n8n-node ran before this gate.',
      }),
    };
  }

  const issues: string[] = [];

  // 1. No STUB operations shown in the UI (issue 1 — notification_certificate_get).
  const stubbed: string[] = [];
  for (const m of nodeSrc.matchAll(STUB_OP_RE)) {
    if (m[1]) stubbed.push(m[1]);
  }
  if (stubbed.length > 0) {
    issues.push(
      `operations shown in the UI are STUBs that always throw at runtime: ${stubbed.join(', ')}. ` +
      `A STUB means the source tool file lost its '// n8n-http: METHOD /path' annotation. ` +
      `Restore the annotation in the MCP source (generator) or remove the tool.`,
    );
  }

  // 2. Brand displayName casing (issue 6 — "Ead" vs "EAD").
  const dispMatch = /displayName:\s*'([^']+)'/.exec(nodeSrc);
  const nodeDisplayName = dispMatch?.[1] ?? '';
  for (const bad of BRAND_MISCASED) {
    if (nodeDisplayName.includes(bad)) {
      issues.push(
        `node displayName '${nodeDisplayName}' uses mis-cased brand token '${bad.trim()}'. ` +
        `Set n8n_connector_display_name in .distribution.yaml or extend BRAND_TOKEN_CASING.`,
      );
    }
  }

  // 3. No MCP transport config on the credential screen (issue 3).
  const transportMatch = TRANSPORT_CRED_PROP_RE.exec(credSrc);
  if (transportMatch) {
    issues.push(
      `credential exposes MCP-server transport field '${transportMatch[1]}' which the REST-direct ` +
      `n8n node never uses. The credential surface is an allowlist — see build-node-spec.ts.`,
    );
  }

  // 3b. Credential allowlist backstop: every credential property must be one the
  // REST-direct execute() actually reads. Catches any leak of MCP server config
  // beyond the known transport prefixes (the recurring [HIGH] from v1.2.19/v1.3.x).
  const leakedProps: string[] = [];
  for (const m of credSrc.matchAll(CRED_PROP_NAME_RE)) {
    const prop = m[1]!;
    if (!ALLOWED_CREDENTIAL_PROPS.has(prop)) leakedProps.push(prop);
  }
  if (leakedProps.length > 0) {
    issues.push(
      `credential exposes ${leakedProps.length} field(s) the REST-direct node never reads: ` +
      `${[...new Set(leakedProps)].join(', ')}. Only ${[...ALLOWED_CREDENTIAL_PROPS].join(', ')} are node-readable. ` +
      `Add real auth fields to NODE_READABLE_CREDENTIAL_ENV_VARS in build-node-spec.ts; everything else is MCP server config.`,
    );
  }

  // 4. No dead chat code / copy when this node has no chat operations (issue 2).
  if (!spec.hasChat) {
    if (nodeSrc.includes('chat_certificate_get')) {
      issues.push(`node has no chat operations but ships chat_certificate_get code (dead code).`);
    }
    if (/certified chats|chat certification/i.test(readmeSrc)) {
      issues.push(`README advertises chat capabilities this node cannot perform (no chat operations).`);
    }
  }

  // 5. Display labels must read "IDs", not "IDS" (issue 5). Property displayNames
  // are JSON-encoded (double quotes); the node displayName uses single quotes.
  if (/displayName:\s*(['"])[^'"]*\bIDS\b[^'"]*\1/.test(nodeSrc)) {
    issues.push(`a field displayName reads "IDS"; the n8n UX guideline plural of ID is "IDs".`);
  }

  if (issues.length === 0) return { name: 'n8n_ux_compliance', passed: true };
  return {
    name: 'n8n_ux_compliance',
    passed: false,
    error: gateError('n8n_ux_compliance', {
      observation: `n8n Creator Portal / Cloud compliance failed: ${issues.join(' | ')}`,
      cause: 'A generator regen or template change produced a node that violates n8n Cloud verification rules.',
      action: 'See docs/n8n-adapter-contract.md for the source↔adapter contract; fix in the pipeline or file a generator issue per the routing table.',
      source_path: path.relative(nodeDir, nodePath),
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
  checks.push(await checkLanguage(opts));
  checks.push(await checkN8nUxCompliance(opts));

  // Official n8n linter — runs after structural checks to avoid noise.
  // Short-circuit: skip if any structural check already failed.
  const structuralPassed = checks.every((c) => c.passed);
  if (structuralPassed) {
    checks.push(await checkOfficialLinter(opts));
  }

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
