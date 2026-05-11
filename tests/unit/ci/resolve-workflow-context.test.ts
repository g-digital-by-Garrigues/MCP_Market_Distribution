import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveWorkflowContext } from '../../../src/ci/resolve-workflow-context.js';

const BASE_ENTRY = {
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
  npm_scope: '@g-digital',
  npm_package_name: '@g-digital/mcp-ead-factory',
  docker_image_name: 'gdigital/ead-factory',
  license: 'MIT',
  n8n_adapter_target_name: 'n8n-node-ead-factory',
  credential_help_url: 'https://eadtrust.example.com/onboarding',
  target_overrides: {},
};

async function seedRepo(mcps: Record<string, typeof BASE_ENTRY & { git_tag_prefix?: string }>): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resolve-ctx-'));
  await fs.writeFile(
    path.join(repoRoot, 'mcp-pipeline.yaml'),
    yaml.dump({
      pipeline_version: 1,
      mcp_schema_version: '2025-12-11',
      n8n_node_api_version: '1.0',
      mcps,
    }),
    'utf8',
  );
  return repoRoot;
}

describe('resolveWorkflowContext — workflow_dispatch path', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('uses inputs verbatim when both inputMcpName and inputVersion are provided', async () => {
    repoRoot = await seedRepo({ 'ead-factory': BASE_ENTRY });
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
    repoRoot = await seedRepo({ 'ead-factory': BASE_ENTRY });
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
    repoRoot = await seedRepo({ 'ead-factory': BASE_ENTRY });
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

  it('matches an explicit per-MCP git_tag_prefix when present', async () => {
    repoRoot = await seedRepo({
      'ead-factory': { ...BASE_ENTRY, git_tag_prefix: 'ead-factory-v' },
    });
    const result = await resolveWorkflowContext({
      tag: 'ead-factory-v2.0.0-rc.1',
      configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
      runId: '1',
      runAttempt: '1',
    });
    expect(result.mcp_name).toBe('ead-factory');
    expect(result.version).toBe('2.0.0-rc.1');
  });

  it('prefers the longest matching prefix when two MCPs share a stem', async () => {
    repoRoot = await seedRepo({
      'ead-factory': { ...BASE_ENTRY, git_tag_prefix: 'v' },
      'ead-factory-v2': {
        ...BASE_ENTRY,
        reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory-v2',
        npm_package_name: '@g-digital/mcp-ead-factory-v2',
        docker_image_name: 'gdigital/ead-factory-v2',
        n8n_adapter_target_name: 'n8n-node-ead-factory-v2',
        git_tag_prefix: 'v2-',
      },
    });
    const result = await resolveWorkflowContext({
      tag: 'v2-1.0.0',
      configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
      runId: '1',
      runAttempt: '1',
    });
    expect(result.mcp_name).toBe('ead-factory-v2');
    expect(result.version).toBe('1.0.0');
  });

  it('throws a descriptive error when no prefix matches the tag', async () => {
    repoRoot = await seedRepo({
      'ead-factory': { ...BASE_ENTRY, git_tag_prefix: 'ead-factory-v' },
    });
    await expect(
      resolveWorkflowContext({
        tag: 'release-1.0.0',
        configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
        runId: '1',
        runAttempt: '1',
      }),
    ).rejects.toThrow(/does not match any MCP's git_tag_prefix/);
  });

  it('throws when neither a tag nor inputs are provided', async () => {
    repoRoot = await seedRepo({ 'ead-factory': BASE_ENTRY });
    await expect(
      resolveWorkflowContext({
        configPath: path.join(repoRoot, 'mcp-pipeline.yaml'),
        runId: '1',
        runAttempt: '1',
      }),
    ).rejects.toThrow(/either a tag .* or both inputMcpName and inputVersion/);
  });
});
