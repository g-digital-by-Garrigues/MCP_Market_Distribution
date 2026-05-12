import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  emptyLedger,
  mergePublisherOutput,
  parseLedger,
  recomputeOverallStatus,
  serializeLedger,
} from './release-ledger.js';
import {
  publisherOutputSchema,
  type PublisherOutput,
} from '../schemas/publisher-output.schema.js';

// Story 4.8: ledger-write CLI invoked by publish.yml's final-report job.
// Reads the current ledger from the releases/state orphan branch,
// merges this run's PublisherOutputs (one per target) into it,
// recomputes the overall status, commits, and pushes.
//
// Inputs:
//   MCP_NAME, VERSION                   — release identity
//   PIPELINE_RUN_ID                     — correlation
//   PUBLISHER_RESULTS_JSON              — newline-separated PublisherOutputs
//   BOT_PAT                             — git push credential
//   GITHUB_REPOSITORY                   — owner/repo
//
// In dry-run mode the caller is expected to NOT invoke this CLI at all
// (publish.yml gates the write-ledger step on dry_run != 'true').

const STATE_BRANCH = 'releases/state';

async function execGit(args: readonly string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'], cwd, shell: false });
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    child.on('error', (err) => resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: -1 }));
  });
}

function parseOutputs(raw: string): PublisherOutput[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.map((line) => publisherOutputSchema.parse(JSON.parse(line)));
}

async function main(): Promise<number> {
  const mcpName = process.env.MCP_NAME ?? '';
  const version = process.env.VERSION ?? '';
  const pipelineRunId = process.env.PIPELINE_RUN_ID ?? '';
  const rawResults = process.env.PUBLISHER_RESULTS_JSON ?? '';
  const botPat = process.env.BOT_PAT ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? '';

  if (!mcpName || !version || !pipelineRunId || !repo) {
    process.stderr.write('write-ledger: MCP_NAME, VERSION, PIPELINE_RUN_ID, GITHUB_REPOSITORY env vars are required\n');
    return 2;
  }
  if (!botPat) {
    process.stderr.write('write-ledger: BOT_PAT is required to push to the orphan branch\n');
    return 2;
  }

  const outputs = parseOutputs(rawResults);
  const nowIso = new Date().toISOString();
  const cloneUrl = `https://x-access-token:${botPat}@github.com/${repo}.git`;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-write-'));
  try {
    let cloned = false;
    const clone = await execGit([
      'clone', '--branch', STATE_BRANCH, '--single-branch', '--depth', '1', cloneUrl, tmp,
    ]);
    cloned = clone.exitCode === 0;
    if (!cloned) {
      process.stderr.write(
        `write-ledger: clone of ${STATE_BRANCH} failed (${clone.stderr.trim().slice(0, 300)}). Run \`pnpm run init-state-branch\` first.\n`,
      );
      return 1;
    }

    const stateDir = path.join(tmp, 'releases', 'state', mcpName);
    await fs.mkdir(stateDir, { recursive: true });
    const filePath = path.join(stateDir, `${version}.json`);

    let ledger;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      ledger = parseLedger(raw);
    } catch {
      ledger = emptyLedger(mcpName, version, nowIso);
    }

    for (const output of outputs) {
      ledger = mergePublisherOutput(ledger, output, pipelineRunId, nowIso);
    }
    ledger = { ...ledger, status: recomputeOverallStatus(ledger), updated_at: nowIso };

    await fs.writeFile(filePath, serializeLedger(ledger), 'utf8');

    const steps: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'user.email', 'g-digital-mcp-bot@users.noreply.github.com'],
      ['config', 'user.name', 'g-digital-mcp-bot'],
      ['add', `releases/state/${mcpName}/${version}.json`],
      ['commit', '-m', `state(${mcpName} v${version}): ${ledger.status} after run ${pipelineRunId}`],
      ['pull', '--rebase', 'origin', STATE_BRANCH],
      ['push', 'origin', `HEAD:${STATE_BRANCH}`],
    ];
    for (const args of steps) {
      const r = await execGit(args, tmp);
      // 'git commit' returns non-zero if there's nothing to commit — that's fine.
      if (args[0] === 'commit' && /nothing to commit/.test(r.stdout + r.stderr)) {
        process.stderr.write('write-ledger: no changes to ledger, skipping push.\n');
        return 0;
      }
      if (r.exitCode !== 0) {
        process.stderr.write(
          `write-ledger: git ${args.join(' ')} failed (exit ${r.exitCode}): ${r.stderr.trim().slice(0, 300)}\n`,
        );
        return 1;
      }
    }
    process.stderr.write(`write-ledger: ledger updated (${ledger.status}) and pushed to ${STATE_BRANCH}.\n`);
    return 0;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

void main().then((code) => process.exit(code));
