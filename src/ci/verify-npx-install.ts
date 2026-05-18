import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runInspectorHarness } from '../gates/inspector-harness.js';
import {
  loadDistributionConfig,
  DistributionConfigError,
} from '../distribution/load-distribution-config.js';
import type { ErrorReport } from '../schemas/error-report.schema.js';

// Story 3.8: post-publication npx install-path verification.
//
// Spawn `npx -y <npm_package_name>@<version>` as a fresh process — no local
// node_modules, no source code — and run the same MCP Inspector handshake
// the Layer 2 gate uses (initialize + tools/list). If either step fails,
// emit a structured ErrorReport with target='npm' and check='npx_install_path'.
//
// This is the FR47 verification ("npx install without .env file") promoted
// from a one-time launch test to a per-release gate, so a future package
// rename / dist regression / missing dependency surfaces immediately
// instead of in a consumer's first run.

const NPX_TIMEOUT_MS = 60_000;

export interface VerifyNpxResult {
  passed: boolean;
  errors: ErrorReport[];
  log: {
    event: 'target.npx_install_path_passed' | 'target.npx_install_path_failed';
    pipeline_run_id?: string;
  };
}

function publishError(check: string, fields: Omit<ErrorReport, 'stage' | 'layer' | 'target' | 'check'>): ErrorReport {
  return { stage: 'publish', layer: null, target: 'npm', check, ...fields };
}

export interface RunNpxVerificationOptions {
  repoRoot: string;
  mcpName: string;
  version: string;
  pipelineRunId?: string;
}

export async function runNpxVerification(
  opts: RunNpxVerificationOptions,
): Promise<VerifyNpxResult> {
  let distribution;
  try {
    distribution = await loadDistributionConfig(opts.repoRoot, opts.mcpName);
  } catch (err) {
    const msg = err instanceof DistributionConfigError ? err.message : (err as Error).message;
    return {
      passed: false,
      errors: [
        publishError('npx_install_path', {
          observation: msg,
          cause: 'Cannot determine the npm package name to verify (missing/invalid .distribution.yaml).',
          action: `Ensure the MCP repo has a valid .distribution.yaml with npm_package_name set.`,
        }),
      ],
      log: { event: 'target.npx_install_path_failed', ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}) },
    };
  }

  const pkg = `${distribution.npm_package_name}@${opts.version}`;

  const harness = await runInspectorHarness({
    command: 'npx',
    args: ['-y', pkg],
    // NFR-S3: explicitly blank the env so no inherited OKTA_*, EAD*,
    // etc. consumer credentials can leak into the spawned MCP process.
    // We still pass through PATH (so npx itself can find node) and a
    // minimal HOME so npx can write its cache.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
    },
    timeoutMs: NPX_TIMEOUT_MS,
  });

  const errors: ErrorReport[] = [];

  if (harness.launch_error) {
    errors.push(
      publishError('npx_install_path', {
        observation: `npx -y ${pkg} failed to launch: ${harness.launch_error}`,
        cause: 'The published package could not be downloaded or executed via npx.',
        action: `Verify the package's "bin" entry in pending-to-publish/${opts.mcpName}/package.json points at a node-executable file and that the file is included via package.json#files.`,
      }),
    );
  } else {
    if (!harness.initialize_succeeded) {
      errors.push(
        publishError('npx_install_path', {
          observation: `initialize handshake failed via npx: ${harness.initialize_error ?? 'unknown'}`,
          cause: 'The npx-installed MCP started but did not implement the MCP initialize handshake correctly.',
          action: `Re-run the Layer 2 gate locally against pending-to-publish/${opts.mcpName}/ — if it passes there but fails via npx, the dist/ output is missing or the bin entry points wrong.`,
        }),
      );
    }
    if (harness.tools_list_error !== undefined) {
      errors.push(
        publishError('npx_install_path', {
          observation: `tools/list via npx failed: ${harness.tools_list_error}`,
          cause: 'MCP started but does not expose tools/list correctly.',
          action: `Inspect the published tarball with npm pack and confirm the dist/ output is present.`,
        }),
      );
    }
  }

  const passed = errors.length === 0;
  return {
    passed,
    errors,
    log: {
      event: passed ? 'target.npx_install_path_passed' : 'target.npx_install_path_failed',
      ...(opts.pipelineRunId ? { pipeline_run_id: opts.pipelineRunId } : {}),
    },
  };
}

async function main(): Promise<number> {
  const mcpName = process.argv[2];
  const version = process.argv[3];
  if (!mcpName || !version) {
    process.stderr.write('Usage: verify-npx-install.ts <mcp_name> <version>\n');
    return 2;
  }
  const result = await runNpxVerification({
    repoRoot: process.cwd(),
    mcpName,
    version,
    ...(process.env.PIPELINE_RUN_ID ? { pipelineRunId: process.env.PIPELINE_RUN_ID } : {}),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result.passed ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
