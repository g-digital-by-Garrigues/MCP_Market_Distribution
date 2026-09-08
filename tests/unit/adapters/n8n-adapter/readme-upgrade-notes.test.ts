import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateN8nNode } from '../../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import { parseReleaseNotes } from '../../../../src/utils/release-notes.js';
import { oauth2NodeSpec } from '../../../helpers/n8n-oauth2-spec.js';

// Story 18.7 (AC6, AC9): the connector README renders the authored n8n span, and
// a product with no note renders NOTHING — whitespace included.
//
// The zero-diff half is not decorative: `n8n-node/README.md` is committed into
// each source repo by `copyN8nNodeSource` and republished from `_n8n-adapter` at
// publish time, so a stray blank line is a real diff in a published artifact.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures/release-notes');

async function renderReadme(spec: Parameters<typeof generateN8nNode>[0]['spec']): Promise<string> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readme-notes-'));
  try {
    await generateN8nNode({ spec, outputDir });
    return await fs.readFile(path.join(outputDir, 'README.md'), 'utf8');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

async function n8nSpanOf(fixture: string): Promise<string> {
  const raw = await fs.readFile(path.join(fixturesDir, fixture), 'utf8');
  const span = parseReleaseNotes(raw).n8nUpgrade;
  expect(span, `${fixture} must carry an N8N_UPGRADE span`).toBeTruthy();
  return span!;
}

describe('README.md.hbs — no release note (EAD Factory) adds nothing', () => {
  // The golden pins EAD Factory's whole connector README. Epic 18 changes exactly
  // one row of it: the `API Base URL` cell now carries the AUTHORED description
  // from the emitted `.env.example` instead of pipeline-invented copy. Everything
  // else — the absent "Upgrading from 1.x" section included — is the pre-change
  // byte stream, which is what this golden exists to hold still.
  it('renders the golden byte-for-byte when upgradeNotes is absent', async () => {
    const golden = await fs.readFile(path.join(fixturesDir, 'no-notes-readme.golden.md'), 'utf8');
    const rendered = await renderReadme(oauth2NodeSpec());
    expect(rendered).toBe(golden);
  });

  it('emits no "Upgrading from 1.x" section and no stray blank line at the insertion point', async () => {
    const rendered = await renderReadme(oauth2NodeSpec());
    expect(rendered).not.toContain('Upgrading from 1.x');
    // The Credentials block runs straight into the next heading, exactly as before.
    expect(rendered).toContain(
      '](https://example.com/onboarding).\n\n## Use as an AI Agent tool',
    );
  });
});

describe('README.md.hbs — the authored 2.0.0 notes render verbatim (AC8)', () => {
  let gocertius: string;
  let suite: string;

  beforeEach(async () => {
    gocertius = await renderReadme({ ...oauth2NodeSpec(), upgradeNotes: await n8nSpanOf('gocertius-2.0.0.md') });
    suite = await renderReadme({ ...oauth2NodeSpec(), upgradeNotes: await n8nSpanOf('ead-enterprise-suite-2.0.0.md') });
  });

  afterEach(() => {
    gocertius = '';
    suite = '';
  });

  it('places the section under its own heading, after Credentials and before the AI Agent block', () => {
    for (const readme of [gocertius, suite]) {
      expect(readme).toContain('## Upgrading from 1.x');
      expect(readme.indexOf('## Credentials')).toBeLessThan(readme.indexOf('## Upgrading from 1.x'));
      expect(readme.indexOf('## Upgrading from 1.x')).toBeLessThan(
        readme.indexOf('## Use as an AI Agent tool'),
      );
    }
  });

  it('carries the credential break on both products', () => {
    for (const readme of [gocertius, suite]) {
      expect(readme).toContain('MCP_AUTH_USER_KEY');
      expect(readme).toContain('MCP_API_BASE_URL');
      expect(readme.toLowerCase()).toContain('re-create');
    }
  });

  it('keeps the authored pipes intact — the section is not mdCell-encoded', () => {
    // mdCell escapes every '|'. A section is not a table cell; if it were run
    // through the helper, the note's own tables would render as literal text.
    expect(gocertius).not.toContain('\\|');
    expect(gocertius).toContain('| **API Base URL** (`MCP_API_BASE_URL`) |');
  });

  it('carries the two re-pointed signature operations on the Suite only', () => {
    expect(suite).toContain('Signature Document List');
    expect(suite).toContain('Signature Participant List');
    expect(suite).toContain('Signature Document Signatory List');
    expect(suite).toContain('Signature Document Observer List');
    expect(suite).toContain('Document Id');
    // The input is gone; the note must not present it as one that still exists.
    expect(suite).not.toContain('documentId');
    expect(gocertius).not.toContain('Signature Document Signatory List');
  });

  // Epic 18 review (F2): Story 18.4 renamed an OUTPUT field of an operation that is
  // ALREADY PUBLISHED — signature_participant_create injected `signatoryId` for every
  // role, including VALIDATOR and OBSERVER. The rename to `participantId` (+ the
  // role-specific alias) is the fix, not the break; but a saved workflow reading
  // $json.signatoryId after creating a validator changes behaviour, and the n8n span
  // is the one surface built to carry exactly that. It used to assert the opposite.
  it('names the Signature Participant Create output-field rename (Suite only)', () => {
    expect(suite).toContain('participantId');
    expect(suite).toContain('validatorId');
    expect(suite).toContain('$json.signatoryId');
    // The blanket "nothing else moved" claim is gone: it was false the moment 18.4
    // landed, and it is the sentence a reader would have trusted instead of testing.
    expect(suite).not.toContain('Apart from the two above');
    // GoCertius has no signature tools at all — the break must not leak into its note.
    expect(gocertius).not.toContain('participantId');
  });

  it('does not bury either Suite break inside the other — same weight, same level', async () => {
    const span = await n8nSpanOf('ead-enterprise-suite-2.0.0.md');
    // Both breaks are top-level bold lead-ins in the span: neither is indented
    // under the other, and neither is a sub-bullet of the other.
    const credential = span.split('\n').findIndex((l) => l.startsWith('**Re-create the credential'));
    const signature = span.split('\n').findIndex((l) => l.startsWith('**Two operations changed target'));
    expect(credential).toBeGreaterThanOrEqual(0);
    expect(signature).toBeGreaterThanOrEqual(0);
    expect(credential).not.toBe(signature);
  });
});

describe('the 2.0.0 notes say what they must, and not what they must not (AC8)', () => {
  const RETIRED = ['MCP_AUTH_EMAIL', 'MCP_AUTH_PASSWORD', 'MCP_AUTH_JWT'] as const;

  for (const fixture of ['gocertius-2.0.0.md', 'ead-enterprise-suite-2.0.0.md']) {
    it(`${fixture}: names the retired variables only on the "these are gone" line`, async () => {
      const raw = await fs.readFile(path.join(fixturesDir, fixture), 'utf8');
      const offending = raw
        .split('\n')
        .filter((l) => RETIRED.some((v) => l.includes(v)))
        .filter((l) => !l.includes('are gone'));
      expect(offending).toEqual([]);
    });

    it(`${fixture}: quotes the user-key clause only — no service-account flow`, async () => {
      const raw = await fs.readFile(path.join(fixturesDir, fixture), 'utf8');
      // The server's own remediation string names MCP_SVC_TOKEN_URL, but neither
      // product's .env.example declares it. The note trims what it quotes; the
      // divergence goes to the generation team, not into a patch of their src/.
      expect(raw).not.toContain('MCP_SVC_TOKEN_URL');
      expect(raw).toContain('a user key (MCP_AUTH_USER_KEY), then retry.');
    });

    it(`${fixture}: states MCP_API_BASE_URL is required and not secret`, async () => {
      const raw = await fs.readFile(path.join(fixturesDir, fixture), 'utf8');
      expect(raw).toMatch(/\|\s*`MCP_API_BASE_URL`\s*\|\s*no\s*\|/);
      expect(raw).toMatch(/\|\s*`MCP_AUTH_USER_KEY`\s*\|\s*yes\s*\|/);
      expect(raw).toContain('**not** credentials');
    });

    it(`${fixture}: the two 2.0.0 breaks are siblings at the same heading level`, async () => {
      const raw = await fs.readFile(path.join(fixturesDir, fixture), 'utf8');
      const h2 = raw.split('\n').filter((l) => l.startsWith('## '));
      expect(h2).toContain('## The credential changed');
      if (fixture.startsWith('ead-enterprise-suite')) {
        expect(h2).toContain('## Two signature operations now call a different endpoint');
      }
      // Every section of the note is a level-2 sibling under the single title.
      expect(raw.split('\n').filter((l) => l.startsWith('# ')).length).toBe(1);
    });
  }

  it('re-derived counts match the emitted source at origin/main', async () => {
    const goc = await fs.readFile(path.join(fixturesDir, 'gocertius-2.0.0.md'), 'utf8');
    const suite = await fs.readFile(path.join(fixturesDir, 'ead-enterprise-suite-2.0.0.md'), 'utf8');
    expect(goc).toContain('62 tools, up from 41.');
    expect(goc).toContain('**58 operations, up from 39.**');
    expect(suite).toContain('86 tools, up from 52.');
    expect(suite).toContain('**82 operations, up from 50.**');
  });
});
