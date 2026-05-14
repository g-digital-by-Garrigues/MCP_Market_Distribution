import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { publishDockerHub } from '../../../src/publishers/publish-docker-hub.js';
import type { ExecFn } from '../../../src/publishers/publish-docker-hub.js';
import type { ExecFn as ProbeExecFn } from '../../../src/publishers/check-target-version.js';

interface FakeExec {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: readonly string[]; cwd?: string; stdin?: string }>;
}

function fakeExec(responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>): FakeExec {
  const calls: FakeExec['calls'] = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args, options) => {
    calls.push({ cmd, args, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.stdin ? { stdin: options.stdin } : {}) });
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
): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-docker-test-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', 'ead-factory');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM node:22-alpine\nCMD ["node","server.js"]\n');
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

describe('publishDockerHub', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: 404 probe → docker login → buildx push → status="succeeded" with digest in metadata', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([
        { stdout: '{"detail":"not found"}\n404', stderr: '', exitCode: 0 },
      ]);
      const { exec, calls } = fakeExec([
        { exitCode: 0, stdout: 'Login Succeeded\n' },                     // docker login
        { exitCode: 0, stdout: '1.0.0: digest: sha256:abcd1234efab size: 5678\n' }, // docker buildx push
      ]);

      const output = await publishDockerHub(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: { DOCKERHUB_USERNAME: 'gdigital-bot', DOCKERHUB_TOKEN: 'dckr_pat_xxxx' },
        },
      );

      expect(output.status).toBe('succeeded');
      expect(output.target).toBe('docker-hub');
      expect(output.target_url).toBe('https://hub.docker.com/r/gdigital/ead-factory');
      expect(output.version_published).toBe('1.0.0');
      expect(output.metadata?.digest).toBe('sha256:abcd1234efab');
      expect(output.metadata?.image_name).toBe('gdigital/ead-factory');
      expect(output.metadata?.tags).toEqual(['1.0.0', 'latest']);

      // Login used --password-stdin and passed the token through stdin.
      const loginCall = calls[0]!;
      expect(loginCall.args).toEqual(['login', '--username', 'gdigital-bot', '--password-stdin']);
      expect(loginCall.stdin).toBe('dckr_pat_xxxx');

      // Build pushed both tags + used registry cache.
      const buildCall = calls[1]!;
      expect(buildCall.args.includes('--push')).toBe(true);
      expect(buildCall.args.includes('--tag')).toBe(true);
      expect(buildCall.args).toContain('gdigital/ead-factory:1.0.0');
      expect(buildCall.args).toContain('gdigital/ead-factory:latest');
      expect(buildCall.args.find((a) => a.startsWith('type=registry,ref=gdigital/ead-factory:cache'))).toBeDefined();
    });
  });

  it('dry_run: true → builds the image but does NOT push, no docker login, target_url is placeholder', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([{ stdout: '{"detail":"not found"}\n404', stderr: '', exitCode: 0 }]);
      const { exec, calls } = fakeExec([{ exitCode: 0, stdout: 'cache-only build done' }]);

      const output = await publishDockerHub(
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
      expect(output.target_url).toContain('https://example.invalid/dry-run/docker-hub/');
      expect(calls.find((c) => c.args.includes('login'))).toBeUndefined();
      const build = calls.find((c) => c.args.includes('build'));
      expect(build?.args.includes('--push')).toBe(false);
      expect(build?.args).toContain('--output=type=cacheonly');
      // PERF: dry-run builds amd64 only (skips arm64 cross-compile via
      // QEMU). Multi-arch in dry-run takes ~5-10 min on a GH runner
      // without adding diagnostic value — Dockerfile correctness
      // doesn't normally differ by arch.
      const platformIdx = build?.args.findIndex((a) => a === '--platform') ?? -1;
      expect(platformIdx).toBeGreaterThanOrEqual(0);
      expect(build?.args[platformIdx + 1]).toBe('linux/amd64');
      // REGRESSION (dry-run #25855xxx): --cache-from / --cache-to MUST
      // be absent in dry-run. type=registry needs auth, and we skip
      // docker login in dry-run, so buildx would fail before the build
      // even starts.
      expect(build?.args.includes('--cache-from')).toBe(false);
      expect(build?.args.includes('--cache-to')).toBe(false);
    });
  });

  it('idempotency hit: probe returns present + matching version → status="skipped"', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const body = JSON.stringify({ results: [{ name: '1.0.0' }] });
      const probeExec = fakeProbe([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
      const { exec, calls } = fakeExec([]);

      const output = await publishDockerHub(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: { DOCKERHUB_USERNAME: 'x', DOCKERHUB_TOKEN: 'y' },
        },
      );

      expect(output.status).toBe('skipped');
      expect(calls).toEqual([]);
    });
  });

  it('missing DOCKERHUB credentials in non-dry-run → status="failed" before any docker call', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([{ stdout: '{"detail":"not found"}\n404', stderr: '', exitCode: 0 }]);
      const { exec, calls } = fakeExec([]);

      const output = await publishDockerHub(
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
      expect(output.error?.cause).toContain('cannot push without');
      expect(output.error?.action).toContain('Add DOCKERHUB_USERNAME');
      expect(calls).toEqual([]);
    });
  });

  it('mcp-pipeline.yaml missing the requested mcp_name → status="failed" with config-edit remediation', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([]);
      const { exec } = fakeExec([]);

      const output = await publishDockerHub(
        {
          mcp_name: 'nonexistent',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.action).toContain('mcp-pipeline.yaml');
    });
  });

  it('docker login fails → status="failed" with token-rotation remediation', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([{ stdout: '{"detail":"not found"}\n404', stderr: '', exitCode: 0 }]);
      const { exec } = fakeExec([
        { exitCode: 1, stderr: 'unauthorized: incorrect username or password' },
      ]);

      const output = await publishDockerHub(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: { DOCKERHUB_USERNAME: 'gdigital-bot', DOCKERHUB_TOKEN: 'bad-token' },
        },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('docker login failed');
      expect(output.error?.action).toContain('Rotate the token');
    });
  });

  it('buildx build fails → status="failed" with Dockerfile-edit remediation', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      const probeExec = fakeProbe([{ stdout: '{"detail":"not found"}\n404', stderr: '', exitCode: 0 }]);
      const { exec } = fakeExec([
        { exitCode: 0, stdout: 'Login Succeeded' },
        { exitCode: 1, stderr: 'failed to solve: lstat /missing: no such file' },
      ]);

      const output = await publishDockerHub(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-7',
          dry_run: false,
          package_dir: packageDir,
          repo_root: repoRoot,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: { DOCKERHUB_USERNAME: 'x', DOCKERHUB_TOKEN: 'y' },
        },
      );

      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('docker buildx build exited 1');
      expect(output.error?.action).toContain('Dockerfile');
    });
  });
});
