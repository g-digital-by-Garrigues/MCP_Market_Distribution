import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildN8nNodeSpec } from './build-node-spec.js';
import { refineWithLlm } from './refine-with-llm.js';
import { generateN8nNode, copyN8nNodeSource } from './generate-n8n-node.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';

// Story 5.6b: orchestrator CLI that the publish.yml `generate-n8n-adapter`
// job invokes. Chains the 4 atomic adapter pieces (build spec → refine →
// generate node tree → optionally dry-run-substitute the source-MCP dep
// to a local file: path so downstream gates + publish work without the
// source MCP being live on npmjs yet) and emits:
//
//   <output-dir>/<adapter tree files>
//   <output-dir>/.spec.json  — the N8nNodeSpec that drove this build,
//                              consumed by track-b-layer-1 (lint)
//   <output-dir>/.adapter-build.json — high-level summary the workflow
//                                      can pipe into the release report
//
// CLI:
//   pnpm tsx src/adapters/n8n-adapter/run-adapter-build.ts \
//     <mcp_name> <version> <package_dir> <output_dir> <dry_run>

interface AdapterBuildSummary {
  mcp_name: string;
  version: string;
  package_name: string;
  source_mcp_package_name: string;
  output_dir: string;
  spec_path: string;
  operations: string[];
  credentials: string[];
  unsupported_notes: string[];
  refine: {
    applied: boolean;
    change_count: number;
    warning?: string;
  };
  dry_run: boolean;
  source_substituted: boolean;
  /** Set when dry_run=true AND substitution couldn't fire; explains why. */
  substitution_warning?: string;
}

