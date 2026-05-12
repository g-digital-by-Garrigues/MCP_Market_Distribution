import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const SCRIPT = path.join(REPO_ROOT, 'src', 'ci', 'render-release-report.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runScript(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', SCRIPT],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

const SUCCESS_OUTPUT = JSON.stringify({
  target: 'npm',
  status: 'succeeded',
  target_url: 'https://www.npmjs.com/package/@g-digital/mcp-ead-factory/v/1.0.0',
  version_published: '1.0.0',
  duration_ms: 12345,
  attempts: 1,
  dry_run: false,
});

const FAILED_OUTPUT = JSON.stringify({
  target: 'docker-hub',
  status: 'failed',
  target_url: 'https://example.invalid/dry-run/docker-hub/x/1.0.0',
  version_published: null,
  duration_ms: 6789,
  attempts: 2,
  dry_run: false,
  error: { message: 'docker login failed', cause: 'token bad', action: 'rotate' },
});

describe('render-release-report CLI', () => {
  it('parses newline-separated PublisherOutput JSONs and writes a report file', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'render-report-'));
    try {
      const outputPath = path.join(tmp, 'report.md');
      const result = await runScript({
        MCP_NAME: 'ead-factory',
        VERSION: '1.0.0',
        PIPELINE_RUN_ID: 'run-7',
        WORKFLOW_RUN_URL: 'https://github.com/g/r/actions/runs/7',
        PUBLISHER_RESULTS_JSON: `${SUCCESS_OUTPUT}\n${FAILED_OUTPUT}`,
        OUTPUT_PATH: outputPath,
      });

      expect(result.exitCode).toBe(0);
      const written = await fs.readFile(outputPath, 'utf8');
      // Marker on line 1.
      expect(written.startsWith('<!-- release-report:ead-factory-v1.0.0 -->')).toBe(true);
      // Partial status because one succeeded, one failed.
      expect(written).toContain('**Status:** ⚠️ Partial (1 of 2 targets succeeded)');
      // Alphabetical: docker-hub before npm.
      const dockerIdx = written.indexOf('| docker-hub |');
      const npmIdx = written.indexOf('| npm |');
      expect(dockerIdx).toBeGreaterThan(0);
      expect(npmIdx).toBeGreaterThan(dockerIdx);
      // Stdout echoes the markdown (so the workflow can capture it for the
      // PR comment step without re-reading the file).
      expect(result.stdout).toBe(written);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('exits non-zero (code 2) when required env vars are missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'render-report-err-'));
    try {
      const result = await runScript({
        // MCP_NAME deliberately missing
        VERSION: '1.0.0',
        PIPELINE_RUN_ID: 'run-7',
        WORKFLOW_RUN_URL: 'https://example.invalid',
        PUBLISHER_RESULTS_JSON: '',
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('MCP_NAME');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects PUBLISHER_RESULTS_JSON containing a line that does not match PublisherOutputSchema', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'render-report-bad-'));
    try {
      const bad = JSON.stringify({ target: 'npm', status: 'succeeded' }); // missing required fields
      const result = await runScript({
        MCP_NAME: 'ead-factory',
        VERSION: '1.0.0',
        PIPELINE_RUN_ID: 'run-7',
        WORKFLOW_RUN_URL: 'https://example.invalid',
        PUBLISHER_RESULTS_JSON: bad,
        OUTPUT_PATH: path.join(tmp, 'r.md'),
      });
      expect(result.exitCode).not.toBe(0);
      // zod validation error mentions one of the missing required fields.
      expect(result.stderr).toMatch(/target_url|version_published|duration_ms|attempts|dry_run/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
