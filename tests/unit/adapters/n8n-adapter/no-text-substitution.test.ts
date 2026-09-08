import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Story 18.3 (FR62) reintroduction guard.
//
// FR62: generation's authored text reaches every published surface
// byte-identical — the pipeline does not invent, summarise, truncate or
// substitute it. The n8n adapter used to run an optional LLM "refine" pass
// (refine-with-llm.ts) that rewrote the node description, the operation
// descriptions and the credential labels whenever ANTHROPIC_API_KEY happened
// to be exported. That module is deleted; this test is what stops it — or any
// successor pointed at another model provider — from coming back.
//
// Scope note: the scan is deliberately limited to `src/adapters/n8n-adapter/`.
// `tests/` necessarily carries these literals (this file included) and `dist/`
// can carry a stale compiled artefact that `tsc -p tsconfig.build.json` does
// not prune, so scanning either would make the guard self-tripping rather
// than load-bearing.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const ADAPTER_DIR = path.join(REPO_ROOT, 'src', 'adapters', 'n8n-adapter');

const MODEL_PROVIDER_HOST_RE = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/;
const MODEL_PROVIDER_KEY_RE = /\bANTHROPIC_API_KEY\b|\bOPENAI_API_KEY\b/;

const WHY =
  'FR62: authored text reaches every published surface byte-identical — the pipeline ' +
  'does not invent, summarise, truncate or substitute it. A model-provider host or API ' +
  'key inside the n8n adapter means some published string can be rewritten depending on ' +
  'whether a secret happened to be in the environment. Story 18.3 deleted that pass ' +
  '(refine-with-llm.ts); do not reintroduce it.';

async function adapterTsFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full.endsWith('.ts')) {
        out.push(full);
      }
    }
  };
  await walk(ADAPTER_DIR);
  return out.sort();
}

describe('n8n adapter never substitutes authored text (FR62 guard)', () => {
  it('has no refine-with-llm module', async () => {
    const entries = await fs.readdir(ADAPTER_DIR);
    expect(
      entries.filter((e) => e.startsWith('refine-with-llm')),
      `refine-with-llm is back under src/adapters/n8n-adapter/. ${WHY}`,
    ).toEqual([]);
  });

  it('references no model-provider host in any src/adapters/n8n-adapter/*.ts', async () => {
    const offenders: string[] = [];
    for (const file of await adapterTsFiles()) {
      const content = await fs.readFile(file, 'utf8');
      const match = MODEL_PROVIDER_HOST_RE.exec(content);
      if (match) offenders.push(`${path.relative(REPO_ROOT, file)} → ${match[0]}`);
    }
    expect(offenders, `Model-provider endpoint(s) in the n8n adapter. ${WHY}`).toEqual([]);
  });

  it('references no model-provider API-key env var in any src/adapters/n8n-adapter/*.ts', async () => {
    const offenders: string[] = [];
    for (const file of await adapterTsFiles()) {
      const content = await fs.readFile(file, 'utf8');
      const match = MODEL_PROVIDER_KEY_RE.exec(content);
      if (match) offenders.push(`${path.relative(REPO_ROOT, file)} → ${match[0]}`);
    }
    expect(offenders, `Model-provider API key in the n8n adapter. ${WHY}`).toEqual([]);
  });

  it('scans a non-empty file set (the guard is not vacuously green)', async () => {
    expect((await adapterTsFiles()).length).toBeGreaterThan(5);
  });
});
