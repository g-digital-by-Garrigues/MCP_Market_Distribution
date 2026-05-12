import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import type { InspectorResult } from '../../../src/gates/inspector-harness.js';

// We stub the inspector-harness so the npx-verification logic can be exercised
// without actually fetching @g-digital/mcp-ead-factory off npm.
const harnessMock = vi.fn<(opts: unknown) => Promise<InspectorResult>>();
vi.mock('../../../src/gates/inspector-harness.js', () => ({
  runInspectorHarness: (opts: unknown) => harnessMock(opts),
}));

const { runNpxVerification } = await import('../../../src/ci/verify-npx-install.js');

async function withRepoRoot(body: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'npx-verify-test-'));
  const config = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps: {
      'ead-factory': {
        reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
        npm_scope: '@g-digital',
        npm_package_name: '@g-digital/mcp-ead-factory',
        docker_image_name: 'gdigital/ead-factory',
        n8n_adapter_target_name: 'n8n-node-ead-factory',
        license: 'MIT',
        credential_help_url: 'https://example.com/onboarding',
        target_overrides: {},
        track_a_targets: 'default',
        track_b_targets: ['n8n'],
        logo_path: 'assets/logo.png',
      },
    },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(config));
  try {
    await body(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe('runNpxVerification', () => {
  beforeEach(() => {
    harnessMock.mockClear();
  });

  it('passes when the npx-spawned MCP responds to initialize + tools/list', async () => {
    await withRepoRoot(async (repoRoot) => {
      harnessMock.mockResolvedValueOnce({
        initialize_succeeded: true,
        tools_list: [{ name: 'echo', inputSchema: { type: 'object' } }],
        sample_call_results: [],
      });

      const result = await runNpxVerification({ repoRoot, mcpName: 'ead-factory', version: '1.0.0' });
      expect(result.passed).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.log.event).toBe('target.npx_install_path_passed');

      // The harness was invoked with `npx -y @g-digital/mcp-ead-factory@1.0.0`
      // and a SCRUBBED env (NFR-S3: no OKTA_*, no consumer creds).
      expect(harnessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'npx',
          args: ['-y', '@g-digital/mcp-ead-factory@1.0.0'],
          env: expect.not.objectContaining({ OKTA_CLIENT_SECRET: expect.anything() }),
        }),
      );
      const passedEnv = (harnessMock.mock.calls[0]?.[0] as { env: Record<string, string> }).env;
      // Only PATH and HOME should be in the spawned env.
      expect(Object.keys(passedEnv).sort()).toEqual(['HOME', 'PATH']);
    });
  });

  it('fails with target=npm + check=npx_install_path when npx cannot launch the package', async () => {
    await withRepoRoot(async (repoRoot) => {
      harnessMock.mockResolvedValueOnce({
        initialize_succeeded: false,
        tools_list: [],
        sample_call_results: [],
        launch_error: 'spawn npx ENOENT',
      });

      const result = await runNpxVerification({ repoRoot, mcpName: 'ead-factory', version: '1.0.0' });
      expect(result.passed).toBe(false);
      expect(result.errors).toHaveLength(1);
      const err = result.errors[0]!;
      expect(err.stage).toBe('publish');
      expect(err.target).toBe('npm');
      expect(err.check).toBe('npx_install_path');
      expect(err.observation).toContain('failed to launch');
      expect(err.action).toContain('bin');
    });
  });

  it('fails when initialize handshake fails post-launch', async () => {
    await withRepoRoot(async (repoRoot) => {
      harnessMock.mockResolvedValueOnce({
        initialize_succeeded: false,
        initialize_error: 'expected jsonrpc field, got plain text',
        tools_list: [],
        sample_call_results: [],
      });

      const result = await runNpxVerification({ repoRoot, mcpName: 'ead-factory', version: '1.0.0' });
      expect(result.passed).toBe(false);
      expect(result.errors[0]?.observation).toContain('initialize handshake failed');
      expect(result.errors[0]?.action).toContain('Layer 2 gate');
    });
  });

  it('fails with mcp-pipeline.yaml lookup error when the mcp_name is unknown', async () => {
    await withRepoRoot(async (repoRoot) => {
      const result = await runNpxVerification({ repoRoot, mcpName: 'nonexistent', version: '1.0.0' });
      expect(result.passed).toBe(false);
      expect(result.errors[0]?.observation).toContain('no entry');
      expect(harnessMock).not.toHaveBeenCalled();
    });
  });

  it('threads pipeline_run_id into the log event when provided', async () => {
    await withRepoRoot(async (repoRoot) => {
      harnessMock.mockResolvedValueOnce({
        initialize_succeeded: true,
        tools_list: [{ name: 'echo', inputSchema: {} }],
        sample_call_results: [],
      });
      const result = await runNpxVerification({
        repoRoot,
        mcpName: 'ead-factory',
        version: '1.0.0',
        pipelineRunId: 'run-42',
      });
      expect(result.log.pipeline_run_id).toBe('run-42');
    });
  });
});
