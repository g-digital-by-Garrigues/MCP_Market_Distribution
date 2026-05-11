import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runTrackALayer3,
  type Exec,
  type ExecResult,
} from '../../../src/gates/run-track-a-layer-3.js';
import { errorReportSchema } from '../../../src/schemas/error-report.schema.js';

interface ExecPattern {
  match: RegExp | ((cmd: string, args: readonly string[]) => boolean);
  result: ExecResult;
}

function makeExec(patterns: readonly ExecPattern[], fallback?: ExecResult): Exec {
  return (cmd, args) => {
    const cmdline = `${cmd} ${args.join(' ')}`;
    for (const p of patterns) {
      const matched =
        typeof p.match === 'function' ? p.match(cmd, args) : p.match.test(cmdline);
      if (matched) return p.result;
    }
    return fallback ?? { status: 0, stdout: '', stderr: '' };
  };
}

const SUCCESS: ExecResult = { status: 0, stdout: '', stderr: '' };

async function seedMcpFolder(opts: {
  withBin?: boolean | string;
  withBinFile?: boolean;
  withDockerfile?: boolean;
}): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'layer-3-'));
  const folder = path.join(repoRoot, 'pending-to-publish', 'test-mcp');
  await fs.mkdir(folder, { recursive: true });

  const pkg: Record<string, unknown> = {
    name: 'test-mcp',
    version: '1.0.0',
    scripts: { build: 'echo build-ok' },
  };
  if (opts.withBin === true) {
    pkg.bin = { 'test-mcp': 'dist/server.js' };
  } else if (typeof opts.withBin === 'string') {
    pkg.bin = opts.withBin;
  }
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  if (opts.withBinFile) {
    await fs.mkdir(path.join(folder, 'dist'), { recursive: true });
    await fs.writeFile(path.join(folder, 'dist', 'server.js'), '// stub\n', 'utf8');
  }
  if (opts.withDockerfile) {
    await fs.writeFile(path.join(folder, 'Dockerfile'), 'FROM node:22-alpine\n', 'utf8');
  }
  return repoRoot;
}

