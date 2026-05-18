import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// Shared test helper for the v1.1 per-MCP-repo layout: writes a minimal
// `mcp-pipeline.yaml` at repoRoot (registry: only `repo_url` per entry)
// AND a `.distribution.yaml` inside `pending-to-publish/<mcpName>/` (per-
// MCP publish config). Tests that need to exercise consumers of either
// file should call this instead of hand-rolling a fixture.

const DEFAULT_DISTRIBUTION: Record<string, unknown> = {
  distribution_schema_version: 1,
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
  npm_scope: '@g-digital',
  npm_package_name: '@g-digital/mcp-ead-factory',
  docker_image_name: 'gdigital/ead-factory',
  n8n_adapter_target_name: 'n8n-node-ead-factory',
  license: 'MIT',
  credential_help_url: 'https://example.com/onboarding',
  target_overrides: {},
  track_a_targets: 'default',
  track_b_targets: ['n8n', 'make-rom'],
  logo_path: 'assets/logo.png',
};

export interface WriteTestConfigOptions {
  repoRoot: string;
  mcpName?: string;
  repoUrl?: string;
  /** Extra MCPs to register in mcp-pipeline.yaml (repo_url-only entries). */
  extraRegistryEntries?: Record<string, { repo_url: string }>;
  /** Overrides for the default .distribution.yaml content. */
  distributionOverrides?: Record<string, unknown>;
  /** Skip writing .distribution.yaml entirely (for negative-path tests). */
  skipDistribution?: boolean;
}

export async function writeTestConfig(opts: WriteTestConfigOptions): Promise<void> {
  const mcpName = opts.mcpName ?? 'ead-factory';
  const repoUrl =
    opts.repoUrl ?? `https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP`;

  const mcps: Record<string, { repo_url: string }> = {
    [mcpName]: { repo_url: repoUrl },
    ...(opts.extraRegistryEntries ?? {}),
  };
  const registry = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps,
  };
  await fs.writeFile(path.join(opts.repoRoot, 'mcp-pipeline.yaml'), yaml.dump(registry));

  if (opts.skipDistribution) return;

  const distribution = { ...DEFAULT_DISTRIBUTION, ...(opts.distributionOverrides ?? {}) };
  const distDir = path.join(opts.repoRoot, 'pending-to-publish', mcpName);
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(
    path.join(distDir, '.distribution.yaml'),
    yaml.dump(distribution),
  );
}
