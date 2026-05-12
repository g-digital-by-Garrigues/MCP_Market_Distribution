import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { publishMcpRegistry } from '../../../src/publishers/publish-mcp-registry.js';
import type { ExecFn } from '../../../src/publishers/publish-mcp-registry.js';
import type { ExecFn as ProbeExecFn } from '../../../src/publishers/check-target-version.js';

interface FakeExec {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: readonly string[]; cwd?: string }>;
}

function fakeExec(responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>): FakeExec {
  const calls: FakeExec['calls'] = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args, options) => {
    calls.push({ cmd, args, ...(options.cwd ? { cwd: options.cwd } : {}) });
    const r = responses[i++];
    if (!r) throw new Error(`fakeExec exhausted at call #${i}`);
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { exec, calls };
}

function fakeProbe(responses: Array<{ stdout: string; stderr: string; exitCode: number }>): ProbeExecFn {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error('fakeProbe exhausted');
    return r;
  };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function withRepoRoot(
  body: (args: { repoRoot: string; packageDir: string }) => Promise<void>,
  withServerJson = true,
): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-mcp-test-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', 'ead-factory');
  await fs.mkdir(packageDir, { recursive: true });
  if (withServerJson) {
    await fs.writeFile(
      path.join(packageDir, 'server.json'),
      JSON.stringify({
        name: 'io.github.g-digital-by-Garrigues/ead-factory',
        description: 'EAD Factory MCP',
        version_detail: { version: '1.0.0' },
      }),
    );
  }
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
        track_b_targets: ['n8n', 'make-rom'],
        logo_path: 'assets/logo.png',
      },
    },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(config));
  try {
    await body({ repoRoot, packageDir });
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe('publishMcpRegistry', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: probe absent → login → dry-run → publish → status=succeeded with registry target_url', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([
        { stdout: `${JSON.stringify({ servers: [] })}\n200`, stderr: '', exitCode: 0 },
      ]);
      const { exec, calls } = fakeExec([
        { exitCode: 0, stdout: 'Logged in as github-oidc' },             // login
        { exitCode: 0, stdout: 'Dry-run OK; schema valid' },              // publish --dry-run
        { exitCode: 0, stdout: 'Published io.github.g-digital-by-Garrigues/ead-factory@1.0.0' }, // publish
      ]);

      const output = await publishMcpRegistry(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('succeeded');
      expect(output.target).toBe('mcp-publisher');
      expect(output.target_url).toBe(
        'https://registry.modelcontextprotocol.io/v0/servers/io.github.g-digital-by-Garrigues/ead-factory',
      );
      expect(output.version_published).toBe('1.0.0');
      expect(output.metadata?.reverse_dns_name).toBe('io.github.g-digital-by-Garrigues/ead-factory');

      // mcp-publisher invoked in the correct order with the correct args.
      const mcpCalls = calls.filter((c) => c.cmd === 'mcp-publisher');
      expect(mcpCalls.map((c) => c.args)).toEqual([
        ['login', 'github-oidc'],
        ['publish', '--dry-run'],
        ['publish'],
      ]);
      // All calls cwd into the package directory so server.json is found.
      expect(mcpCalls.every((c) => c.cwd === packageDir)).toBe(true);
    });
  });

  it('dry_run: true → runs login + publish --dry-run, but NOT the real publish', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([
        { stdout: `${JSON.stringify({ servers: [] })}\n200`, stderr: '', exitCode: 0 },
      ]);
      const { exec, calls } = fakeExec([
        { exitCode: 0 },
        { exitCode: 0 },
      ]);

      const output = await publishMcpRegistry(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: true,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('succeeded');
      expect(output.dry_run).toBe(true);
      expect(output.target_url).toContain('https://example.invalid/dry-run/mcp-publisher/');
      const mcpCalls = calls.filter((c) => c.cmd === 'mcp-publisher');
      expect(mcpCalls.map((c) => c.args)).toEqual([
        ['login', 'github-oidc'],
        ['publish', '--dry-run'],
      ]);
    });
  });

  it('idempotency hit: registry already has this exact version → status="skipped", no login/publish', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const body = JSON.stringify({
        servers: [
          {
            name: 'io.github.g-digital-by-Garrigues/ead-factory',
            version_detail: { version: '1.0.0' },
          },
        ],
      });
      const probeExec = fakeProbe([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
      const { exec, calls } = fakeExec([]);

      const output = await publishMcpRegistry(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('skipped');
      expect(calls).toEqual([]);
    });
  });

  it('missing server.json → status="failed" with prep-mcp remediation, no probe call', async () => {
    await withRepoRoot(
      async ({ repoRoot, packageDir }) => {
        const probeExec = fakeProbe([]);
        const { exec, calls } = fakeExec([]);

        const output = await publishMcpRegistry(
          {
            mcp_name: 'ead-factory',
            version: '1.0.0',
            pipeline_run_id: 'run-7',
            dry_run: false,
            package_dir: packageDir,
            repo_root: repoRoot,
          },
          { exec, probeExec, logger: silentLogger, env: {} },
        );

        expect(output.status).toBe('failed');
        expect(output.error?.message).toContain('server.json is missing');
        expect(output.error?.action).toContain('/prep-mcp');
        expect(calls).toEqual([]);
      },
      /* withServerJson= */ false,
    );
  });

  it('mcp-publisher login failure → status="failed" with id-token permission hint', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([
        { stdout: `${JSON.stringify({ servers: [] })}\n200`, stderr: '', exitCode: 0 },
      ]);
      const { exec } = fakeExec([
        { exitCode: 1, stderr: 'cannot mint OIDC token: request rejected' },
      ]);

      const output = await publishMcpRegistry(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('login github-oidc exited 1');
      expect(output.error?.action).toContain('id-token: write');
    });
  });

  it('publish --dry-run schema validation fails → status="failed" with server.json edit remediation', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([
        { stdout: `${JSON.stringify({ servers: [] })}\n200`, stderr: '', exitCode: 0 },
      ]);
      const { exec } = fakeExec([
        { exitCode: 0 },                                            // login
        { exitCode: 1, stderr: 'schema validation: name is missing' }, // dry-run preflight
      ]);

      const output = await publishMcpRegistry(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('publish --dry-run exited 1');
      expect(output.error?.cause).toContain('schema');
      expect(output.error?.action).toContain('server.json');
    });
  });

  it('publish failure due to package ownership → routes to mcpName remediation', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([
        { stdout: `${JSON.stringify({ servers: [] })}\n200`, stderr: '', exitCode: 0 },
      ]);
      const { exec } = fakeExec([
        { exitCode: 0 }, // login
        { exitCode: 0 }, // dry-run preflight
        { exitCode: 1, stderr: 'package-ownership verification failed: mcpName field missing in npm package' },
      ]);

      const output = await publishMcpRegistry(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.action).toContain('mcpName');
      expect(output.error?.action).toContain('package.json');
    });
  });
});
