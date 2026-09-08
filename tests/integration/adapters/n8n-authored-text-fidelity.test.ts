import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';

import { buildN8nNodeSpec } from '../../../src/adapters/n8n-adapter/build-node-spec.js';
import { generateN8nNode } from '../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import { POST_E18_ENV_VARS } from '../../fixtures/env-sets/post-e18-user-key.js';

// Story 18.3 / FR62: generation's authored text reaches every published
// surface byte-identical. The pipeline used to run an optional LLM "refine"
// pass between buildN8nNodeSpec and generateN8nNode that rewrote the node
// description, the operation copy and the credential labels whenever
// ANTHROPIC_API_KEY happened to be exported — so the published npm package
// disagreed with the committed n8n-node/ tree the Creator Portal reviewers
// lint. That pass is deleted; this test is the pin.
//
// The assertion is spec → file, NOT tool-source → file (AC4/AC6): the spec's
// operation description is `normalizeIdCasing(tool.description)`, so a source
// that writes `` `id` `` legitimately emits `` `ID` ``. The three surviving
// transforms (normalizeIdCasing, whetherizeBooleanDescription, and n8n's own
// ESLint --fix, which never runs over README.md) are n8n presentation rules
// and all pre-date this story.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const AUTHORED_TEXT_STUB = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'test-mcp',
  'server-authored-text.mjs',
);

// Authored node-class copy with the same re-encode canaries as the tool
// descriptions: an em dash, a backtick and literal double quotes.
const AUTHORED_NODE_DESCRIPTION =
  'Widget Works connector for n8n — certified widgets, "sealed" groups and the `widget_id` lifecycle.';

/**
 * The markdown-cell encoding README.md.hbs applies via the `mdCell` helper
 * (Story 18.4 / FR62). Written out longhand here rather than imported so the
 * test pins the CONTRACT, not the implementation: a change to the helper that
 * is not also a deliberate change to the published table turns this red.
 */
function mdCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Split a rendered markdown table row on UNESCAPED pipes, trimming each cell. */
function splitMarkdownRow(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

async function seedFixture(): Promise<{
  repoRoot: string;
  packageDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-fidelity-'));
  const packageDir = path.join(repoRoot, 'pending-to-publish', 'authored-text');
  await fs.mkdir(packageDir, { recursive: true });

  const distribution = {
    distribution_schema_version: 1,
    reverse_dns_name: 'io.github.test/authored-text',
    npm_scope: '@g-digital',
    npm_package_name: '@g-digital/mcp-authored-text',
    docker_image_name: 'gdigital/authored-text',
    n8n_adapter_target_name: 'n8n-nodes-authored-text',
    n8n_connector_display_name: 'Widget Works',
    n8n_connector_description: AUTHORED_NODE_DESCRIPTION,
    license: 'MIT',
    credential_help_url: 'https://example.com',
    target_overrides: {},
  };
  await fs.writeFile(path.join(packageDir, '.distribution.yaml'), yaml.dump(distribution));

  const registry = {
    pipeline_version: 1,
    mcp_schema_version: '2025-12-11',
    n8n_node_api_version: '1.0',
    mcps: { 'authored-text': { repo_url: 'https://github.com/test/test-mcp' } },
  };
  await fs.writeFile(path.join(repoRoot, 'mcp-pipeline.yaml'), yaml.dump(registry));

  const serverJson = {
    name: distribution.reverse_dns_name,
    description: 'Should never win — .distribution.yaml#n8n_connector_description does.',
    version: '1.0.0',
    repository: { source: 'github', url: 'https://github.com/test/test-mcp' },
    packages: [
      {
        identifier: distribution.npm_package_name,
        registryType: 'npm',
        transport: { type: 'stdio' },
        version: '1.0.0',
        environmentVariables: POST_E18_ENV_VARS,
      },
    ],
  };
  await fs.writeFile(path.join(packageDir, 'server.json'), JSON.stringify(serverJson, null, 2));

  // REST annotations so the stub's tools are REST-capable operations
  // (non-REST stubs are omitted from the node — Epic 12 REST-direct).
  const toolsDir = path.join(packageDir, 'src', 'tools');
  await fs.mkdir(toolsDir, { recursive: true });
  const annotations: Record<string, string> = {
    get_widget: '// n8n-http: GET /widgets/{widget_id}',
    list_widgets: '// n8n-http: GET /widgets',
    submit_widget: '// n8n-http: POST /widgets',
  };
  for (const [tool, header] of Object.entries(annotations)) {
    await fs.writeFile(path.join(toolsDir, `${tool}.ts`), `${header}\nexport {};\n`);
  }

  return {
    repoRoot,
    packageDir,
    cleanup: async () => fs.rm(repoRoot, { recursive: true, force: true }),
  };
}

describe('authored text survives build → generate byte-identically (FR62)', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    vi.restoreAllMocks();
  });

  it('renders the spec verbatim with a model-provider key in the environment and never calls out', async () => {
    // A key in the environment must change nothing. Before Story 18.3 this
    // sentinel would have triggered a live Anthropic call and a rewrite.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-sentinel-must-not-be-used';
    // buildN8nNodeSpec reaches the MCP over stdio (a spawned subprocess), so
    // no step of this chain has a legitimate reason to use fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { repoRoot, packageDir, cleanup } = await seedFixture();
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-fidelity-out-'));
    try {
      const { spec } = await buildN8nNodeSpec({
        repoRoot,
        packageDir,
        mcpName: 'authored-text',
        version: '1.0.0',
        inspectorCommand: process.execPath,
        inspectorArgs: [AUTHORED_TEXT_STUB],
        inspectorTimeoutMs: 10_000,
      });
      await generateN8nNode({ spec, outputDir });

      expect(fetchSpy).not.toHaveBeenCalled();

      // Sanity: the fixture really does carry the re-encode canaries, so a
      // green assertion below is not green on trivially-safe ASCII.
      expect(spec.description).toBe(AUTHORED_NODE_DESCRIPTION);
      expect(spec.operations).toHaveLength(3);
      const getWidget = spec.operations.find((o) => o.name === 'get_widget')!;
      expect(getWidget.description).toContain('—');
      expect(getWidget.description).toContain('"canonical"');
      // The one legitimate transform on this surface: normalizeIdCasing
      // rewrote the authored `` `id` `` to `` `ID` `` (AC4). It is applied
      // BEFORE the spec exists, so spec → file is still byte-identical.
      expect(getWidget.description).toContain('`ID`');
      // Story 18.4: the fixture also carries the character that separates an
      // ENCODING from a SUBSTITUTION — a literal markdown cell delimiter.
      expect(getWidget.description).toContain('COMPLETED|IN_PROCESS|ERROR');

      // ── README operations table (README.md.hbs:38) ──────────────────────
      // README is outside the ESLint file set (normalize-generated-node.ts
      // runs over package.json + nodes/ + credentials/ only). Story 18.4:
      // the cell is the ONE surface whose syntax the raw text collides with,
      // so it is escaped for markdown — `mdCell` — and nothing else. The
      // inverse of the escape restores the authored bytes exactly; there is
      // no truncation, no summary and no substitution (FR62).
      const readme = await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');
      for (const op of spec.operations) {
        expect(readme).toContain(`| \`${op.name}\` | ${mdCell(op.description)} |`);
      }
      // ── README credentials table (README.md.hbs:48) ─────────────────────
      for (const cred of spec.credentials) {
        const desc = cred.description ? mdCell(cred.description) : '—';
        const secret = cred.isSecret ? 'yes' : 'no';
        expect(readme).toContain(`| \`${cred.envName}\` | ${desc} | ${secret} |`);
      }
      // The assertion that actually proves the fix: a `toContain` on the
      // escaped string still passes on a row that is malformed elsewhere.
      // Split the row on UNESCAPED pipes and demand exactly two cells.
      const getWidgetRow = readme
        .split('\n')
        .find((line) => line.startsWith('| `get_widget` |'))!;
      expect(getWidgetRow, 'get_widget row missing from the README table').toBeDefined();
      expect(splitMarkdownRow(getWidgetRow)).toEqual([
        '`get_widget`',
        mdCell(getWidget.description),
      ]);

      // ── Node class description (node.ts.hbs:37) ────────────────────────
      const nodeSrc = await fs.readFile(
        path.join(outputDir, 'nodes', spec.className, `${spec.className}.node.ts`),
        'utf8',
      );
      expect(nodeSrc).toContain(`description: ${JSON.stringify(spec.description)}`);

      // ── Flat operation dropdown (node.ts.hbs:79-84) ────────────────────
      // 3 operations < the 8-operation threshold, so `resources` is
      // undefined and the flat branch renders (build-node-spec.ts:1088).
      expect(spec.resources).toBeUndefined();
      for (const op of spec.operations) {
        expect(nodeSrc).toContain(`description: ${JSON.stringify(op.description)}`);
        expect(nodeSrc).toContain(`name: ${JSON.stringify(op.displayName)}`);
        expect(nodeSrc).toContain(`action: ${JSON.stringify(op.displayName)}`);
      }

      // ── Credentials class (credentials.ts.hbs:52, :58) ─────────────────
      // displayName is interpolated inside SINGLE quotes; description goes
      // through the `json` helper. Each surface asserted in its own encoding.
      const credsSrc = await fs.readFile(
        path.join(outputDir, 'credentials', `${spec.credentialClassName}.credentials.ts`),
        'utf8',
      );
      expect(spec.credentials.length).toBeGreaterThan(0);
      for (const cred of spec.credentials) {
        expect(credsSrc).toContain(`displayName: '${cred.displayName}'`);
        if (cred.description) {
          expect(credsSrc).toContain(`description: ${JSON.stringify(cred.description)}`);
        }
      }
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
      await cleanup();
    }
  }, 30_000);

  it('emits the same bytes with the key unset as with it set', async () => {
    const render = async (apiKey: string | undefined): Promise<Map<string, string>> => {
      if (apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = apiKey;
      const { repoRoot, packageDir, cleanup } = await seedFixture();
      const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8n-fidelity-cmp-'));
      try {
        const { spec } = await buildN8nNodeSpec({
          repoRoot,
          packageDir,
          mcpName: 'authored-text',
          version: '1.0.0',
          inspectorCommand: process.execPath,
          inspectorArgs: [AUTHORED_TEXT_STUB],
          inspectorTimeoutMs: 10_000,
        });
        const { filesWritten } = await generateN8nNode({ spec, outputDir });
        const contents = new Map<string, string>();
        for (const rel of filesWritten) {
          contents.set(rel, await fs.readFile(path.join(outputDir, rel), 'utf8'));
        }
        return contents;
      } finally {
        await fs.rm(outputDir, { recursive: true, force: true });
        await cleanup();
      }
    };

    const withKey = await render('sk-ant-sentinel-must-not-be-used');
    const withoutKey = await render(undefined);
    expect([...withoutKey.keys()].sort()).toEqual([...withKey.keys()].sort());
    for (const [rel, content] of withKey) {
      expect(withoutKey.get(rel), `${rel} differs depending on ANTHROPIC_API_KEY`).toBe(content);
    }
  }, 60_000);
});
