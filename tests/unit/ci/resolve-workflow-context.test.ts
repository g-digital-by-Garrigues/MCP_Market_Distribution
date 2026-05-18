import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkflowContext } from '../../../src/ci/resolve-workflow-context.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

// In the v1.1 per-MCP-repo model, the pipeline's `mcp-pipeline.yaml`
// no longer carries per-MCP `git_tag_prefix`. The resolver always
// assumes the default 'v' prefix and first-match wins — disambiguating
// when >1 MCP would need workflow_dispatch with an explicit mcp_name.

async function seedRepo(extra?: Record<string, { repo_url: string }>): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-ctx-'));
  await writeTestConfig({
    repoRoot,
    ...(extra ? { extraRegistryEntries: extra } : {}),
  });
  return repoRoot;
}

describe('resolveWorkflowContext — workflow_dispatch path', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('uses inputs verbatim when both inputMcpName and inputVersion are provided', async () => {
    repoRoot = await seedRepo();
    const result = await resolveWorkflowContext({
      inputMcpName: 'ead-factory',
      inputVersion: '1.0.0',
      configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
      runId: '42',
      runAttempt: '3',
    });
    expect(result).toEqual({
      mcp_name: 'ead-factory',
      version: '1.0.0',
      pipeline_run_id: '42-3',
      source: 'workflow-dispatch',
    });
  });

  it('treats empty-string inputs the same as missing (falls through to tag matching)', async () => {
    repoRoot = await seedRepo();
    const result = await resolveWorkflowContext({
      tag: 'v1.0.0',
      inputMcpName: '   ',
      inputVersion: '',
      configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
      runId: '7',
      runAttempt: '1',
    });
    expect(result.source).toBe('tag-push');
    expect(result.version).toBe('1.0.0');
  });
});

describe('resolveWorkflowContext — tag-push path', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('matches the default git_tag_prefix "v" and extracts the version suffix', async () => {
    repoRoot = await seedRepo();
    const result = await resolveWorkflowContext({
      tag: 'v1.2.3',
      configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
      runId: '99',
      runAttempt: '2',
    });
    expect(result.mcp_name).toBe('ead-factory');
    expect(result.version).toBe('1.2.3');
    expect(result.pipeline_run_id).toBe('99-2');
    expect(result.source).toBe('tag-push');
  });

  it('throws a descriptive error when no prefix matches the tag', async () => {
    repoRoot = await seedRepo();
    await expect(
      resolveWorkflowContext({
        tag: 'release-1.0.0',
        configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
        runId: '1',
        runAttempt: '1',
      }),
    ).rejects.toThrow(/does not start with 'v'/);
  });

  it('throws when neither a tag nor inputs are provided', async () => {
    repoRoot = await seedRepo();
    await expect(
      resolveWorkflowContext({
        configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
        runId: '1',
        runAttempt: '1',
      }),
    ).rejects.toThrow(/either a tag .* or both inputMcpName and inputVersion/);
  });
});
