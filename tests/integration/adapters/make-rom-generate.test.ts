import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import {
  generateMakeRom,
  GenerateMakeRomError,
} from '../../../src/adapters/make-rom/generate-make-rom.js';
import type { MakeRomArtifact } from '../../../src/adapters/make-rom/types.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const MULTI_TOOL_STUB = path.join(REPO_ROOT, 'tests', 'fixtures', 'test-mcp', 'server-multi-tool.mjs');

async function setupFixture(opts: { mcpName: string; writeServerJson?: boolean }): Promise<{
  repoRoot: string;
  packageDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'make-rom-test-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', opts.mcpName);
  await fs.mkdir(packageDir, { recursive: true });

  await fs.writeFile(
    path.join(packageDir, '.distribution.yaml'),
    yaml.dump({
      distribution_schema_version: 1,
      reverse_dns_name: `io.github.test/${opts.mcpName}`,
      npm_scope: '@g-digital',
      npm_package_name: `@g-digital/mcp-${opts.mcpName}`,
      docker_image_name: `gdigital/${opts.mcpName}`,
      n8n_adapter_target_name: `n8n-node-${opts.mcpName}`,
      license: 'MIT',
      credential_help_url: 'https://example.com',
      target_overrides: {},
    }),
  );
  await fs.writeFile(
    path.join(repoRoot, 'mcp-pipeline.yaml'),
    yaml.dump({
      pipeline_version: 1,
      mcp_schema_version: '2025-12-11',
      n8n_node_api_version: '1.0',
      mcps: { [opts.mcpName]: { repo_url: 'https://github.com/test/test-mcp' } },
    }),
  );

  if (opts.writeServerJson !== false) {
    await fs.writeFile(
      path.join(packageDir, 'server.json'),
      JSON.stringify(
        {
          name: `io.github.test/${opts.mcpName}`,
          description: 'A test multi-tool MCP.',
          version: '1.0.0',
          repository: { source: 'github', url: 'https://github.com/test/test-mcp' },
          packages: [
            {
              identifier: `@g-digital/mcp-${opts.mcpName}`,
              registryType: 'npm',
              transport: { type: 'stdio' },
              version: '1.0.0',
              environmentVariables: [
                {
                  name: 'TEST_API_KEY',
                  description: 'API key.',
                  isSecret: true,
                  isRequired: true,
                },
                {
                  name: 'TEST_BASE_URL',
                  description: 'Base URL.',
                  isSecret: false,
                  isRequired: true,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
  }

  return {
    repoRoot,
    packageDir,
    cleanup: async () => fs.rm(repoRoot, { recursive: true, force: true }),
  };
}

describe('generateMakeRom (integration with multi-tool stub)', () => {
  it('emits a coherent make-rom.json with module + connection + per-tool actions', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({ mcpName: 'multi-tool' });
    try {
      const { artifact, artifactPath } = await generateMakeRom({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });

      // artifact lands at <packageDir>/.make-rom/make-rom.json by default
      expect(artifactPath).toBe(path.join(packageDir, '.make-rom', 'make-rom.json'));
      const fromDisk = JSON.parse(await fs.readFile(artifactPath, 'utf8')) as MakeRomArtifact;
      expect(fromDisk).toEqual(artifact);

      // Module metadata
      expect(artifact.artifactSchemaVersion).toBe(1);
      expect(artifact.module.name).toBe('multi-tool');
      expect(artifact.module.label).toBe('Multi Tool');
      expect(artifact.module.sourceMcpPackageName).toBe('@g-digital/mcp-multi-tool');
      expect(artifact.module.version).toBe('1.0.0');
      expect(artifact.module.sourceRepoUrl).toBe('https://github.com/test/test-mcp');

      // Connection mirrors server.json env vars
      expect(artifact.connection.name).toBe('multiToolApi');
      expect(artifact.connection.fields.map((f) => f.envName).sort()).toEqual([
        'TEST_API_KEY',
        'TEST_BASE_URL',
      ]);
      const apiKey = artifact.connection.fields.find((f) => f.envName === 'TEST_API_KEY')!;
      expect(apiKey.type).toBe('password');
      expect(apiKey.required).toBe(true);
      const baseUrl = artifact.connection.fields.find((f) => f.envName === 'TEST_BASE_URL')!;
      expect(baseUrl.type).toBe('text');

      // One action per stubbed tool
      const actionNames = artifact.actions.map((a) => a.name).sort();
      expect(actionNames).toEqual(['get_widget', 'list_widgets', 'submit_widget']);

      // Every action carries a placeholder communication block with the
      // matching MCP tool name — surfaces the integration gap explicitly.
      for (const a of artifact.actions) {
        expect(a.communication.placeholder).toBe(true);
        expect(a.communication.mcpToolName).toBe(a.name);
      }

      // get_widget has the required widget_id text parameter
      const getWidget = artifact.actions.find((a) => a.name === 'get_widget')!;
      expect(getWidget.parameters).toHaveLength(1);
      expect(getWidget.parameters[0]).toMatchObject({
        name: 'widget_id',
        type: 'text',
        required: true,
      });

      // list_widgets has page_size (integer) + sort (select with two options)
      const listWidgets = artifact.actions.find((a) => a.name === 'list_widgets')!;
      const pageSize = listWidgets.parameters.find((p) => p.name === 'page_size')!;
      expect(pageSize.type).toBe('integer');
      expect(pageSize.default).toBe(25);
      const sort = listWidgets.parameters.find((p) => p.name === 'sort')!;
      expect(sort.type).toBe('select');
      expect(sort.options).toEqual([
        { label: 'asc', value: 'asc' },
        { label: 'desc', value: 'desc' },
      ]);

      // submit_widget lowers metadata nested object to 'json' + flags it.
      const submitWidget = artifact.actions.find((a) => a.name === 'submit_widget')!;
      const metadata = submitWidget.parameters.find((p) => p.name === 'metadata')!;
      expect(metadata.type).toBe('json');
      expect(metadata.loweredFromComplexSchema).toBe(true);

      // Notes surface the lowering + the gateway-placeholder reminder
      expect(artifact.notes.some((n) => n.includes('metadata'))).toBe(true);
      expect(artifact.notes.some((n) => n.includes('gateway'))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it('honours a custom outputPath', async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({ mcpName: 'multi-tool' });
    const tmpOut = await fs.mkdtemp(path.join(os.tmpdir(), 'make-rom-out-'));
    const outputPath = path.join(tmpOut, 'custom-rom.json');
    try {
      const { artifactPath } = await generateMakeRom({
        repoRoot,
        packageDir,
        mcpName: 'multi-tool',
        version: '1.0.0',
        outputPath,
        inspectorCommand: process.execPath,
        inspectorArgs: [MULTI_TOOL_STUB],
        inspectorTimeoutMs: 10_000,
      });
      expect(artifactPath).toBe(outputPath);
      await fs.stat(outputPath);
    } finally {
      await fs.rm(tmpOut, { recursive: true, force: true });
      await cleanup();
    }
  }, 30_000);

  it("throws GenerateMakeRomError(stage='server_json') when server.json is missing", async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({
      mcpName: 'multi-tool',
      writeServerJson: false,
    });
    try {
      await expect(
        generateMakeRom({
          repoRoot,
          packageDir,
          mcpName: 'multi-tool',
          version: '1.0.0',
          inspectorCommand: process.execPath,
          inspectorArgs: [MULTI_TOOL_STUB],
          inspectorTimeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ name: 'GenerateMakeRomError', stage: 'server_json' });
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("throws GenerateMakeRomError(stage='launch') when the MCP command does not exist", async () => {
    const { repoRoot, packageDir, cleanup } = await setupFixture({ mcpName: 'multi-tool' });
    try {
      await expect(
        generateMakeRom({
          repoRoot,
          packageDir,
          mcpName: 'multi-tool',
          version: '1.0.0',
          inspectorCommand: 'node',
          inspectorArgs: ['/path/does/not/exist.mjs'],
          inspectorTimeoutMs: 10_000,
        }),
      ).rejects.toBeInstanceOf(GenerateMakeRomError);
    } finally {
      await cleanup();
    }
  }, 30_000);
});
