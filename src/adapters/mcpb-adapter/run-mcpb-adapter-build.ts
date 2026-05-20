import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildMcpbBundleSpec } from './build-mcpb-spec.js';
import { generateMcpbBundle } from './generate-mcpb-bundle.js';
import { loadDistributionConfig } from '../../distribution/load-distribution-config.js';

// Story 5.9d: orchestrator CLI invoked by the publish.yml
// `generate-mcpb-bundle` job (added in Story 5.12). Chains the three
// atomic adapter pieces:
//
//   1. buildMcpbBundleSpec — derive McpbBundleSpec from the source MCP's
//      tools/list + .distribution.yaml + server.json#environmentVariables.
//   2. generateMcpbBundle — render Handlebars templates + stage the
//      source MCP's dist/ into a pre-pack tree at <output>/.
//   3. `npm install --omit=dev` in <output>/server/ — populate
//      node_modules with prod-only deps so the bundle ships as a
//      self-contained, hermetic archive (the MCPB spec requires
//      bundled dependencies).
//   4. `npx @anthropic-ai/mcpb pack` — produce the .mcpb ZIP archive
//      that downstream gates (Story 5.10) validate and the publisher
//      (Story 5.11) uploads.
//
// Outputs into <output>:
//   <bundle layout files>                ← from generateMcpbBundle
//   .spec.json                            ← truth source for Layer 1 lint
//   server/node_modules/                  ← npm install --omit=dev
//   <mcp_name>-v<version>.mcpb            ← packed bundle, ready to publish
//   .mcpb-build.json                      ← summary for the release report
//
// CLI:
//   pnpm tsx src/adapters/mcpb-adapter/run-mcpb-adapter-build.ts \
//     <mcp_name> <version> <package_dir> <output_dir> [dry_run]

// Pinned mcpb CLI version. Keep this in lock-step with the manifest
// spec version (currently 0.3 → mcpb 2.1.x). Bumping is a deliberate
// change so a wire-format drift in a new mcpb release can't silently
// pass through CI.
const MCPB_CLI_PACKAGE = '@anthropic-ai/mcpb@^2.1.2';

interface McpbBuildSummary {
  mcp_name: string;
  version: string;
  smithery_namespace: string;
  source_mcp_package_name: string;
  output_dir: string;
  spec_path: string;
  bundle_path: string;
  operations: string[];
  user_config_keys: string[];
  dry_run: boolean;
}

interface RunMcpbAdapterBuildOptions {
  mcpName: string;
  version: string;
  packageDir: string;
  outputDir: string;
  dryRun: boolean;
  repoRoot?: string;
}

function runCmd(
  cmd: string,
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: typeof r.status === 'number' ? r.status : -1,
  };
}

export async function runMcpbAdapterBuild(
  opts: RunMcpbAdapterBuildOptions,
): Promise<McpbBuildSummary> {
  // Absolute paths upfront — `npm install --prefix` and `mcpb pack`
  // both behave unpredictably with relative paths when launched via
  // spawnSync from a different cwd. Same trap that bit run #26040942667
  // in the n8n adapter; pre-empting it here.
  const repoRoot = opts.repoRoot ?? process.cwd();
  const outputDir = path.resolve(opts.outputDir);
  const packageDir = path.resolve(opts.packageDir);

  // 1. Build spec from live tools/list.
  const { spec } = await buildMcpbBundleSpec({
    repoRoot,
    packageDir,
    mcpName: opts.mcpName,
    version: opts.version,
  });

  // 2. Render templates + stage source dist/ into <outputDir>/. We
  //    re-load .distribution.yaml here (the spec already encoded the
  //    decision to ship an icon via spec.iconPath; we just need the
  //    SOURCE side of the copy — the relative path inside the source
  //    MCP repo where the logo file actually lives).
  const distribution = await loadDistributionConfig(repoRoot, opts.mcpName);
  await generateMcpbBundle({
    spec,
    outputDir,
    sourceMcpDir: packageDir,
    ...(distribution.logo_path ? { sourceLogoRelPath: distribution.logo_path } : {}),
  });

  // Drop the spec next to the generated tree so Layer 1 (lint) has its
  // truth source without re-running buildMcpbBundleSpec.
  const specPath = path.join(outputDir, '.spec.json');
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + '\n');

  // 3. Populate server/node_modules with prod-only deps. The MCPB spec
  //    requires `server/node_modules/` to be present and complete —
  //    hosts unpack the bundle straight into a target dir and spawn
  //    node, so the lookup has to resolve from there.
  const serverDir = path.join(outputDir, 'server');
  const install = runCmd('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], serverDir);
  if (install.exitCode !== 0) {
    process.stderr.write(
      `[run-mcpb-adapter-build] npm install in ${serverDir} exited ${install.exitCode}\n--- stdout ---\n${install.stdout}\n--- stderr ---\n${install.stderr}\n--- end ---\n`,
    );
    throw new Error(
      `npm install --omit=dev failed in ${serverDir} (exit ${install.exitCode}). Source MCP's package.json may reference deps that aren't on the registry yet.`,
    );
  }

  // 4. Pack the staged tree into a .mcpb ZIP. The `mcpb pack` command
  //    expects `mcpb pack <input_dir> <output_file>` per the spec
  //    repo's CLI docs (anthropics/mcpb v2.1.x).
  const bundleFile = `${spec.name}-v${spec.version}.mcpb`;
  const bundlePath = path.join(outputDir, bundleFile);
  // `npx --yes` accepts the implicit install prompt; we pin the version
  // via MCPB_CLI_PACKAGE so the npx cache resolves deterministically.
  const pack = runCmd('npx', ['--yes', MCPB_CLI_PACKAGE, 'pack', outputDir, bundlePath], outputDir);
  if (pack.exitCode !== 0) {
    process.stderr.write(
      `[run-mcpb-adapter-build] mcpb pack exited ${pack.exitCode}\n--- stdout ---\n${pack.stdout}\n--- stderr ---\n${pack.stderr}\n--- end ---\n`,
    );
    throw new Error(
      `mcpb pack failed (exit ${pack.exitCode}). Inspect the manifest at ${path.join(outputDir, 'manifest.json')} and the staged server/ tree.`,
    );
  }

  const summary: McpbBuildSummary = {
    mcp_name: opts.mcpName,
    version: opts.version,
    smithery_namespace: spec.smitheryNamespace,
    source_mcp_package_name: spec.sourceMcpPackageName,
    output_dir: outputDir,
    spec_path: specPath,
    bundle_path: bundlePath,
    operations: spec.operations.map((o) => o.name),
    user_config_keys: spec.userConfig.map((u) => u.configKey),
    dry_run: opts.dryRun,
  };

  await fs.writeFile(
    path.join(outputDir, '.mcpb-build.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  return summary;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [mcpName, version, packageDir, outputDir, dryRunArg] = args;
  if (!mcpName || !version || !packageDir || !outputDir) {
    process.stderr.write(
      'Usage: tsx src/adapters/mcpb-adapter/run-mcpb-adapter-build.ts <mcp_name> <version> <package_dir> <output_dir> [dry_run]\n',
    );
    return 2;
  }
  const dryRun = dryRunArg === 'true' || dryRunArg === '1';
  try {
    const summary = await runMcpbAdapterBuild({ mcpName, version, packageDir, outputDir, dryRun });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`[run-mcpb-adapter-build] ${(err as Error).message}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
