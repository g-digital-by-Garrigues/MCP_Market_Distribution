import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  N8N_UPGRADE_END,
  N8N_UPGRADE_START,
  RELEASE_NOTES_REL_PATH,
  ReleaseNotesError,
  parseReleaseNotes,
  readReleaseNotes,
} from '../../../src/utils/release-notes.js';

// Story 18.7 (AC5, AC9): one authored release note, two surfaces.
//
// The parser is the whole contract. It must never invent text (FR62) and must
// never half-succeed: an unbalanced marker pair, a blank span or a span that
// would break the connector README's outline is an error, not a warning.

const VALID = `# GoCertius MCP v2.0.0

Breaking. Read this before upgrading.

## The credential changed

\`MCP_AUTH_EMAIL\` is gone.

## Upgrading the n8n connector

${N8N_UPGRADE_START}
**Re-create the credential — editing it is not enough.**

### Fields

Two required fields.
${N8N_UPGRADE_END}
`;

describe('parseReleaseNotes (Story 18.7 AC5)', () => {
  it('strips both marker lines from the body and returns the span', () => {
    const parsed = parseReleaseNotes(VALID);
    expect(parsed.body).not.toContain(N8N_UPGRADE_START);
    expect(parsed.body).not.toContain(N8N_UPGRADE_END);
    // The authored text itself survives byte-for-byte in the body (FR62).
    expect(parsed.body).toContain('# GoCertius MCP v2.0.0');
    expect(parsed.body).toContain('**Re-create the credential — editing it is not enough.**');
    expect(parsed.n8nUpgrade).toBe(
      '**Re-create the credential — editing it is not enough.**\n\n### Fields\n\nTwo required fields.',
    );
  });

  it('treats a file with no markers at all as a legal server-only note', () => {
    const parsed = parseReleaseNotes('# v1.0.1\n\nA patch.\n');
    expect(parsed.n8nUpgrade).toBeUndefined();
    expect(parsed.body).toBe('# v1.0.1\n\nA patch.\n');
  });

  it('throws when START has no END', () => {
    expect(() => parseReleaseNotes(`# v2.0.0\n\n${N8N_UPGRADE_START}\nsomething\n`)).toThrow(
      ReleaseNotesError,
    );
  });

  it('throws when END appears before START', () => {
    expect(() =>
      parseReleaseNotes(`# v2.0.0\n\n${N8N_UPGRADE_END}\nsomething\n${N8N_UPGRADE_START}\n`),
    ).toThrow(ReleaseNotesError);
  });

  it('throws when END has no START', () => {
    expect(() => parseReleaseNotes(`# v2.0.0\n\n${N8N_UPGRADE_END}\n`)).toThrow(ReleaseNotesError);
  });

  it('throws on two START markers', () => {
    expect(() =>
      parseReleaseNotes(
        `# v2.0.0\n\n${N8N_UPGRADE_START}\na\n${N8N_UPGRADE_START}\nb\n${N8N_UPGRADE_END}\n`,
      ),
    ).toThrow(ReleaseNotesError);
  });

  it('throws on a blank span', () => {
    expect(() =>
      parseReleaseNotes(`# v2.0.0\n\n${N8N_UPGRADE_START}\n\n   \n${N8N_UPGRADE_END}\n`),
    ).toThrow(/blank/i);
  });

  it('throws when the span carries a level-1 heading, naming the offending line', () => {
    expect(() =>
      parseReleaseNotes(`# v2.0.0\n\n${N8N_UPGRADE_START}\n# Nope\ntext\n${N8N_UPGRADE_END}\n`),
    ).toThrow(/# Nope/);
  });

  it('throws when the span carries a level-2 heading, naming the offending line', () => {
    expect(() =>
      parseReleaseNotes(`# v2.0.0\n\n${N8N_UPGRADE_START}\n## Nope\ntext\n${N8N_UPGRADE_END}\n`),
    ).toThrow(/## Nope/);
  });

  it('accepts a level-3 heading inside the span', () => {
    const parsed = parseReleaseNotes(
      `# v2.0.0\n\n${N8N_UPGRADE_START}\n### Fine\ntext\n${N8N_UPGRADE_END}\n`,
    );
    expect(parsed.n8nUpgrade).toBe('### Fine\ntext');
  });

  it('exposes the first non-blank line so a stale note can be detected', () => {
    expect(parseReleaseNotes(VALID).firstLine).toBe('# GoCertius MCP v2.0.0');
    expect(parseReleaseNotes('\n\n  # v9.9.9  \n\nbody\n').firstLine).toBe('# v9.9.9');
  });
});

describe('readReleaseNotes (Story 18.7 AC5)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-notes-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('resolves undefined when the file is absent (not a throw)', async () => {
    await expect(readReleaseNotes(dir)).resolves.toBeUndefined();
  });

  it('reads and parses the file at .github/RELEASE_NOTES.md', async () => {
    expect(RELEASE_NOTES_REL_PATH).toBe('.github/RELEASE_NOTES.md');
    const target = path.join(dir, RELEASE_NOTES_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, VALID, 'utf8');
    const parsed = await readReleaseNotes(dir);
    expect(parsed?.n8nUpgrade).toContain('Re-create the credential');
  });

  it('propagates a ReleaseNotesError from a present-but-invalid file', async () => {
    const target = path.join(dir, RELEASE_NOTES_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `# v2.0.0\n\n${N8N_UPGRADE_START}\nunclosed\n`, 'utf8');
    await expect(readReleaseNotes(dir)).rejects.toBeInstanceOf(ReleaseNotesError);
  });
});
