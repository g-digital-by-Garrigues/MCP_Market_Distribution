import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeTestConfig } from '../../helpers/write-test-config.js';

// Integration-style test for read-ledger.ts. We spawn the script with
// stub env vars and assert the per-target run_<id> outputs match the
// AC-mandated behavior for each combination of RETRY_STEP / RETRY_TRACK.
// This regression-guards run #25853475366, where the YAML expression
// `inputs.step && '' || inputs.step` evaluated to 'all' instead of '',
// causing the script to filter to ['all'] and emit run_*=false for
// every real target.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const SCRIPT = path.join(REPO_ROOT, 'src', 'state', 'read-ledger.ts');

interface Run {
  outputs: Record<string, string>;
  exitCode: number;
}

async function runScript(env: Record<string, string>, cwd: string = REPO_ROOT): Promise<Run> {
  const outFile = await fs.mkdtemp(path.join(os.tmpdir(), 'read-ledger-out-'));
  const outputPath = path.join(outFile, 'GITHUB_OUTPUT');
  await fs.writeFile(outputPath, '');
  try {
    const exitCode = await new Promise<number>((resolve) => {
      // Resolve the tsx loader from REPO_ROOT's node_modules so the
      // child can find it even when cwd points at a temp dir (used by
      // the skip_targets tests below). Passing the absolute URL avoids
      // node's name-based --import resolution falling back to cwd.
      const tsxLoaderUrl = new URL('file:///' + path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs').replace(/\\/g, '/')).toString();
      const child = spawn(
        process.execPath,
        ['--import', tsxLoaderUrl, SCRIPT],
        {
          cwd,
          env: {
            ...process.env,
            ...env,
            GITHUB_OUTPUT: outputPath,
            // Force the script down the "could not clone" empty-ledger
            // fallback by giving it a repo path that can't be cloned.
            // BOT_PAT is intentionally absent.
            GITHUB_REPOSITORY: 'g-digital-by-Garrigues/does-not-exist-and-cannot-clone',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          process.stderr.write(`read-ledger spawn failed (exit ${code}): ${stderr.slice(0, 500)}\n`);
        }
        resolve(code ?? -1);
      });
    });
    const raw = await fs.readFile(outputPath, 'utf8');
    const outputs: Record<string, string> = {};
    const lines = raw.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (!line) {
        i++;
        continue;
      }
      const eq = line.indexOf('=');
      if (line.includes('<<EOF')) {
        const key = line.slice(0, line.indexOf('<<EOF'));
        i++;
        const bodyLines: string[] = [];
        while (i < lines.length && lines[i] !== 'EOF') {
          bodyLines.push(lines[i]!);
          i++;
        }
        outputs[key] = bodyLines.join('\n');
      } else if (eq > 0) {
        outputs[line.slice(0, eq)] = line.slice(eq + 1);
      }
      i++;
    }
    return { outputs, exitCode };
  } finally {
    await fs.rm(outFile, { recursive: true, force: true });
  }
}

const ALL_FLAGS = [
  'run_npm', 'run_docker_hub', 'run_mcp_publisher', 'run_smithery',
  'run_docker_mcp_catalog', 'run_cline', 'run_mcpso',
  'run_n8n', 'run_make_rom',
];

