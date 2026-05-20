import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateMcpbBundle } from '../../../../src/adapters/mcpb-adapter/generate-mcpb-bundle.js';
import type { McpbBundleSpec } from '../../../../src/adapters/mcpb-adapter/types.js';

function sampleSpec(): McpbBundleSpec {
  return {
    name: 'multi-tool',
    displayName: 'Multi Tool',
    version: '1.0.0',
    description: 'A test multi-tool MCP server.',
    sourceMcpPackageName: '@g-digital/mcp-multi-tool',
    sourceRepoUrl: 'https://github.com/g-digital-by-Garrigues/multi-tool-mcp',
    author: { name: 'g-digital by Garrigues' },
    keywords: ['mcp', 'test', 'widget'],
    operations: [
      {
        name: 'get_widget',
        description: 'Fetch a widget by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      { name: 'list_widgets', description: 'List widgets.' },
    ],
    userConfig: [
      {
        envName: 'TEST_API_KEY',
        configKey: 'test_api_key',
        title: 'Test Api Key',
        description: 'API key for the test backend.',
        sensitive: true,
        required: true,
      },
      {
        envName: 'TEST_BASE_URL',
        configKey: 'test_base_url',
        title: 'Test Base Url',
        description: 'Base URL of the test backend.',
        sensitive: false,
        required: true,
      },
    ],
    entryPoint: 'server/index.js',
    iconPath: 'assets/icon.png',
    smitheryNamespace: 'g-digital',
  };
}

async function writeStubSourceMcp(sourceDir: string): Promise<void> {
  // Minimal source-MCP shape the generator depends on: package.json,
  // LICENSE, dist/ with at least server.js, a logo (so the icon-copy
  // path exercises), plus a sub-file to verify recursive copying.
  await fs.mkdir(path.join(sourceDir, 'dist', 'lib'), { recursive: true });
  await fs.mkdir(path.join(sourceDir, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'package.json'),
    JSON.stringify({ name: '@g-digital/mcp-multi-tool', version: '1.0.0', main: 'dist/server.js' }, null, 2),
  );
  await fs.writeFile(path.join(sourceDir, 'LICENSE'), 'MIT License — stub.\n');
  await fs.writeFile(path.join(sourceDir, 'assets', 'logo-400x400.png'), 'PNG-stub-bytes');
  await fs.writeFile(path.join(sourceDir, 'dist', 'server.js'), 'console.log("server entry");\n');
  await fs.writeFile(path.join(sourceDir, 'dist', 'lib', 'helper.js'), 'export function h() {}\n');
}

describe('generateMcpbBundle', () => {
  let outputDir: string;
  let sourceMcpDir: string;
  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpb-gen-out-'));
    sourceMcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcpb-gen-src-'));
    await writeStubSourceMcp(sourceMcpDir);
  });
  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.rm(sourceMcpDir, { recursive: true, force: true });
  });

  it('writes the canonical pre-pack bundle tree (manifest + README + LICENSE + staged server/)', async () => {
    const result = await generateMcpbBundle({
      spec: sampleSpec(),
      outputDir,
      sourceMcpDir,
      sourceLogoRelPath: 'assets/logo-400x400.png',
    });
    // Sorted with locale-aware compare. Locale ordering puts lowercase
    // `assets/...` first, then uppercase `LICENSE`, then `manifest.json`,
    // then `README.md` (uppercase R lands between `m` and `s` per the
    // same rule the n8n adapter test documented), then the staged
    // server/ files. Note: `assets/icon.png` only appears when
    // sourceLogoRelPath is set; the optional-LICENSE test below removes
    // both LICENSE and the logo to verify graceful fallback.
    expect(result.filesWritten).toEqual([
      'assets/icon.png',
      'LICENSE',
      'manifest.json',
      'README.md',
      'server/index.js',
      'server/lib/helper.js',
      'server/package.json',
    ]);
    for (const rel of result.filesWritten) {
      const stat = await fs.stat(path.join(outputDir, rel));
      expect(stat.isFile()).toBe(true);
    }
  });

  it('renders manifest.json as valid JSON with the spec fields populated', async () => {
    await generateMcpbBundle({ spec: sampleSpec(), outputDir, sourceMcpDir });
    const raw = await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      manifest_version: string;
      name: string;
      version: string;
      description: string;
      author: { name: string };
      server: { type: string; entry_point: string; mcp_config: { command: string; args: string[]; env: Record<string, string> } };
      user_config: Record<string, { type: string; title: string; sensitive: boolean; required: boolean }>;
    };
    expect(parsed.manifest_version).toBe('0.3');
    expect(parsed.name).toBe('multi-tool');
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.author.name).toBe('g-digital by Garrigues');
    expect(parsed.server.type).toBe('node');
    expect(parsed.server.entry_point).toBe('server/index.js');
    expect(parsed.server.mcp_config.command).toBe('node');
    // Manifest substitutes user_config into the env block — the env var
    // name stays UPPER_SNAKE while the config key is lower_snake.
    expect(parsed.server.mcp_config.env['TEST_API_KEY']).toBe('${user_config.test_api_key}');
    expect(parsed.server.mcp_config.env['TEST_BASE_URL']).toBe('${user_config.test_base_url}');
    // user_config has both fields with the right flags.
    const apiKey = parsed.user_config['test_api_key'];
    const baseUrl = parsed.user_config['test_base_url'];
    expect(apiKey).toBeDefined();
    expect(baseUrl).toBeDefined();
    expect(apiKey!.sensitive).toBe(true);
    expect(apiKey!.required).toBe(true);
    expect(baseUrl!.sensitive).toBe(false);
  });

  it('renames dist/server.js → server/index.js to match the MCPB conventional entry point', async () => {
    // Why: the manifest.entry_point is `server/index.js` (the MCPB host
    // hard-codes that path in many cases); the source MCP's compiled
    // entry lives at dist/server.js. The generator renames during
    // staging so both ends line up without changing the source MCP.
    await generateMcpbBundle({ spec: sampleSpec(), outputDir, sourceMcpDir });
    await expect(fs.stat(path.join(outputDir, 'server', 'index.js'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(outputDir, 'server', 'server.js'))).rejects.toThrow();
    // Sub-files keep their relative path under server/.
    await expect(fs.stat(path.join(outputDir, 'server', 'lib', 'helper.js'))).resolves.toBeDefined();
  });

  it('README documents every tool + every user_config field + the Smithery install command', async () => {
    await generateMcpbBundle({ spec: sampleSpec(), outputDir, sourceMcpDir });
    const readme = await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');
    expect(readme).toContain('| `get_widget` |');
    expect(readme).toContain('| `list_widgets` |');
    expect(readme).toContain('`TEST_API_KEY`');
    expect(readme).toContain('`TEST_BASE_URL`');
    // The Smithery install line carries the org-qualified name.
    expect(readme).toContain('smithery mcp install g-digital/multi-tool');
  });

  it('throws when the source MCP has no dist/ (caller forgot to build first)', async () => {
    await fs.rm(path.join(sourceMcpDir, 'dist'), { recursive: true, force: true });
    await expect(generateMcpbBundle({ spec: sampleSpec(), outputDir, sourceMcpDir })).rejects.toThrow(
      /dist\/ missing/,
    );
  });

  it('throws when the source MCP has no package.json (we need it to bundle into server/)', async () => {
    await fs.rm(path.join(sourceMcpDir, 'package.json'));
    await expect(generateMcpbBundle({ spec: sampleSpec(), outputDir, sourceMcpDir })).rejects.toThrow(
      /package\.json missing/,
    );
  });

  it("omits LICENSE from filesWritten when the source MCP doesn't ship one (optional file)", async () => {
    await fs.rm(path.join(sourceMcpDir, 'LICENSE'));
    const result = await generateMcpbBundle({
      spec: sampleSpec(),
      outputDir,
      sourceMcpDir,
      sourceLogoRelPath: 'assets/logo-400x400.png',
    });
    expect(result.filesWritten).not.toContain('LICENSE');
  });

  it('clean=true wipes leftover files in the output dir before re-rendering', async () => {
    const stale = path.join(outputDir, 'stale.txt');
    await fs.writeFile(stale, 'leftover');
    await generateMcpbBundle({ spec: sampleSpec(), outputDir, sourceMcpDir, clean: true });
    await expect(fs.stat(stale)).rejects.toThrow();
  });

  it("manifest.json JSON-encodes strings with quotes so they don't break parse", async () => {
    const spec = sampleSpec();
    spec.description = `A "tricky" description's edge case`;
    await generateMcpbBundle({ spec, outputDir, sourceMcpDir });
    const raw = await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8');
    // Round-trip parse is the definitive test that the Handlebars `json`
    // helper escaped quotes correctly.
    const parsed = JSON.parse(raw) as { description: string };
    expect(parsed.description).toBe(`A "tricky" description's edge case`);
  });
});
