import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPreflight } from '../../../src/setup/run-preflight.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

const MCP_NAME = 'ead-factory';
const REVERSE_DNS = 'io.github.g-digital-by-Garrigues/ead-factory';

async function seedFixture(opts: {
  withConfig?: boolean;
  withEntry?: boolean;
  withSource?: boolean;
  missing?: ('package.json' | 'LICENSE' | '.env.example' | 'README.md')[];
} = {}): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-'));
  if (opts.withConfig !== false) {
    // If withEntry is false, write the config under a different mcp name
    // so the lookup for `ead-factory` fails.
    const mcpName = opts.withEntry === false ? 'other-mcp' : MCP_NAME;
    await writeTestConfig({ repoRoot, mcpName });
  }
  if (opts.withSource !== false) {
    const mcpFolder = path.join(repoRoot, 'pending-to-publish', MCP_NAME);
    await fs.mkdir(mcpFolder, { recursive: true });
    const filesToWrite: Record<string, string> = {
      'package.json': JSON.stringify({ mcpName: REVERSE_DNS }, null, 2),
      LICENSE: 'MIT\n',
      '.env.example': '# example\nFOO=bar\n',
      'README.md': '# Evidence Manager\n',
    };
    for (const name of opts.missing ?? []) {
      delete filesToWrite[name];
    }
    for (const [name, content] of Object.entries(filesToWrite)) {
      await fs.writeFile(path.join(mcpFolder, name), content, 'utf8');
    }
  }
  return repoRoot;
}

describe('runPreflight', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('ready=true when config + source are complete', async () => {
    repoRoot = await seedFixture();
    const result = await runPreflight({ mcpName: 'ead-factory', repoRoot });
    expect(result.ready).toBe(true);
    expect(result.sourceReport.hasMissing).toBe(false);
  });

  it('ready=false and lists missing source elements with remediations', async () => {
    repoRoot = await seedFixture({ missing: ['.env.example', 'README.md'] });
    const result = await runPreflight({ mcpName: 'ead-factory', repoRoot });
    expect(result.ready).toBe(false);
    const missing = result.sourceReport.checks.filter((c) => c.status === 'missing');
    const names = missing.map((c) => c.name);
    expect(names).toContain('.env.example');
    expect(names).toContain('README');
    for (const item of missing) {
      expect(item.remediation).toBeTruthy();
    }
  });

  it('ready=false when mcp-pipeline.yaml is missing', async () => {
    repoRoot = await seedFixture({ withConfig: false });
    const result = await runPreflight({ mcpName: 'ead-factory', repoRoot });
    expect(result.ready).toBe(false);
    expect(result.configErrors.join(' ')).toMatch(/mcp-pipeline\.yaml not found/);
  });

  it('ready=false when the mcp-name has no entry in the config, listing available keys', async () => {
    repoRoot = await seedFixture({ withEntry: false });
    const result = await runPreflight({ mcpName: 'ead-factory', repoRoot });
    expect(result.ready).toBe(false);
    expect(result.configErrors.join(' ')).toMatch(/no entry for 'ead-factory'/);
  });
});
