import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishDockerHub } from '../../../src/publishers/publish-docker-hub.js';
import type { ExecFn } from '../../../src/publishers/publish-docker-hub.js';
import type { ExecFn as ProbeExecFn } from '../../../src/publishers/check-target-version.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

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

const pipelineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * What the rendered overview is built from: the server's own contract in the
 * package dir, plus the real template, copied into the temp repo root because
 * the publisher resolves templates from `repo_root` (as every other publisher
 * does). Using the real template means a change to it is exercised here.
 */
async function writeOverviewSources(repoRoot: string, packageDir: string): Promise<void> {
  await fs.writeFile(
    path.join(packageDir, '.env.example'),
    '# description: Long-lived user key.\n# isSecret: true\n# isRequired: true\nMCP_AUTH_USER_KEY=\n',
  );
  await fs.writeFile(
    path.join(packageDir, 'server.json'),
    JSON.stringify({ description: 'Test MCP server.' }),
  );
  await fs.mkdir(path.join(packageDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(packageDir, 'assets', 'logo-400x400.png'), 'not-really-a-png');
  const templates = path.join(repoRoot, 'templates', 'store-descriptions');
  await fs.mkdir(templates, { recursive: true });
  await fs.copyFile(
    path.join(pipelineRoot, 'templates', 'store-descriptions', 'docker-hub-overview.hbs'),
    path.join(templates, 'docker-hub-overview.hbs'),
  );
}

async function withRepoRoot(
  body: (args: { repoRoot: string; packageDir: string }) => Promise<void>,
): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-docker-test-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', 'ead-factory');
  await writeTestConfig({ repoRoot });
  await fs.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM node:22-alpine\nCMD ["node","server.js"]\n');
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

  // ── Docker Hub repository metadata ────────────────────────────────────────
  //
  // Added 2026-09-08, after both product pages were found serving v1.5.0
  // documentation. The publisher posted the whole README as `full_description`;
  // Docker Hub caps that at 25,000 characters and answered 400; the publisher
  // logged a warning and reported `succeeded`. Nothing here was under test, so
  // nothing failed. Every case below is one of the links in that chain.

  function stubDockerHubFetch(descriptionStatus: number): { urls: string[]; bodies: string[] } {
    const urls: string[] = [];
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: unknown }) => {
      urls.push(String(url));
      if (String(url).includes('/users/login/')) {
        return { ok: true, status: 200, json: async () => ({ token: 'jwt' }) };
      }
      if (init?.method === 'PATCH' && String(url).endsWith('/') && !String(url).includes('/icon/')) {
        if (typeof init.body === 'string') bodies.push(init.body);
        return { ok: descriptionStatus < 400, status: descriptionStatus };
      }
      // Categories (405) and the icon (404) are broken upstream today; they must
      // stay advisory or every publish would go red on presentation metadata.
      return { ok: false, status: String(url).includes('categories') ? 405 : 404 };
    });
    return { urls, bodies };
  }

  it('refreshes the repository page even when the image tag is already published', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      await writeOverviewSources(repoRoot, packageDir);
      const { bodies } = stubDockerHubFetch(200);
      const body = JSON.stringify({ results: [{ name: '1.0.0' }] });
      const probeExec = fakeProbe([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
      const { exec, calls } = fakeExec([]);

      const output = await publishDockerHub(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'run-8', dry_run: false, package_dir: packageDir, repo_root: repoRoot },
        { exec, probeExec, logger: silentLogger, env: { DOCKERHUB_USERNAME: 'x', DOCKERHUB_TOKEN: 'y' } },
      );

      // Still skipped — the image is genuinely already there, and we must not
      // rebuild it — but the page was refreshed on the way past. Without this,
      // a stale page can only be repaired by inventing a new version.
      expect(output.status).toBe('skipped');
      expect(calls).toEqual([]);
      expect((output.metadata as { metadata_refresh?: { description?: string } }).metadata_refresh?.description).toBe('updated');
      expect(bodies).toHaveLength(1);
      const sent = JSON.parse(bodies[0]!) as { full_description: string };
      expect(sent.full_description).toContain('MCP_AUTH_USER_KEY');
      expect(sent.full_description.length).toBeLessThan(25_000);
    });
  });

  it('a rejected description fails the target instead of reporting success', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      await writeOverviewSources(repoRoot, packageDir);
      stubDockerHubFetch(400);
      const body = JSON.stringify({ results: [{ name: '1.0.0' }] });
      const probeExec = fakeProbe([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
      const { exec } = fakeExec([]);

      const output = await publishDockerHub(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'run-9', dry_run: false, package_dir: packageDir, repo_root: repoRoot },
        { exec, probeExec, logger: silentLogger, env: { DOCKERHUB_USERNAME: 'x', DOCKERHUB_TOKEN: 'y' } },
      );

      // The exact combination that hid the outage: HTTP 400 on the description,
      // everything else fine. It is now a failed target with the reason in it.
      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('400');
      expect(output.error?.action).toContain('/retry-publish?step=docker-hub');
    });
  });

  it('categories and icon failures stay advisory and are reported, not fatal', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      await writeOverviewSources(repoRoot, packageDir);
      stubDockerHubFetch(200);
      const body = JSON.stringify({ results: [{ name: '1.0.0' }] });
      const probeExec = fakeProbe([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
      const { exec } = fakeExec([]);

      const output = await publishDockerHub(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'run-10', dry_run: false, package_dir: packageDir, repo_root: repoRoot },
        { exec, probeExec, logger: silentLogger, env: { DOCKERHUB_USERNAME: 'x', DOCKERHUB_TOKEN: 'y' } },
      );

      expect(output.status).toBe('skipped');
      const refresh = (output.metadata as { metadata_refresh: { categories: string; logo: string } }).metadata_refresh;
      expect(refresh.categories).toBe('failed');
      expect(refresh.logo).toBe('failed');
    });
  });

  it('does not touch Docker Hub metadata on a dry run', async () => {
    await withRepoRoot(async ({ repoRoot, packageDir }) => {
      await writeOverviewSources(repoRoot, packageDir);
      const { urls } = stubDockerHubFetch(200);
      const body = JSON.stringify({ results: [{ name: '1.0.0' }] });
      const probeExec = fakeProbe([{ stdout: `${body}\n200`, stderr: '', exitCode: 0 }]);
      const { exec } = fakeExec([]);

      await publishDockerHub(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'run-11', dry_run: true, package_dir: packageDir, repo_root: repoRoot },
        { exec, probeExec, logger: silentLogger, env: { DOCKERHUB_USERNAME: 'x', DOCKERHUB_TOKEN: 'y' } },
      );

      expect(urls).toEqual([]);
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

  it('.distribution.yaml missing for the requested mcp_name → status="failed" with config-edit remediation', async () => {
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
      expect(output.error?.action).toContain('.distribution.yaml');
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
