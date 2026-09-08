import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 18.5 (AC6) — permanent tripwire.
//
// The contract boundary says a product's API host is generator-owned: the pipeline
// DISCOVERS it from the emitted source (`src/utils/read-emitted-env-defaults.ts`) and
// never carries it. The moment one of these appears under src/ or templates/, someone
// has pasted a constant instead of reading the contract.
//
// Deliberately narrow: only the four concrete API hosts, never a bare `gocertius` or
// `gcloudfactory`. `build-node-spec.ts` legitimately cites a
// `digitaltrust.gcloudfactory.com/...` documentation URL in a comment, and tests/
// legitimately carry `https://www.gocertius.io` as an emitted credential_help_url. A
// guard that needs an exemption list is a guard nobody trusts.
const FORBIDDEN_HOSTS = [
  'api-gocertius.gocertius.io',
  'api-eadcustody.eadtrust.gocertius.io',
  'api.gcloudfactory.com',
  'api.int.gcloudfactory.com',
] as const;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED_DIRS = ['src', 'templates'] as const;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('no product API host is a literal in the pipeline (AC6)', () => {
  it('finds none of the four product API hosts anywhere under src/ or templates/', async () => {
    const offenders: string[] = [];
    for (const dir of SCANNED_DIRS) {
      const root = path.join(REPO_ROOT, dir);
      for (const file of await walk(root)) {
        if (dir === 'src' && !file.endsWith('.ts')) continue;
        const content = await fs.readFile(file, 'utf8');
        for (const host of FORBIDDEN_HOSTS) {
          if (content.includes(host)) {
            offenders.push(`${path.relative(REPO_ROOT, file)} → ${host}`);
          }
        }
      }
    }
    expect(
      offenders,
      `A product API host must be discovered from the emitted source, never written into the pipeline:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('actually scans a non-trivial number of files (the guard cannot pass vacuously)', async () => {
    let count = 0;
    for (const dir of SCANNED_DIRS) {
      count += (await walk(path.join(REPO_ROOT, dir))).length;
    }
    expect(count).toBeGreaterThan(50);
  });
});
