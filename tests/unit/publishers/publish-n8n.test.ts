import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishN8n } from '../../../src/publishers/publish-n8n.js';
import type { ExecFn } from '../../../src/publishers/publish-n8n.js';
import type { ExecFn as ProbeExecFn } from '../../../src/publishers/check-target-version.js';

interface FakeExec {
  exec: ExecFn;
  calls: Array<{ cmd: string; args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
}

function fakeExec(responses: Array<{ exitCode: number; stdout?: string; stderr?: string }>): FakeExec {
  const calls: FakeExec['calls'] = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options.cwd, env: options.env });
    const r = responses[i++];
    if (!r) throw new Error(`fakeExec ran out of responses at call #${i}`);
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

async function withGeneratedAdapterDir(
  body: (packageDir: string) => Promise<void>,
  pkg: Record<string, unknown> = {
    name: '@g-digital/n8n-node-ead-factory',
    version: '1.0.0',
    scripts: { build: 'tsc' },
  },
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'publish-n8n-test-'));
  try {
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify(pkg, null, 2));
    await body(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('publishN8n', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path with NPM_TOKEN: probe-absent → install → build → publish → status=succeeded, target=n8n', async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([
        { stdout: '', stderr: 'npm ERR! 404 Not Found', exitCode: 1 },
      ]);
      const { exec, calls } = fakeExec([
        { exitCode: 0, stdout: 'added 35 packages\n' },       // npm install
        { exitCode: 0, stdout: '> tsc\n' },                    // npm run build
        { exitCode: 0, stdout: '+ @g-digital/n8n-node-ead-factory@1.0.0' }, // npm publish
      ]);
      const writeNpmrc = vi.fn(async (_p: string, _c: string): Promise<void> => {});
      const removeNpmrc = vi.fn(async (_p: string): Promise<void> => {});

      const output = await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: false,
          package_dir: packageDir,
        },
        {
          exec,
          probeExec,
          logger: silentLogger,
          env: { NPM_TOKEN: 'npm_abc123' },
          writeNpmrc,
          removeNpmrc,
        },
      );

      expect(output.status).toBe('succeeded');
      expect(output.target).toBe('n8n');
      expect(output.target_url).toBe(
        'https://www.npmjs.com/package/@g-digital/n8n-node-ead-factory/v/1.0.0',
      );
      expect(output.version_published).toBe('1.0.0');
      expect(output.metadata?.auth_mode).toBe('npm_token');
      expect(output.metadata?.package_name).toBe('@g-digital/n8n-node-ead-factory');

      // Call order: install → build → publish.
      expect(calls.map((c) => c.args.join(' '))).toEqual([
        'install --no-audit --no-fund',
        'run build',
        'publish --access public',
      ]);
      // .npmrc was written + cleaned up.
      expect(writeNpmrc).toHaveBeenCalledOnce();
      expect(removeNpmrc).toHaveBeenCalledOnce();
    });
  });

  it("dry_run=true → adds --dry-run to npm publish + url is placeholder", async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const { exec, calls } = fakeExec([
        { exitCode: 0 }, // install
        { exitCode: 0 }, // build
        { exitCode: 0, stdout: '+ @g-digital/n8n-node-ead-factory@1.0.0' }, // publish --dry-run
      ]);
      const output = await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: true,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'tok' } },
      );
      expect(output.status).toBe('succeeded');
      expect(output.dry_run).toBe(true);
      expect(output.target_url).toContain('dry-run/n8n/');
      const publishCall = calls.find((c) => c.args[0] === 'publish');
      expect(publishCall!.args).toContain('--dry-run');
    });
  });

  it('idempotency hit: probe returns the same version → status=skipped, no install/build/publish', async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([
        { stdout: '"1.0.0"', stderr: '', exitCode: 0 },
      ]);
      const { exec, calls } = fakeExec([]);
      const output = await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'tok' } },
      );
      expect(output.status).toBe('skipped');
      expect(calls).toEqual([]);
    });
  });

  it('version mismatch between package.json and input → status=failed before probe', async () => {
    await withGeneratedAdapterDir(
      async (packageDir) => {
        const probeExec = fakeProbe([]);
        const { exec, calls } = fakeExec([]);
        const output = await publishN8n(
          {
            mcp_name: 'ead-factory',
            version: '1.0.0',
            pipeline_run_id: 'run-9',
            dry_run: false,
            package_dir: packageDir,
          },
          { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'tok' } },
        );
        expect(output.status).toBe('failed');
        expect(output.error?.message).toContain('package.json version (0.0.9)');
        expect(calls).toEqual([]);
      },
      { name: '@g-digital/n8n-node-ead-factory', version: '0.0.9' },
    );
  });

  it("install failure surfaces a remediation pointing at Track B Layer 2", async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const { exec } = fakeExec([
        { exitCode: 1, stderr: 'ERR_PNPM_FETCH_404 source MCP not on registry' },
      ]);
      const output = await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'tok' } },
      );
      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('npm install');
      expect(output.error?.action).toContain('Track B Layer 2');
    });
  });

  it('build failure surfaces a remediation pointing at the codegen template', async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const { exec } = fakeExec([
        { exitCode: 0 }, // install ok
        { exitCode: 2, stderr: "nodes/X/X.node.ts(10,5): error TS2322: bad" },
      ]);
      const output = await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'tok' } },
      );
      expect(output.status).toBe('failed');
      expect(output.error?.message).toContain('npm run build');
      expect(output.error?.action).toContain('run-track-b-layer-2.ts');
    });
  });

  it('npm publish E409 (version conflict) maps to the right cause + remediation', async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const { exec } = fakeExec([
        { exitCode: 0 }, // install
        { exitCode: 0 }, // build
        { exitCode: 1, stderr: 'npm ERR! code E409\ncannot publish over existing version 1.0.0' },
      ]);
      const output = await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: { NPM_TOKEN: 'tok' } },
      );
      expect(output.status).toBe('failed');
      expect(output.error?.cause).toMatch(/already published/);
      expect(output.error?.action).toContain('source MCP version');
    });
  });

  it('without NPM_TOKEN, npm publish gets --provenance flag (OIDC path)', async () => {
    await withGeneratedAdapterDir(async (packageDir) => {
      const probeExec = fakeProbe([{ stdout: '', stderr: 'E404', exitCode: 1 }]);
      const { exec, calls } = fakeExec([
        { exitCode: 0 }, // install
        { exitCode: 0 }, // build
        { exitCode: 0, stdout: '+ ok' },
      ]);
      await publishN8n(
        {
          mcp_name: 'ead-factory',
          version: '1.0.0',
          pipeline_run_id: 'run-9',
          dry_run: false,
          package_dir: packageDir,
        },
        { exec, probeExec, logger: silentLogger, env: {} },
      );
      const publishCall = calls.find((c) => c.args[0] === 'publish');
      expect(publishCall!.args).toContain('--provenance');
    });
  });
});