describe('read-ledger CLI', () => {
  // read-ledger now hard-fails when .distribution.yaml is missing
  // (skip_targets is a safety mechanism — we MUST not silently drop the
  // filter). Seed a temp cwd with a valid fixture so tests that don't
  // exercise skip_targets still pass.
  let neutralCwd: string;
  beforeAll(async () => {
    neutralCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'read-ledger-neutral-'));
    await writeTestConfig({
      repoRoot: neutralCwd,
      mcpName: 'fictitious-test-mcp',
      distributionOverrides: { skip_targets: undefined },
    });
  });
  afterAll(async () => {
    if (neutralCwd) await fs.rm(neutralCwd, { recursive: true, force: true });
  });

  it('REGRESSION (run #25853475366): step="all" + track="both" → ALL run_*=true', async () => {
    // Before the fix the YAML emitted RETRY_STEP='all' (instead of ''),
    // which the script interpreted as filter=['all'] and produced
    // run_*=false for every real target.
    const r = await runScript({
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'all',
      RETRY_TRACK: 'both',
    }, neutralCwd);
    expect(r.exitCode).toBe(0);
    for (const flag of ALL_FLAGS) {
      expect(r.outputs[flag], flag).toBe('true');
    }
  }, 30_000);

  it('empty step + empty track → ALL run_*=true', async () => {
    const r = await runScript({
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: '',
      RETRY_TRACK: '',
    }, neutralCwd);
    for (const flag of ALL_FLAGS) {
      expect(r.outputs[flag], flag).toBe('true');
    }
  }, 30_000);

  it('step="gate" → ALL run_*=false (gate-only run, no publishers)', async () => {
    const r = await runScript({
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'gate',
      RETRY_TRACK: 'both',
    }, neutralCwd);
    for (const flag of ALL_FLAGS) {
      expect(r.outputs[flag], flag).toBe('false');
    }
  }, 30_000);

  it('step="cline" (single-target retry) → only run_cline=true', async () => {
    const r = await runScript({
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'cline',
      RETRY_TRACK: 'both',
    }, neutralCwd);
    expect(r.outputs.run_cline).toBe('true');
    for (const flag of ALL_FLAGS.filter((f) => f !== 'run_cline')) {
      expect(r.outputs[flag], flag).toBe('false');
    }
  }, 30_000);

  it('track="a" + empty step → only Track A run_*=true', async () => {
    const r = await runScript({
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: '',
      RETRY_TRACK: 'a',
    }, neutralCwd);
    const trackA = ['run_npm', 'run_docker_hub', 'run_mcp_publisher', 'run_smithery', 'run_docker_mcp_catalog', 'run_cline', 'run_mcpso'];
    for (const flag of trackA) expect(r.outputs[flag], flag).toBe('true');
    expect(r.outputs.run_n8n).toBe('false');
    expect(r.outputs.run_make_rom).toBe('false');
  }, 30_000);

  it('FATAL: missing .distribution.yaml → exit 1 (no silent skip-target bypass)', async () => {
    const emptyCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'read-ledger-empty-'));
    try {
      const r = await runScript(
        {
          MCP_NAME: 'fictitious-test-mcp',
          VERSION: '1.0.0',
          PIPELINE_RUN_ID: 'run-1',
          RETRY_STEP: '',
          RETRY_TRACK: '',
        },
        emptyCwd,
      );
      expect(r.exitCode).toBe(1);
    } finally {
      await fs.rm(emptyCwd, { recursive: true, force: true });
    }
  }, 30_000);

  // skip_targets reads from the per-MCP .distribution.yaml that the
  // checkout-mcp-source composite action drops into
  // pending-to-publish/<mcp_name>/ at workflow time. Seed a temp cwd
  // that mirrors that layout so the script's skip filter fires.
  describe('skip_targets enforcement (per-MCP .distribution.yaml)', () => {
    let tempCwd: string;
    beforeAll(async () => {
      tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'read-ledger-cwd-'));
      await writeTestConfig({
        repoRoot: tempCwd,
        distributionOverrides: { skip_targets: ['smithery'] },
      });
    });
    afterAll(async () => {
      await fs.rm(tempCwd, { recursive: true, force: true });
    });

    it('skip_targets: ead-factory excludes smithery (per .distribution.yaml) even with no retry filter', async () => {
      const r = await runScript(
        {
          MCP_NAME: 'ead-factory',
          VERSION: '1.0.0',
          PIPELINE_RUN_ID: 'run-1',
          RETRY_STEP: '',
          RETRY_TRACK: '',
        },
        tempCwd,
      );
      expect(r.exitCode).toBe(0);
      expect(r.outputs.run_smithery).toBe('false');
      // The other 6 Track A targets are unaffected.
      expect(r.outputs.run_npm).toBe('true');
      expect(r.outputs.run_docker_hub).toBe('true');
      expect(r.outputs.run_mcp_publisher).toBe('true');
      expect(r.outputs.run_docker_mcp_catalog).toBe('true');
      expect(r.outputs.run_cline).toBe('true');
      expect(r.outputs.run_mcpso).toBe('true');
    }, 30_000);

    it('skip_targets overrides an explicit retry step (engineer cannot bypass)', async () => {
      const r = await runScript(
        {
          MCP_NAME: 'ead-factory',
          VERSION: '1.0.0',
          PIPELINE_RUN_ID: 'run-1',
          RETRY_STEP: 'smithery',
          RETRY_TRACK: 'both',
        },
        tempCwd,
      );
      expect(r.exitCode).toBe(0);
      expect(r.outputs.run_smithery).toBe('false');
    }, 30_000);
  });
});
