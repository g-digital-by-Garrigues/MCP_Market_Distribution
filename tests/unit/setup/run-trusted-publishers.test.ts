import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { runTrustedPublishers } from '../../../src/setup/run-trusted-publishers.js';

const BASE_ENTRY = {
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/evidence-manager',
  npm_scope: '@g-digital',
  npm_package_name: '@g-digital/mcp-evidence-manager',
  docker_image_name: 'gdigital/evidence-manager',
  license: 'MIT',
  n8n_adapter_target_name: 'n8n-node-evidence-manager',
  credential_help_url: 'https://eadtrust.example.com/onboarding',
  target_overrides: {},
};

async function seedRepo(mcps: Record<string, typeof BASE_ENTRY>): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-publishers-'));
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

describe('runTrustedPublishers', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('iterates both the mcp-* and n8n-node-* packages per MCP entry', async () => {
    repoRoot = await seedRepo({ 'evidence-manager': BASE_ENTRY });
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      dryRun: true,
    });
    const names = result.outcomes.map((o) => o.packageName).sort();
    expect(names).toEqual([
      '@g-digital/mcp-evidence-manager',
      '@g-digital/n8n-node-evidence-manager',
    ]);
  });

  it('classifies a 404 from npm as package-not-published with the bootstrap remediation', async () => {
    repoRoot = await seedRepo({ 'evidence-manager': BASE_ENTRY });
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      exec: () => ({ status: 1, stdout: '', stderr: 'npm error 404 Not Found' }),
    });
    expect(result.counts['package-not-published']).toBe(2);
    expect(result.counts.configured).toBe(0);
    expect(result.outcomes[0]?.detail).toMatch(/0\.0\.0-bootstrap/);
  });

  it('classifies a successful invocation containing "already" as already-configured (idempotent)', async () => {
    repoRoot = await seedRepo({ 'evidence-manager': BASE_ENTRY });
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      exec: () => ({
        status: 0,
        stdout: 'package already has a trust grant for this workflow.',
        stderr: '',
      }),
    });
    expect(result.counts['already-configured']).toBe(2);
    expect(result.counts.configured).toBe(0);
  });

  it('classifies a successful new grant as configured', async () => {
    repoRoot = await seedRepo({ 'evidence-manager': BASE_ENTRY });
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      exec: () => ({ status: 0, stdout: 'Trust grant added.', stderr: '' }),
    });
    expect(result.counts.configured).toBe(2);
  });

  it('classifies an unknown non-zero exit as failed and surfaces stderr in detail', async () => {
    repoRoot = await seedRepo({ 'evidence-manager': BASE_ENTRY });
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      exec: () => ({ status: 1, stdout: '', stderr: 'unexpected: network unreachable' }),
    });
    expect(result.counts.failed).toBe(2);
    expect(result.outcomes[0]?.detail).toContain('network unreachable');
  });

  it('de-duplicates packages when multiple entries share the same npm_package_name', async () => {
    repoRoot = await seedRepo({
      'evidence-manager': BASE_ENTRY,
      'evidence-manager-alt': {
        ...BASE_ENTRY,
        reverse_dns_name: 'io.github.g-digital-by-Garrigues/evidence-manager-alt',
      },
    });
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      dryRun: true,
    });
    expect(result.outcomes.map((o) => o.packageName)).toEqual([
      '@g-digital/mcp-evidence-manager',
      '@g-digital/n8n-node-evidence-manager',
    ]);
  });
});
