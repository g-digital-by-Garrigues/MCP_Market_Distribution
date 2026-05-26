import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Story 8.1: artifact version coherence gate.
//
// The pipeline clones the source MCP repo at the `v<version>` tag for
// real publishes. If the tag points at a commit where some artifacts
// were bumped (e.g. package.json) but others weren't (e.g. server.json
// — the exact bug that hit ead-enterprise-suite v1.1.0 in PR #21/#22),
// the publish runs against an internally-inconsistent snapshot and
// silently ships the wrong version to some stores.
//
// This validator reads every artifact that can carry a version
// reference and compares each to the pipeline's expected version.
// Any mismatch is a clear "your tag points at a coherent snapshot
// but the versions inside it don't match what you're publishing"
// error — surfaced at Track A Layer 1 (gate-time) so the pipeline
// can refuse to publish before any external state-mutating action.
//
// Defense layers:
//   - This module (Story 8.1): gate-time check, fails the build early.
//   - `publish-mcp-registry.ts` stale-clone detection (PR #139): post-hoc
//     check during the registry publish. Stays as redundant defense
//     because the gate-time check is preventive, not a substitute.

export interface VersionCheck {
  /** Relative path under packageDir, e.g. 'package.json' or 'install-blocks/cline.md'. */
  file: string;
  /** Human-readable path to the version field, e.g. 'package.json#version'. */
  pathToVersion: string;
  /** The version the pipeline expects to publish. */
  expected: string;
  /**
   * The version found in the file. null when the file doesn't exist
   * (soft-check pass) OR doesn't declare a version (also soft-check pass).
   */
  found: string | null;
  /** True iff `found` is non-null and equal to `expected`. */
  match: boolean;
  /**
   * 'mismatch' — file declares a different version than expected (HARD FAIL)
   * 'match' — file declares the expected version
   * 'absent' — file or version field doesn't exist (soft pass)
   */
  status: 'mismatch' | 'match' | 'absent';
}

export interface VersionCoherenceReport {
  packageDir: string;
  expectedVersion: string;
  checks: VersionCheck[];
  /** True iff any check has status='mismatch'. */
  hasMismatch: boolean;
  /** Convenience: list of files with a mismatch. */
  mismatchedFiles: string[];
}

export interface ValidateVersionCoherenceOptions {
  packageDir: string;
  expectedVersion: string;
}

/**
 * Check every artifact under `packageDir` that can declare a version
 * reference and compare each to `expectedVersion`. Returns a structured
 * report; the caller decides what to do with mismatches.
 *
 * Files inspected:
 *
 *   - `package.json#version` — npm package version (always present in a
 *     valid MCP source; if missing, we report absent and let the
 *     structural validator (validate-source-folder.ts) emit the missing-
 *     package.json error from its layer)
 *   - `server.json#version` — MCP Registry manifest version (the file
 *     that bit us on ead-enterprise-suite v1.1.0)
 *   - `smithery.yaml` — checked only if it declares an explicit version
 *     field (v1 of the generator doesn't, but this is forward-compat for
 *     future schema bumps)
 *   - `install-blocks/*.md` — checked only if they contain
 *     `<package_name>@<semver>` patterns (v1 install blocks don't pin
 *     versions, but operators may hand-edit; this catches drift)
 */
export async function validateVersionCoherence(
  opts: ValidateVersionCoherenceOptions,
): Promise<VersionCoherenceReport> {
  const { packageDir, expectedVersion } = opts;
  const checks: VersionCheck[] = [];

  // 1. package.json#version
  checks.push(
    classify('package.json', 'package.json#version', expectedVersion, await readPackageJsonVersion(packageDir)),
  );

  // 2. server.json#version
  checks.push(
    classify('server.json', 'server.json#version', expectedVersion, await readServerJsonVersion(packageDir)),
  );

  // 3. smithery.yaml — soft check (only fires if the YAML declares a top-level `version:` field)
  checks.push(
    classify('smithery.yaml', 'smithery.yaml#version', expectedVersion, await readSmitheryVersion(packageDir)),
  );

  // 4. install-blocks/*.md — one check per file with a version-pinned reference
  for (const ib of await readInstallBlockVersions(packageDir)) {
    checks.push(
      classify(ib.file, `${ib.file}#${ib.context}`, expectedVersion, ib.version),
    );
  }

  const mismatchedFiles = checks.filter((c) => c.status === 'mismatch').map((c) => c.file);
  return {
    packageDir,
    expectedVersion,
    checks,
    hasMismatch: mismatchedFiles.length > 0,
    mismatchedFiles,
  };
}

function classify(file: string, pathToVersion: string, expected: string, found: string | null): VersionCheck {
  if (found === null) {
    return { file, pathToVersion, expected, found: null, match: false, status: 'absent' };
  }
  const match = found === expected;
  return { file, pathToVersion, expected, found, match, status: match ? 'match' : 'mismatch' };
}

async function readPackageJsonVersion(packageDir: string): Promise<string | null> {
  return readJsonField(path.join(packageDir, 'package.json'), 'version');
}

async function readServerJsonVersion(packageDir: string): Promise<string | null> {
  return readJsonField(path.join(packageDir, 'server.json'), 'version');
}

async function readJsonField(filePath: string, field: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function readSmitheryVersion(packageDir: string): Promise<string | null> {
  // Plain regex scan rather than pulling in js-yaml — the validator should be
  // a fast, dependency-light gate. If the file declares `version: <semver>`
  // at the root level we catch it; nested version refs (e.g. inside
  // configSchema) are intentionally ignored.
  try {
    const raw = await fs.readFile(path.join(packageDir, 'smithery.yaml'), 'utf8');
    // Match a top-level (no leading whitespace) `version: <semver>` line.
    const match = raw.match(/^version:\s*['"]?(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)['"]?\s*$/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

interface InstallBlockVersion {
  file: string;
  context: string;
  version: string;
}

async function readInstallBlockVersions(packageDir: string): Promise<InstallBlockVersion[]> {
  const dir = path.join(packageDir, 'install-blocks');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const results: InstallBlockVersion[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    let body: string;
    try {
      body = await fs.readFile(path.join(dir, entry), 'utf8');
    } catch {
      continue;
    }
    // Match `<scope>/<name>@<semver>` patterns. We don't care about the
    // package name itself for this check — any pinned reference must
    // match the expected version. Skips lone package names (no @version).
    const re = /@?[a-z0-9_-]+\/[a-z0-9_-]+@(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)/gi;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const v = m[1];
      if (v === undefined || seen.has(v)) continue;
      seen.add(v);
      results.push({
        file: `install-blocks/${entry}`,
        context: `pinned-package-ref(${v})`,
        version: v,
      });
    }
  }
  return results;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const packageDir = args[0];
  const expectedVersion = args[1];
  if (!packageDir || !expectedVersion) {
    process.stderr.write(
      'Usage: tsx src/validators/validate-version-coherence.ts <package-dir> <expected-version>\n',
    );
    return 2;
  }
  const report = await validateVersionCoherence({ packageDir, expectedVersion });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.hasMismatch ? 1 : 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  void main().then((code) => {
    process.exit(code);
  });
}