// In dry-run mode the source MCP hasn't been published to npmjs yet
// (publish-npm runs in dry_run too), so the generated adapter's
// `dependencies['<source>': '<version>']` would fail at install. We
// rewrite that one dep to a relative file: URL pointing at the
// source-MCP dir packaged as a .tgz via `npm pack`. Layer 2 + Layer 3
// + publish-n8n then install + build + publish against the local
// tarball — same TS validation, no registry round-trip.
async function substituteSourceMcpForDryRun(opts: {
  outputDir: string;
  packageDir: string;
  sourceMcpPackageName: string;
}): Promise<{ substituted: boolean; tarballPath?: string; warning?: string }> {
  const { outputDir, packageDir, sourceMcpPackageName } = opts;
  const adapterPkgPath = path.join(outputDir, 'package.json');
  const pkgRaw = await fs.readFile(adapterPkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  // Approach B: source MCP dep lives in devDependencies (bundled by tsup).
  // Fall back to dependencies for forward-compat with any legacy layout.
  const depField: 'dependencies' | 'devDependencies' | null =
    pkg.devDependencies?.[sourceMcpPackageName] != null
      ? 'devDependencies'
      : pkg.dependencies?.[sourceMcpPackageName] != null
        ? 'dependencies'
        : null;
  if (!depField) {
    return {
      substituted: false,
      warning: `adapter package.json has no dependency on '${sourceMcpPackageName}' in dependencies or devDependencies — nothing to substitute.`,
    };
  }

  // npm pack the source MCP into the adapter dir, then rewrite the dep.
  // outputDir + packageDir MUST be absolute (the caller resolves them);
  // npm interprets --pack-destination relative to the subprocess cwd
  // (= packageDir), so passing a relative outputDir would write the
  // tarball under <packageDir>/<outputDir> — the exact bug that caused
  // run #26040942667 to fall back silently to the registry version.
  const { spawnSync } = await import('node:child_process');
  const packResult = spawnSync('npm', ['pack', '--pack-destination', outputDir], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  if (packResult.status !== 0) {
    const warning = `npm pack in ${packageDir} exited ${packResult.status}: ${(packResult.stderr ?? '').slice(0, 400)}`;
    process.stderr.write(`[run-adapter-build] dry_run substitution failed: ${warning}\n`);
    return { substituted: false, warning };
  }

  // `npm pack` prints the produced .tgz filename on its last stdout line.
  const tarballName = packResult.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (!tarballName.endsWith('.tgz')) {
    const warning = `could not parse tarball name from npm pack stdout: ${packResult.stdout.slice(-200)}`;
    process.stderr.write(`[run-adapter-build] dry_run substitution: ${warning}\n`);
    return { substituted: false, warning };
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  pkg[depField]![sourceMcpPackageName] = `file:./${tarballName}`;
  await fs.writeFile(adapterPkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return { substituted: true, tarballPath: path.join(outputDir, tarballName) };
}

interface RunAdapterBuildOptions {
  mcpName: string;
  version: string;
  packageDir: string;
  outputDir: string;
  dryRun: boolean;
  repoRoot?: string;
}

export async function runAdapterBuild(opts: RunAdapterBuildOptions): Promise<AdapterBuildSummary> {
  // Resolve to absolute paths upfront. The substitution step delegates
  // to `npm pack --pack-destination <outputDir>` from a subprocess whose
  // cwd is `packageDir`; npm interprets `--pack-destination` relative to
  // ITS cwd, not ours, so a relative outputDir would resolve to
  // <packageDir>/<outputDir> — almost never the intended target.
  // Caught in dry-run #26040942667 where the substitution silently
  // returned `substituted: false` and Layer 2 then tried to install
  // the registry version `1.0.5` (which doesn't exist yet).
  const repoRoot = opts.repoRoot ?? process.cwd();
  const outputDir = path.resolve(opts.outputDir);
  const packageDir = path.resolve(opts.packageDir);

  // 1. Build spec from live tools/list.
  const { spec, unsupportedNotes } = await buildN8nNodeSpec({
    repoRoot,
    packageDir,
    mcpName: opts.mcpName,
    version: opts.version,
  });

  // 2. Optional LLM refine — silent no-op when ANTHROPIC_API_KEY isn't set.
  const refinement = await refineWithLlm({ spec });

  // 3. Render the n8n node tree (with source logo when shipped).
  //    Re-loading .distribution.yaml is cheap; the spec only carries a
  //    boolean flag (iconBundled), the absolute logo path lives on the
  //    source-side filesystem and stays out of the spec to keep it
  //    IO-pure for unit tests.
  let sourceLogoAbsPath: string | undefined;
  if (refinement.spec.iconBundled) {
    const distribution = await loadDistributionConfig(repoRoot, opts.mcpName);
    if (distribution.logo_path) {
      sourceLogoAbsPath = path.resolve(packageDir, distribution.logo_path);
    }
  }
  await generateN8nNode({
    spec: refinement.spec,
    outputDir,
    ...(sourceLogoAbsPath ? { sourceLogoAbsPath } : {}),
  });

  // Copy the generated TypeScript source into <packageDir>/n8n-node/ so the
  // source MCP repository contains the exact .ts that produced the published
  // npm package. This satisfies the n8n Creator Portal source-verifiability
  // requirement (package.json#repository.directory = "n8n-node").
  await copyN8nNodeSource(outputDir, packageDir);

  // Drop the spec next to the generated tree so Layer 1 (lint) has its
  // truth source without re-running buildN8nNodeSpec.
  const specPath = path.join(outputDir, '.spec.json');
  await fs.writeFile(specPath, JSON.stringify(refinement.spec, null, 2) + '\n');

  // 4. Dry-run dep substitution so Layer 2/3/publisher don't require the
  //    source MCP to already be on the npm registry.
  let sourceSubstituted = false;
  let substitutionWarning: string | undefined;
  if (opts.dryRun) {
    const r = await substituteSourceMcpForDryRun({
      outputDir,
      packageDir,
      sourceMcpPackageName: refinement.spec.sourceMcpPackageName,
    });
    sourceSubstituted = r.substituted;
    if (!r.substituted) {
      substitutionWarning = r.warning ?? 'unknown reason';
    }
  }

  const summary: AdapterBuildSummary = {
    mcp_name: opts.mcpName,
    version: opts.version,
    package_name: refinement.spec.packageName,
    source_mcp_package_name: refinement.spec.sourceMcpPackageName,
    output_dir: outputDir,
    spec_path: specPath,
    operations: refinement.spec.operations.map((o) => o.name),
    credentials: refinement.spec.credentials.map((c) => c.envName),
    unsupported_notes: unsupportedNotes,
    refine: {
      applied: refinement.applied,
      change_count: refinement.changes.length,
      ...(refinement.warning ? { warning: refinement.warning } : {}),
    },
    dry_run: opts.dryRun,
    source_substituted: sourceSubstituted,
    ...(substitutionWarning ? { substitution_warning: substitutionWarning } : {}),
  };

  await fs.writeFile(
    path.join(opts.outputDir, '.adapter-build.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  return summary;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [mcpName, version, packageDir, outputDir, dryRunArg] = args;
  if (!mcpName || !version || !packageDir || !outputDir) {
    process.stderr.write(
      'Usage: tsx src/adapters/n8n-adapter/run-adapter-build.ts <mcp_name> <version> <package_dir> <output_dir> [dry_run]\n',
    );
    return 2;
  }
  const dryRun = dryRunArg === 'true' || dryRunArg === '1';
  try {
    const summary = await runAdapterBuild({ mcpName, version, packageDir, outputDir, dryRun });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`[run-adapter-build] ${(err as Error).message}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
