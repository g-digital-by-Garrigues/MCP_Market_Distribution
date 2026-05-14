import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

async function runScript(env: Record<string, string>): Promise<Run> {
  const outFile = await fs.mkdtemp(path.join(os.tmpdir(), 'read-ledger-out-'));
  const outputPath = path.join(outFile, 'GITHUB_OUTPUT');
  await fs.writeFile(outputPath, '');
  try {
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', SCRIPT],
        {
          cwd: REPO_ROOT,
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
      child.on('close', (code) => resolve(code ?? -1));
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
  it('REGRESSION (run #25853475366): step="all" + track="both" → ALL run_*=true', async () => {
    // Before the fix the YAML emitted RETRY_STEP='all' (instead of ''),
    // which the script interpreted as filter=['all'] and produced
    // run_*=false for every real target.
    const r = await runScript({
      // Use a fictitious MCP name so the real mcp-pipeline.yaml's
      // skip_targets (which excludes smithery for ead-factory) doesn't
      // interfere with these tests' expectations. The skip_targets
      // behavior is exercised by its own dedicated test below.
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'all',
      RETRY_TRACK: 'both',
    });
    expect(r.exitCode).toBe(0);
    for (const flag of ALL_FLAGS) {
      expect(r.outputs[flag], flag).toBe('true');
    }
  }, 30_000);

  it('empty step + empty track → ALL run_*=true', async () => {
    const r = await runScript({
      // Use a fictitious MCP name so the real mcp-pipeline.yaml's
      // skip_targets (which excludes smithery for ead-factory) doesn't
      // interfere with these tests' expectations. The skip_targets
      // behavior is exercised by its own dedicated test below.
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: '',
      RETRY_TRACK: '',
    });
    for (const flag of ALL_FLAGS) {
      expect(r.outputs[flag], flag).toBe('true');
    }
  }, 30_000);

  it('step="gate" → ALL run_*=false (gate-only run, no publishers)', async () => {
    const r = await runScript({
      // Use a fictitious MCP name so the real mcp-pipeline.yaml's
      // skip_targets (which excludes smithery for ead-factory) doesn't
      // interfere with these tests' expectations. The skip_targets
      // behavior is exercised by its own dedicated test below.
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'gate',
      RETRY_TRACK: 'both',
    });
    for (const flag of ALL_FLAGS) {
      expect(r.outputs[flag], flag).toBe('false');
    }
  }, 30_000);

  it('step="cline" (single-target retry) → only run_cline=true', async () => {
    const r = await runScript({
      // Use a fictitious MCP name so the real mcp-pipeline.yaml's
      // skip_targets (which excludes smithery for ead-factory) doesn't
      // interfere with these tests' expectations. The skip_targets
      // behavior is exercised by its own dedicated test below.
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'cline',
      RETRY_TRACK: 'both',
    });
    expect(r.outputs.run_cline).toBe('true');
    for (const flag of ALL_FLAGS.filter((f) => f !== 'run_cline')) {
      expect(r.outputs[flag], flag).toBe('false');
    }
  }, 30_000);

  it('track="a" + empty step → only Track A run_*=true', async () => {
    const r = await runScript({
      // Use a fictitious MCP name so the real mcp-pipeline.yaml's
      // skip_targets (which excludes smithery for ead-factory) doesn't
      // interfere with these tests' expectations. The skip_targets
      // behavior is exercised by its own dedicated test below.
      MCP_NAME: 'fictitious-test-mcp',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: '',
      RETRY_TRACK: 'a',
    });
    const trackA = ['run_npm', 'run_docker_hub', 'run_mcp_publisher', 'run_smithery', 'run_docker_mcp_catalog', 'run_cline', 'run_mcpso'];
    for (const flag of trackA) expect(r.outputs[flag], flag).toBe('true');
    expect(r.outputs.run_n8n).toBe('false');
    expect(r.outputs.run_make_rom).toBe('false');
  }, 30_000);

  it('skip_targets: ead-factory excludes smithery (per mcp-pipeline.yaml) even with no retry filter', async () => {
    // mcp-pipeline.yaml has skip_targets: [smithery] for ead-factory
    // because Smithery's 2026 model requires MCPB bundles (deferred to
    // v1.1). The script must honor that — run_smithery=false even
    // though all other targets in Track A should run.
    const r = await runScript({
      MCP_NAME: 'ead-factory',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: '',
      RETRY_TRACK: '',
    });
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
    // Even if someone dispatches /retry-publish?step=smithery, the
    // skip_targets entry must win — the pipeline currently has no
    // working publisher for smithery in this MCP. run_smithery=false.
    const r = await runScript({
      MCP_NAME: 'ead-factory',
      VERSION: '1.0.0',
      PIPELINE_RUN_ID: 'run-1',
      RETRY_STEP: 'smithery',
      RETRY_TRACK: 'both',
    });
    expect(r.exitCode).toBe(0);
    expect(r.outputs.run_smithery).toBe('false');
  }, 30_000);
});
