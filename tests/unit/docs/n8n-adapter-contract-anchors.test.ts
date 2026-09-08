import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Epic 18 review (F18): `docs/n8n-adapter-contract.md` is declared the live
// specification for the credential code, and it cited that code by line number.
// Line numbers rotted INSIDE a single epic — Story 18.6 verified its anchors
// against the tree, then 18.7 added one import to `build-node-spec.ts` and one
// member to `types.ts` and every anchor below the insertion point was off. A
// citation a reader cannot follow is worth the same as no citation.
//
// The fix is a form change, not a re-verification: anchors are `file#token`,
// where the token is a literal string that must occur in the named file. This
// test is what makes that form worth anything — FR59, a check that cannot verify
// must fail. So:
//   - an anchor whose token is not in the file is an offence;
//   - an anchor naming a file this test cannot resolve is ALSO an offence (a new
//     anchor to an unmapped file must fail loudly, not be silently skipped);
//   - finding no anchors at all is an offence (the walk must not go quiet).
//
// Deliberately NOT checked: anchors into the three MCP source repos
// (`GoCertius_MCP:src/tools/profile_get.ts`, `EAD-Factory-MCP:.env.example`, the
// published `Gocertius.node.ts`). Those trees are read-only siblings that may not
// be checked out beside this repo, and a test that depends on them is a test that
// fails on CI for the wrong reason. Their citations carry no line numbers either,
// for the same rot reason.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT = path.join(repoRoot, 'docs/n8n-adapter-contract.md');

/** Basename → repo-relative path. Unknown basename = offence, never a skip. */
const FILES: Readonly<Record<string, string>> = {
  'build-node-spec.ts': 'src/adapters/n8n-adapter/build-node-spec.ts',
  'types.ts': 'src/adapters/n8n-adapter/types.ts',
  'generate-n8n-node.ts': 'src/adapters/n8n-adapter/generate-n8n-node.ts',
  'run-track-b-layer-1.ts': 'src/gates/run-track-b-layer-1.ts',
  'credentials.ts.hbs': 'templates/n8n-adapter/credentials.ts.hbs',
  'node.ts.hbs': 'templates/n8n-adapter/node.ts.hbs',
  'README.md.hbs': 'templates/n8n-adapter/README.md.hbs',
};

// `file#token` inside a single backtick span. The file part must end in .ts or
// .hbs, which is what keeps prose anchors like `MCP_API_BASE_URL#isRequired` and
// `.distribution.yaml#credential_help_url` out of scope.
const ANCHOR_RE = /`([A-Za-z0-9_.-]+\.(?:ts|hbs))#([^`]+)`/g;

describe('docs/n8n-adapter-contract.md cites code by symbol, and every anchor resolves', () => {
  let md: string;

  beforeAll(async () => {
    md = await fs.readFile(CONTRACT, 'utf8');
  });

  it('uses no `file:line` anchors — they rot on the next edit', () => {
    // Same shape as the good anchor, but with a line number after the colon.
    const rotting = md.match(/`[A-Za-z0-9_.-]+\.(?:ts|hbs):\d+[^`]*`/g) ?? [];
    expect(
      rotting,
      'Cite code as `file#token` (a literal string in the file), not `file:line`. ' +
        'The line form was already stale within the epic that introduced it.',
    ).toEqual([]);
  });

  it('resolves every `file#token` anchor against the file it names', async () => {
    const anchors = [...md.matchAll(ANCHOR_RE)].map((m) => ({ file: m[1]!, token: m[2]! }));
    expect(
      anchors.length,
      'no anchors found — either the doc stopped citing code or the regex stopped matching',
    ).toBeGreaterThan(10);

    const offences: string[] = [];
    const cache = new Map<string, string>();
    for (const { file, token } of anchors) {
      const rel = FILES[file];
      if (!rel) {
        offences.push(`\`${file}#${token}\` — no path known for ${file}; add it to FILES here`);
        continue;
      }
      let content = cache.get(rel);
      if (content === undefined) {
        content = await fs.readFile(path.join(repoRoot, rel), 'utf8');
        cache.set(rel, content);
      }
      if (!content.includes(token)) {
        offences.push(`\`${file}#${token}\` — ${rel} contains no such token`);
      }
    }

    expect(
      offences,
      'These citations no longer resolve. Fix the anchor (or the code), never delete the ' +
        'citation:\n' +
        offences.join('\n'),
    ).toEqual([]);
  });
});
