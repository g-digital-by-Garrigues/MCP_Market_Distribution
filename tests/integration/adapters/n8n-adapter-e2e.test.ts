import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import { buildN8nNodeSpec } from '../../../src/adapters/n8n-adapter/build-node-spec.js';
import { generateN8nNode } from '../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import { refineWithLlm } from '../../../src/adapters/n8n-adapter/refine-with-llm.js';

// End-to-end proof: spawn the multi-tool stub MCP, build the spec
// against its live tools/list, (skip refine without API key), and
// render the n8n node tree. Asserts the rendered tree is a coherent
// n8n community-node package (right files, right metadata, right
// generated TS shape). When the Track B Layer 2 gate (Story 5.3)
// lands it will also `tsc --noEmit` the output; this test just
// pins the orchestration end-to-end.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const MULTI_TOOL_STUB = path.join(REPO_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-multi-tool.mjs');

async function seedFixture(): Promise<{
  repoRoot: string;
  packageDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-adapter-e2e-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', 'multi-tool');
  await fs.mkdir(packageDir, { recursive: true });

  const distribution = {
    distribution_schema_version: 1,
    reverse_dns_name: 'io.github.test/multi-tool',
    npm_scope: '@g-digital',
    npm_package_name: '@g-digital/mcp-multi-tool',
    docker_image_name: 'gdigital/multi-tool',
    n8n_adapter_target_name: 'n8n-nodes-multi-tool',
    license: 'MIT',
    credential_help_url: 'https://example.com',
    target_overrides: {},
  };
  await fs.writeFile(path.join(packageDir, '.distribution.yaml'), yaml.dump(distribution));
  const registry = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps: { 'multi-tool': { repo_url: 'https://github.com/test/test-mcp' } },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(registry));

  const serverJson = {
    name: distribution.reverse_dns_name,
    description: 'A test multi-tool MCP.',
    version: '1.0.0',
    repository: { source: 'github', url: 'https://github.com/test/test-mcp' },
    packages: [
      {
        identifier: distribution.npm_package_name,
        registryType: 'npm',
        transport: { type: 'stdio' },
        version: '1.0.0',
        environmentVariables: [
          {
            name: 'TEST_API_KEY',
            description: 'API key for the test backend.',
            isSecret: true,
            isRequired: true,
          },
          {
            name: 'TEST_BASE_URL',
            description: 'Base URL of the test backend.',
            isSecret: false,
            isRequired: true,
          },
        ],
      },
    ],
  };
  await fs.writeFile(path.join(packageDir, 'server.json'), JSON.stringify(serverJson, null, 2));

  return {
    repoRoot,
    packageDir,
    cleanup: async () => fs.rm(repoRoot, { recursive: true, force: true }),
  };
}

describe('n8n adapter end-to-end (build → refine-skipped → generate)', () => {
  it('produces a coherent n8n community-node package from the multi-tool stub', async () => {
    const { repoRoot, packageDir, cleanup } = await seedFixture();
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-adapter-out-'));
    try {
      // 1. Build the spec from tools/list.
      const { spec: rawSpec, unsupportedNotes } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      // 2. Refine pass — without ANTHROPIC_API_KEY, returns the spec
      //    unchanged. The point of including this step is to prove the
      //    full chain works without an API key in CI.
      const refined = await refineWithLlm({
        spec: rawSpec,
        env: { ANTHROPIC_API_KEY: '' },
      });
      expect(refined.applied).toBe(false);
      expect(refined.spec).toBe(rawSpec);

      // 3. Generate the n8n node tree.
      const { filesWritten } = await generateN8nNode({ spec: refined.spec, outputDir });

      // ─ Coherent package metadata ─
      expect(filesWritten).toContain('package.json');
      const pkg = JSON.parse(await fs.readFile(path.join(outputDir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        dependencies: Record<string, string>;
        n8n: { credentials: string[]; nodes: string[] };
      };
      expect(pkg.name).toBe('@g-digital/n8n-nodes-multi-tool');
      expect(pkg.version).toBe('1.0.0');
      // Source MCP is pinned exactly to the same version so the n8n
      // node always travels with a matching MCP.
      expect(pkg.dependencies['@g-digital/mcp-multi-tool']).toBe('1.0.0');
      expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
      expect(pkg.n8n.nodes).toEqual(['dist/nodes/MultiTool/MultiTool.node.js']);
      expect(pkg.n8n.credentials).toEqual(['dist/credentials/MultiToolApi.credentials.js']);

      // ─ Node class shape ─
      const nodeSrc = await fs.readFile(
        path.join(outputDir, 'nodes', 'MultiTool', 'MultiTool.node.ts'),
        'utf8',
      );
      // Header comment cites the source MCP.
      expect(nodeSrc).toContain('Source MCP: @g-digital/mcp-multi-tool (1.0.0)');
      // Class + n8n description.name.
      expect(nodeSrc).toContain('export class MultiTool implements INodeType');
      expect(nodeSrc).toContain("name: 'multiTool'");
      // All 3 stub operations show up in the dropdown.
      expect(nodeSrc).toContain("value: 'get_widget'");
      expect(nodeSrc).toContain("value: 'list_widgets'");
      expect(nodeSrc).toContain("value: 'submit_widget'");
      // Required field for get_widget keeps `required: true`.
      expect(nodeSrc).toMatch(/name: 'widget_id'[\s\S]+required: true/);
      // Page size from list_widgets carries numberConstraints from the stub schema.
      expect(nodeSrc).toContain('"minValue":1');
      expect(nodeSrc).toContain('"maxValue":100');
      // Enum-as-options for sort.
      expect(nodeSrc).toMatch(/name: 'sort'[\s\S]+\{ name: "asc", value: "asc" \}/);
      // OPERATION_PROPERTY_NAMES is rendered at the bottom for every op.
      expect(nodeSrc).toContain("'get_widget': ['widget_id']");
      expect(nodeSrc).toContain("'submit_widget': ['name', 'metadata']");

      // ─ Credentials class shape ─
      const credsSrc = await fs.readFile(
        path.join(outputDir, 'credentials', 'MultiToolApi.credentials.ts'),
        'utf8',
      );
      expect(credsSrc).toContain('export class MultiToolApi implements ICredentialType');
      expect(credsSrc).toContain("name = 'multiToolApi'");
      expect(credsSrc).toMatch(/name: 'TEST_API_KEY'[\s\S]+typeOptions: { password: true }/);
      expect(credsSrc).toContain("name: 'TEST_BASE_URL'");

      // ─ README has the operations + credentials tables ─
      const readme = await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');
      expect(readme).toContain('| `get_widget` |');
      expect(readme).toContain('| `list_widgets` |');
      expect(readme).toContain('| `submit_widget` |');
      expect(readme).toContain('| `TEST_API_KEY` |');

      // ─ unsupportedNotes surfaces the 'metadata' nested-object lowering ─
      expect(unsupportedNotes.some((n) => n.includes("'metadata'"))).toBe(true);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
      await cleanup();
    }
  }, 30_000);
});
