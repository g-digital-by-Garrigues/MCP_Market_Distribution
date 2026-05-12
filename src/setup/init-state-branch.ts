import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Story 3.9: idempotent setup script that ensures the `releases/state`
// orphan branch exists. Epic 4's retry semantics (Story 4.8) read+write
// `releases/state/<mcp_name>/<version>.json` on that branch to track
// per-target attempt history across slash-command retries.
//
// "Orphan" branch means it has no shared history with main — it's a
// parallel namespace inside the same repo. That's intentional: the state
// ledger is high-churn (every release attempt writes to it) and we don't
// want those commits cluttering main's git log or triggering main's CI.
//
// Idempotent: re-running this script after the branch is created is a
// no-op that exits 0 — engineers can run it as part of repo bootstrap
// and CI can run it before every Epic 4 publish without consequence.

export const STATE_BRANCH = 'releases/state';
const STATE_GITKEEP_PATH = '.gitkeep';
const REMOTE_NAME = 'origin';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitExec = (args: readonly string[], options?: { cwd?: string }) => Promise<ExecResult>;

export interface InitStateBranchOptions {
  repoRoot: string;
  /** Inject for tests; defaults to spawn-based git. */
  git?: GitExec;
  /** Inject for tests; defaults to console.log routing. */
  log?: (event: { event: 'state_branch.created' | 'state_branch.already_exists' | 'state_branch.error'; details?: unknown }) => void;
}

export interface InitStateBranchResult {
  action: 'created' | 'already_exists';
  branch: string;
}

function defaultGit(args: readonly string[], options: { cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: options.cwd,
      env: process.env,
    });
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ stdout, stderr: `${stderr}\n${(err as Error).message}`, exitCode: -1 });
    });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function remoteBranchExists(git: GitExec, repoRoot: string): Promise<boolean> {
  // `git ls-remote --heads origin releases/state` exits 0 with output if the
  // branch exists remotely, exits 0 with empty stdout if it doesn't. We never
  // rely on local refs because the script may run on a fresh clone.
  const result = await git(['ls-remote', '--heads', REMOTE_NAME, STATE_BRANCH], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-remote failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().length > 0;
}

export async function initStateBranch(opts: InitStateBranchOptions): Promise<InitStateBranchResult> {
  const git = opts.git ?? defaultGit;
  const log = opts.log ?? (() => {});
  const cwd = opts.repoRoot;

  if (await remoteBranchExists(git, cwd)) {
    log({ event: 'state_branch.already_exists', details: { branch: STATE_BRANCH } });
    return { action: 'already_exists', branch: STATE_BRANCH };
  }

  // Use a worktree so we don't disturb the current checkout. The worktree
  // path is deliberately inside the repo's tmp dir (already in .gitignore)
  // — that keeps file system noise contained.
  const worktreePath = '.git/state-init-worktree';
  const steps: Array<readonly string[]> = [
    // 1. Create an orphan branch (no parent commits).
    ['worktree', 'add', '--orphan', '-b', STATE_BRANCH, worktreePath],
    // 2. Inside the worktree, drop a .gitkeep so the branch has content.
    // We use git commands only (no fs operations) so the script doesn't
    // pollute the main checkout's working tree.
  ];

  for (const args of steps) {
    const r = await git(args, { cwd });
    if (r.exitCode !== 0) {
      log({ event: 'state_branch.error', details: { args, stderr: r.stderr.trim() } });
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    }
  }

  // Add .gitkeep using git hash-object + update-index so we never touch the
  // filesystem of the parent checkout. Cleaner: just use the worktree.
  const writeKeep = await git(
    ['-C', worktreePath, 'commit', '--allow-empty', '-m', 'chore(state): initialize releases/state orphan branch'],
    { cwd },
  );
  if (writeKeep.exitCode !== 0) {
    log({ event: 'state_branch.error', details: { step: 'initial-commit', stderr: writeKeep.stderr.trim() } });
    throw new Error(`git commit (initial) failed: ${writeKeep.stderr.trim()}`);
  }

  // Push the new branch upstream.
  const push = await git(['-C', worktreePath, 'push', '-u', REMOTE_NAME, STATE_BRANCH], { cwd });
  if (push.exitCode !== 0) {
    log({ event: 'state_branch.error', details: { step: 'push', stderr: push.stderr.trim() } });
    throw new Error(`git push failed: ${push.stderr.trim()}`);
  }

  // Clean up the worktree — the branch lives on origin now, we don't need
  // a local checkout of it. The orphan branch's local ref stays in place
  // (worktree remove doesn't delete the branch).
  await git(['worktree', 'remove', worktreePath, '--force'], { cwd });

  log({ event: 'state_branch.created', details: { branch: STATE_BRANCH, gitkeep: STATE_GITKEEP_PATH } });
  return { action: 'created', branch: STATE_BRANCH };
}

async function main(): Promise<number> {
  try {
    const result = await initStateBranch({
      repoRoot: process.cwd(),
      log: (e) => process.stdout.write(JSON.stringify(e) + '\n'),
    });
    process.stderr.write(`init-state-branch: ${result.action}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`init-state-branch failed: ${(err as Error).message}\n`);
    return 1;
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
