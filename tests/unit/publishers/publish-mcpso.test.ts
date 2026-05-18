import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publishMcpSo } from '../../../src/publishers/publish-mcpso.js';
import type { ExecFn } from '../../../src/publishers/file-marketplace-issue.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeExec(
  responses: (call: { cmd: string; args: readonly string[] }) => { exitCode: number; stdout?: string; stderr?: string },
): { exec: ExecFn; calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses({ cmd, args });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode };
  };
  return { exec, calls };
}

const TEMPLATE = `# {{mcp_name}} {{version}}\nlogo: {{logo_url}}\nrun {{pipeline_run_id}}\n`;

async function withRepoRoot(body: (repoRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpso-test-'));
  await writeTestConfig({ repoRoot });
  const tplDir = path.join(repoRoot, 'templates', 'store-descriptions');
  await fs.mkdir(tplDir, { recursive: true });
  await fs.writeFile(path.join(tplDir, 'mcpso-issue.hbs'), TEMPLATE);
  try {
    await body(repoRoot);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe('publishMcpSo', () => {
  beforeEach(() => silentLogger.info.mockClear());

  it('happy path: opens an issue against chatmcp/mcp-directory with the canonical title', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return { exitCode: 0, stdout: '[]' };
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: 'https://github.com/chatmcp/mcp-directory/issues/55\n' };
        }
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishMcpSo(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' }, sleep: async () => {} },
      );
      expect(result.status).toBe('succeeded');
      expect(result.target).toBe('mcpso');
      expect(result.target_url).toBe('https://github.com/chatmcp/mcp-directory/issues/55');
      const create = calls.find((c) => c.args[1] === 'create');
      expect(create?.args).toContain('--title');
      expect(create?.args).toContain('[Submission] ead-factory v1.0.0');
      // The repo arg must be chatmcp/mcp-directory (NOT cline's repo).
      expect(create?.args.find((_, i) => i > 0 && create?.args[i - 1] === '--repo')).toBe('chatmcp/mcp-directory');
    });
  });

  it('idempotency: open issue with matching title → status=skipped', async () => {
    await withRepoRoot(async (repoRoot) => {
      const { exec } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 9, title: '[Submission] ead-factory v1.0.0', url: 'https://github.com/chatmcp/mcp-directory/issues/9' }]),
          };
        }
        return { exitCode: 1, stderr: 'should not be called' };
      });
      const result = await publishMcpSo(
        { mcp_name: 'ead-factory', version: '1.0.0', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' } },
      );
      expect(result.status).toBe('skipped');
      expect(result.target_url).toBe('https://github.com/chatmcp/mcp-directory/issues/9');
    });
  });

  // close-stale-issues (v1.1 backlog item 2). mcpso uses a versioned title,
  // so without cleanup each release leaves the previous version's issue
  // open. We assert that after the new issue is created, the publisher
  // finds older open submissions (same mcp_name, different version) and
  // closes each with a Superseded-by comment.

  it('close-stale: after creating new issue, closes older open submissions with Superseded comment', async () => {
    await withRepoRoot(async (repoRoot) => {
      const newIssueUrl = 'https://github.com/chatmcp/mcp-directory/issues/777';
      const newIssueNumber = 777;
      let issueListCalls = 0;
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          issueListCalls += 1;
          // 1st call → idempotency search for exact new title (no match).
          // 2nd call → stale search returns 3 older versions + the new one.
          if (issueListCalls === 1) return { exitCode: 0, stdout: '[]' };
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              { number: 100, title: '[Submission] ead-factory v1.0.0' },
              { number: 200, title: '[Submission] ead-factory v1.0.1' },
              { number: 300, title: '[Submission] ead-factory v1.0.2' },
              { number: newIssueNumber, title: '[Submission] ead-factory v1.0.3' },
              { number: 999, title: '[Submission] other-mcp v1.0.0' }, // unrelated — must NOT close
            ]),
          };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: `${newIssueUrl}\n` };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment') return { exitCode: 0 };
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'close') return { exitCode: 0 };
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishMcpSo(
        { mcp_name: 'ead-factory', version: '1.0.3', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' }, sleep: async () => {} },
      );

      expect(result.status).toBe('succeeded');
      expect(result.target_url).toBe(newIssueUrl);

      // Three closes, three comments — one per stale issue (100, 200, 300).
      // The unrelated 'other-mcp' issue (999) must NOT be touched even though
      // gh's fuzzy --search returned it.
      const closes = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'close');
      const comments = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'comment');
      expect(closes).toHaveLength(3);
      expect(comments).toHaveLength(3);
      const closedNumbers = closes.map((c) => c.args[2]).sort();
      expect(closedNumbers).toEqual(['100', '200', '300']);

      // The Superseded-by comment must reference #777.
      const commentBodies = comments
        .map((c) => c.args.find((_, i) => i > 0 && c.args[i - 1] === '--body'))
        .filter((b): b is string => typeof b === 'string');
      expect(commentBodies).toHaveLength(3);
      for (const body of commentBodies) {
        expect(body).toContain('#777');
        expect(body).toContain('ead-factory v1.0.3');
      }

      // Each close uses --reason not_planned.
      for (const close of closes) {
        const reasonIdx = close.args.findIndex((a) => a === '--reason');
        expect(reasonIdx).toBeGreaterThan(-1);
        expect(close.args[reasonIdx + 1]).toBe('not_planned');
      }
    });
  });

  it('close-stale: failures to comment or close DO NOT fail the publisher (best-effort)', async () => {
    await withRepoRoot(async (repoRoot) => {
      const newIssueUrl = 'https://github.com/chatmcp/mcp-directory/issues/777';
      let issueListCalls = 0;
      const { exec } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          issueListCalls += 1;
          if (issueListCalls === 1) return { exitCode: 0, stdout: '[]' };
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ number: 100, title: '[Submission] ead-factory v1.0.0' }]),
          };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: `${newIssueUrl}\n` };
        }
        // Both cleanup ops fail. Publisher should still return succeeded.
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'comment') return { exitCode: 1, stderr: 'comment failed' };
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'close') return { exitCode: 1, stderr: 'close failed' };
        return { exitCode: 1, stderr: 'unexpected' };
      });
      const result = await publishMcpSo(
        { mcp_name: 'ead-factory', version: '1.0.3', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' }, sleep: async () => {} },
      );

      expect(result.status).toBe('succeeded');
      expect(result.target_url).toBe(newIssueUrl);
    });
  });

  it('close-stale: stale search failing DOES NOT fail the publisher', async () => {
    await withRepoRoot(async (repoRoot) => {
      const newIssueUrl = 'https://github.com/chatmcp/mcp-directory/issues/777';
      let issueListCalls = 0;
      const { exec, calls } = fakeExec(({ cmd, args }) => {
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          issueListCalls += 1;
          if (issueListCalls === 1) return { exitCode: 0, stdout: '[]' };
          // Stale-issue search fails (rate limit, network blip, etc.).
          return { exitCode: 1, stderr: 'HTTP 503' };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
          return { exitCode: 0, stdout: `${newIssueUrl}\n` };
        }
        return { exitCode: 1, stderr: 'should not be called' };
      });
      const result = await publishMcpSo(
        { mcp_name: 'ead-factory', version: '1.0.3', pipeline_run_id: 'r', dry_run: false, repo_root: repoRoot },
        { exec, logger: silentLogger, env: { BOT_PAT: 'pat' }, sleep: async () => {} },
      );

      expect(result.status).toBe('succeeded');
      // No close/comment ops should have happened.
      const closes = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'close');
      const comments = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'comment');
      expect(closes).toHaveLength(0);
      expect(comments).toHaveLength(0);
    });
  });
});
