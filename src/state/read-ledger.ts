import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  emptyLedger,
  parseLedger,
  targetsToRun,
} from './release-ledger.js';
import {
  TRACK_A_TARGET_IDS,
  TRACK_B_TARGET_IDS,
} from '../schemas/target-ids.js';
import { loadDistributionConfig } from '../distribution/load-distribution-config.js';

// Story 4.8: ledger-read CLI invoked by publish.yml's `ledger-read` job
// after setup. Clones the releases/state orphan branch into a temp dir,
// reads <mcp>/<version>.json (or returns an empty ledger if absent),
// then emits per-target run/skip flags to $GITHUB_OUTPUT so each
// publisher job can `if: needs.ledger-read.outputs.run_<target> ==
// 'true'`.
//
// Inputs (env vars set by the workflow):
//   MCP_NAME, VERSION                   — release identity
//   PIPELINE_RUN_ID                     — correlation
//   RETRY_STEP (optional)               — present iff this run was
//                                          dispatched with step=<X>
//   RETRY_TRACK (optional)              — present iff this run was
//                                          dispatched with track=<a|b>
//   BOT_PAT                             — git push credential for the
//                                          orphan branch
//   GITHUB_REPOSITORY                   — owner/repo (set by GH Actions)
//   GITHUB_OUTPUT                       — output file path
//
// Outputs (per-target should-run booleans + the full ledger JSON):
//   run_<target> = 'true' | 'false'
//   ledger_json = '{...}'  (the current ledger before this run)

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

async function main(): Promise<number> {
  const mcpName = process.env.MCP_NAME ?? '';
  const version = process.env.VERSION ?? '';
  const pipelineRunId = process.env.PIPELINE_RUN_ID ?? '';
  const retryStep = process.env.RETRY_STEP?.trim() || undefined;
  const retryTrack = process.env.RETRY_TRACK?.trim() || undefined;
  const botPat = process.env.BOT_PAT ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const githubOutput = process.env.GITHUB_OUTPUT;

  if (!mcpName || !version || !pipelineRunId || !repo) {
    process.stderr.write('read-ledger: MCP_NAME, VERSION, PIPELINE_RUN_ID, GITHUB_REPOSITORY env vars are required\n');
    return 2;
  }

  const nowIso = new Date().toISOString();
  const allTargets = [...TRACK_A_TARGET_IDS, ...TRACK_B_TARGET_IDS];

  // Clone the orphan branch into a tmp dir. Tolerate the branch not
  // existing on the remote — that's the very-first-release case.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-read-'));
  let ledgerJson = '';
  try {
    const cloneUrl = botPat
      ? `https://x-access-token:${botPat}@github.com/${repo}.git`
      : `https://github.com/${repo}.git`;
    const clone = await execGit([
      'clone', '--branch', STATE_BRANCH, '--single-branch', '--depth', '1', cloneUrl, tmp,
    ]);

    if (clone.exitCode === 0) {
      const filePath = path.join(tmp, 'releases', 'state', mcpName, `${version}.json`);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        ledgerJson = JSON.stringify(parseLedger(raw));
      } catch {
        // File doesn't exist yet → empty ledger.
        ledgerJson = JSON.stringify(emptyLedger(mcpName, version, nowIso));
      }
    } else {
      // Branch doesn't exist or clone failed; treat as empty ledger.
      process.stderr.write(
        `read-ledger: could not clone ${STATE_BRANCH} (${clone.stderr.trim().slice(0, 300)}); proceeding with empty ledger.\n`,
      );
      ledgerJson = JSON.stringify(emptyLedger(mcpName, version, nowIso));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  const ledger = parseLedger(ledgerJson);

  // Interpret RETRY_STEP / RETRY_TRACK. The workflow passes them raw,
  // including phase keywords ('gate', 'publish', 'all') and track value
  // 'both'. Doing the interpretation here (instead of in the YAML
  // expression) sidesteps the GH Actions footgun where `a && '' || b`
  // evaluates to `b` because '' is falsy (caught in run 25853475366,
  // where every target ended up skipped because filter=['all']).
  const PHASE_KEYWORDS = new Set(['gate', 'publish', 'all']);
  let filter: readonly string[] | undefined;
  if (retryStep === 'gate') {
    // gate-only run → no publishers should fire
    filter = [];
  } else if (retryStep && !PHASE_KEYWORDS.has(retryStep)) {
    // retryStep is an explicit target id (npm / cline / ...)
    filter = [retryStep];
  } else if (retryTrack === 'a') {
    filter = TRACK_A_TARGET_IDS;
  } else if (retryTrack === 'b') {
    filter = TRACK_B_TARGET_IDS;
  }

  const runSet = new Set(targetsToRun(ledger, filter));

  // Read the per-MCP skip_targets list from the MCP repo's
  // .distribution.yaml (cloned by checkout-mcp-source) and remove
  // those targets from runSet. This is the deliberate "this store
  // isn't ready in this pipeline version" knob. Currently used for
  // Smithery (v1.0 — see memory/smithery-mcpb-deferred.md), to be
  // unset for that MCP when v1.1 lands MCPB bundle support.
  try {
    const distribution = await loadDistributionConfig(process.cwd(), mcpName);
    if (distribution.skip_targets) {
      for (const id of distribution.skip_targets) {
        runSet.delete(id);
      }
    }
  } catch (err) {
    process.stderr.write(
      `read-ledger: could not load skip_targets from .distribution.yaml (${(err as Error).message}); proceeding without skip filter.\n`,
    );
  }

  // Emit per-target run_<id> outputs.
  const lines: string[] = [];
  for (const id of allTargets) {
    const safeId = id.replace(/-/g, '_');
    lines.push(`run_${safeId}=${runSet.has(id) ? 'true' : 'false'}`);
  }
  lines.push(`ledger_json<<EOF`);
  lines.push(ledgerJson);
  lines.push(`EOF`);

  const text = lines.join('\n') + '\n';
  if (githubOutput) {
    await fs.appendFile(githubOutput, text);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

void main().then((code) => process.exit(code));