describe('runTrackALayer3 (unit, exec is mocked)', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('happy path: every check passes → log.event = gate.layer_3_passed', async () => {
    repoRoot = await seedMcpFolder({ withBin: true, withBinFile: true, withDockerfile: true });
    const packJson = JSON.stringify([
      { files: [{ path: 'dist/server.js' }, { path: 'package.json' }] },
    ]);
    const exec = makeExec([
      { match: /^docker /, result: SUCCESS },
      { match: /^bash /, result: SUCCESS },
      { match: /^npm pack/, result: { status: 0, stdout: packJson, stderr: '' } },
    ]);
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      exec,
      pipelineRunId: 'run-9',
    });
    expect(result.passed).toBe(true);
    expect(result.log.event).toBe('gate.layer_3_passed');
    expect(result.log.pipeline_run_id).toBe('run-9');
    expect(result.errors).toEqual([]);
    expect(result.checks_run).toEqual(['npm_build', 'docker', 'npx_install']);
  });

  it('AC-mandated failure: TypeScript build error → observation carries first 200 chars + canonical action', async () => {
    repoRoot = await seedMcpFolder({ withBin: true, withBinFile: true });
    const longTscError =
      'src/server.ts(42,10): error TS2322: Type \'string\' is not assignable to type \'number\'.\n'.repeat(
        20,
      );
    const exec = makeExec([
      { match: /^npm install/, result: SUCCESS },
      { match: /^npm run build/, result: { status: 1, stdout: longTscError, stderr: '' } },
    ]);
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      skipDocker: true,
      skipNpxProbe: true,
      exec,
    });
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.layer_3_failed');
    const tsError = result.errors.find((e) => e.check === 'npm_build');
    expect(tsError).toBeDefined();
    expect(tsError!.observation.length).toBeLessThanOrEqual(200);
    expect(tsError!.observation).toContain('TS2322');
    expect(tsError!.action).toBe(
      "Fix TypeScript build errors locally with 'npm run build' and push a fix commit, then re-run.",
    );
    expect(errorReportSchema.safeParse(tsError).success).toBe(true);
  });

  it('npm install failure short-circuits — npm_build is the only check attempted', async () => {
    repoRoot = await seedMcpFolder({});
    const exec = makeExec([
      {
        match: /^npm install/,
        result: { status: 1, stdout: '', stderr: 'npm error E404 not found' },
      },
    ]);
    const result = await runTrackALayer3({ repoRoot, mcpName: 'test-mcp', exec });
    expect(result.passed).toBe(false);
    expect(result.checks_run).toEqual(['npm_build']);
    expect(result.errors[0]?.check).toBe('npm_install');
    expect(result.errors[0]?.observation).toContain('E404');
  });

  it('docker check: missing Dockerfile → docker_build error pointing at the missing file', async () => {
    repoRoot = await seedMcpFolder({ withBin: true, withBinFile: true });
    const exec = makeExec([], SUCCESS);
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      skipNpxProbe: true,
      exec,
    });
    expect(result.passed).toBe(false);
    const dockerError = result.errors.find((e) => e.check === 'docker_build');
    expect(dockerError).toBeDefined();
    expect(dockerError!.observation).toContain('No Dockerfile');
  });

  it('docker check: HEALTHCHECK times out → docker_healthcheck error with 60s framing', async () => {
    repoRoot = await seedMcpFolder({ withBin: true, withBinFile: true, withDockerfile: true });
    const exec = makeExec(
      [
        { match: /^docker build/, result: SUCCESS },
        { match: /^docker run/, result: SUCCESS },
        { match: /^docker stop/, result: SUCCESS },
        { match: /^bash /, result: { status: 3, stdout: '', stderr: '' } },
      ],
      SUCCESS,
    );
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      skipNpxProbe: true,
      exec,
    });
    expect(result.passed).toBe(false);
    const healthError = result.errors.find((e) => e.check === 'docker_healthcheck');
    expect(healthError).toBeDefined();
    expect(healthError!.observation).toContain('60s');
  });

  it('npx_install: missing bin field → AC-mandated action ("Add a \\"bin\\" entry")', async () => {
    repoRoot = await seedMcpFolder({ withBin: false });
    const exec = makeExec([], SUCCESS);
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      skipDocker: true,
      exec,
    });
    expect(result.passed).toBe(false);
    const npxError = result.errors.find((e) => e.check === 'npx_install');
    expect(npxError).toBeDefined();
    expect(npxError!.observation).toContain('no "bin"');
    expect(npxError!.action).toContain('"bin"');
  });

  it('npx_install: bin file present but excluded from npm pack output → files-glob error', async () => {
    repoRoot = await seedMcpFolder({ withBin: true, withBinFile: true });
    const packJson = JSON.stringify([{ files: [{ path: 'package.json' }] }]);
    const exec = makeExec([
      { match: /^npm pack/, result: { status: 0, stdout: packJson, stderr: '' } },
    ]);
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      skipDocker: true,
      exec,
    });
    expect(result.passed).toBe(false);
    const npxError = result.errors.find((e) => e.check === 'npx_install');
    expect(npxError).toBeDefined();
    expect(npxError!.observation).toContain('not listed in npm pack output');
    expect(npxError!.action).toContain('package.json#files');
  });

  it('every emitted error carries stage=gate, layer=3, target=null', async () => {
    repoRoot = await seedMcpFolder({ withBin: false });
    const exec = makeExec([], SUCCESS);
    const result = await runTrackALayer3({
      repoRoot,
      mcpName: 'test-mcp',
      skipDocker: true,
      exec,
    });
    for (const err of result.errors) {
      expect(err.stage).toBe('gate');
      expect(err.layer).toBe(3);
      expect(err.target).toBeNull();
    }
  });
});
