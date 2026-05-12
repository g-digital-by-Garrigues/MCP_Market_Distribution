import { describe, expect, it, vi } from 'vitest';

import { STATE_BRANCH, initStateBranch, type GitExec } from '../../../src/setup/init-state-branch.js';

interface CallLog {
  cmd: readonly string[];
  cwd?: string;
}

function fakeGit(
  perCommand: (args: readonly string[], call: number) => { exitCode: number; stdout?: string; stderr?: string },
): { git: GitExec; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const git: GitExec = async (args, options = {}) => {
    const r = perCommand(args, calls.length);
    calls.push({ cmd: args, ...(options.cwd ? { cwd: options.cwd } : {}) });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { git, calls };
}

describe('initStateBranch', () => {
  it('returns action=already_exists when ls-remote reports the branch is on origin', async () => {
    const { git, calls } = fakeGit((args) => {
      if (args[0] === 'ls-remote') {
        return { exitCode: 0, stdout: `abcd1234\trefs/heads/${STATE_BRANCH}\n` };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const log = vi.fn();
    const result = await initStateBranch({ repoRoot: '/tmp/repo', git, log });
    expect(result).toEqual({ action: 'already_exists', branch: 'releases/state' });
    expect(log).toHaveBeenCalledWith({ event: 'state_branch.already_exists', details: { branch: 'releases/state' } });
    // ONLY the ls-remote call should have happened — no worktree, no commit, no push.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd[0]).toBe('ls-remote');
  });

  it('creates the orphan branch + commit + push when the remote does not have it', async () => {
    const { git, calls } = fakeGit((args) => {
      if (args[0] === 'ls-remote') return { exitCode: 0, stdout: '' };
      // worktree add / commit / push / worktree remove all succeed
      return { exitCode: 0 };
    });
    const log = vi.fn();
    const result = await initStateBranch({ repoRoot: '/tmp/repo', git, log });
    expect(result).toEqual({ action: 'created', branch: 'releases/state' });
    // ls-remote → worktree add → commit → push → worktree remove
    const cmds = calls.map((c) => c.cmd.join(' '));
    expect(cmds).toContain('ls-remote --heads origin releases/state');
    expect(cmds.some((c) => c.startsWith('worktree add --orphan -b releases/state'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('-C .git/state-init-worktree commit --allow-empty'))).toBe(true);
    expect(cmds).toContain('-C .git/state-init-worktree push -u origin releases/state');
    expect(cmds.some((c) => c.startsWith('worktree remove'))).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'state_branch.created' }),
    );
  });

  it('surfaces the underlying error if `git push` fails after the orphan branch was created locally', async () => {
    const { git } = fakeGit((args) => {
      if (args[0] === 'ls-remote') return { exitCode: 0, stdout: '' };
      if (args.includes('push')) {
        return { exitCode: 128, stderr: 'remote rejected: branch protection requires PR' };
      }
      return { exitCode: 0 };
    });
    const log = vi.fn();
    await expect(initStateBranch({ repoRoot: '/tmp/repo', git, log })).rejects.toThrow(/git push failed/);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'state_branch.error', details: expect.objectContaining({ step: 'push' }) }),
    );
  });

  it('throws when ls-remote itself fails (cannot tell idempotency state)', async () => {
    const { git } = fakeGit((_args) => ({
      exitCode: 128,
      stderr: 'fatal: could not read from remote repository',
    }));
    await expect(initStateBranch({ repoRoot: '/tmp/repo', git })).rejects.toThrow(/ls-remote failed/);
  });
});
