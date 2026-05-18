import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { runTrustedPublishers } from '../../../src/setup/run-trusted-publishers.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

async function seedRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-publishers-'));
  await writeTestConfig({ repoRoot });
  return repoRoot;
}

describe('runTrustedPublishers', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('iterates both the mcp-* and n8n-node-* packages per MCP entry', async () => {
    repoRoot = await seedRepo();
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      dryRun: true,
    });
    const names = result.outcomes.map((o) => o.packageName).sort();
    expect(names).toEqual([
      '@g-digital/mcp-ead-factory',
      '@g-digital/n8n-node-ead-factory',
    ]);
  });

  it('classifies a 404 from npm as package-not-published with the bootstrap remediation', async () => {
    repoRoot = await seedRepo();
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
    repoRoot = await seedRepo();
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
    repoRoot = await seedRepo();
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      exec: () => ({ status: 0, stdout: 'Trust grant added.', stderr: '' }),
    });
    expect(result.counts.configured).toBe(2);
  });

  it('classifies an unknown non-zero exit as failed and surfaces stderr in detail', async () => {
    repoRoot = await seedRepo();
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
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-publishers-'));
    // Register two MCPs in mcp-pipeline.yaml. Then write two
    // .distribution.yaml files that share the same npm_package_name +
    // n8n_adapter_target_name so the dedupe logic collapses both into
    // one pair. (Second writeTestConfig call would overwrite
    // mcp-pipeline.yaml — so we register both up-front and write the
    // alt distribution file manually.)
    await writeTestConfig({
      repoRoot,
      extraRegistryEntries: {
        'ead-factory-alt': {
          repo_url: 'https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP-Alt',
        },
      },
    });
    const altDir = path.join(repoRoot, 'pending-to-publish', 'ead-factory-alt');
    await fs.mkdir(altDir, { recursive: true });
    await fs.writeFile(
      path.join(altDir, '.distribution.yaml'),
      yaml.dump({
        distribution_schema_version: 1,
        // Same npm_package_name + n8n_adapter_target_name as ead-factory,
        // different reverse_dns_name to keep schema validation happy.
        reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory-alt',
        npm_scope: '@g-digital',
        npm_package_name: '@g-digital/mcp-ead-factory',
        docker_image_name: 'gdigital/ead-factory',
        n8n_adapter_target_name: 'n8n-node-ead-factory',
        license: 'MIT',
        credential_help_url: 'https://example.com/onboarding',
        target_overrides: {},
      }),
    );
    const result = await runTrustedPublishers({
      repoRoot,
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      dryRun: true,
    });
    expect(result.outcomes.map((o) => o.packageName)).toEqual([
      '@g-digital/mcp-ead-factory',
      '@g-digital/n8n-node-ead-factory',
    ]);
  });
});
