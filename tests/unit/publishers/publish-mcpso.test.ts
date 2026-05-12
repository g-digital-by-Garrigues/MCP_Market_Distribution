import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { publishMcpSo } from '../../../src/publishers/publish-mcpso.js';
import type { ExecFn } from '../../../src/publishers/file-marketplace-issue.js';

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
  const config = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps: {
      'ead-factory': {
        reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
        npm_scope: '@g-digital',
        npm_package_name: '@g-digital/mcp-ead-factory',
        docker_image_name: 'gdigital/ead-factory',
        n8n_adapter_target_name: 'n8n-node-ead-factory',
        license: 'MIT',
        credential_help_url: 'https://example.com',
        target_overrides: {},
        track_a_targets: 'default',
        track_b_targets: ['n8n'],
        logo_path: 'assets/logo.png',
      },
    },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(config));
  const tplDir = path.join(repoRoot, 'templates', 'store-descriptions');
  await fs.mkdir(tplDir, { recursive: true });
  await fs.writeFile(path.join(tplDir, 'mcpso-issue.hbs'), TEMPLATE);
  await fs.mkdir(path.join(repoRoot, 'pending-to-publish', 'ead-factory'), { recursive: true });
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
});
