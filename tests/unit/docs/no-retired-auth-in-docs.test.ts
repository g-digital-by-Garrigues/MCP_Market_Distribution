import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Story 18.6 (AC8): our own prose must not keep teaching the flow the server
// deleted. Epic 18 collapsed GoCertius and EAD Enterprise Suite to a single
// upstream credential — MCP_AUTH_EMAIL, MCP_AUTH_PASSWORD, MCP_AUTH_JWT and
// MCP_OPENID_REFRESH_TOKEN are declared by NO emitted `.env.example` on any of
// the three products. A doc that names one of them is telling an operator (or,
// in docs/n8n-agent-workflows/, an LLM) to configure a variable that does not
// exist.
//
// Scope is four exact variable names and nothing else. Deliberately NOT the
// bare words `email` / `password`: docs/runbooks/mcp-catalog-credentials-form.md
// legitimately asks for the submitter's email address and the agent prompt has a
// `notification_receiver_add(email: …)` parameter. A doc-lint with false
// positives gets skipped, and a skipped lint enforces nothing.
//
// ESCAPE HATCH: a line that also carries the marker token below is allowed, so a
// genuinely historical reference (a dated amendment in an ADR, say) can name the
// retired variable without disabling the check for the whole file. Use it on the
// single line that needs it, never as a file-level opt-out.

const HISTORY_MARKER = '<!-- retired-auth-history -->';

const RETIRED_AUTH_VARS = [
  'MCP_AUTH_EMAIL',
  'MCP_AUTH_PASSWORD',
  'MCP_AUTH_JWT',
  'MCP_OPENID_REFRESH_TOKEN',
] as const;

const RETIRED_AUTH_RE = new RegExp(RETIRED_AUTH_VARS.join('|'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const docsDir = path.join(repoRoot, 'docs');

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(e.parentPath ?? dir, e.name))
    .sort();
}

describe('docs/ does not teach the retired auth flow (Story 18.6, AC8)', () => {
  it('names no retired auth variable outside a marked history line', async () => {
    const files = await listMarkdownFiles(docsDir);
    // Guard against a silent pass if the walk ever stops finding anything.
    expect(files.length).toBeGreaterThan(5);

    const offences: string[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      content.split('\n').forEach((line, i) => {
        if (!RETIRED_AUTH_RE.test(line)) return;
        if (line.includes(HISTORY_MARKER)) return;
        const named = RETIRED_AUTH_VARS.filter((v) => line.includes(v)).join(', ');
        offences.push(`${path.relative(repoRoot, file)}:${i + 1} — ${named}`);
      });
    }

    expect(
      offences,
      `These docs name a variable no emitted .env.example declares any more.\n` +
        `Rewrite the line against the emitted contract, or — if the reference is ` +
        `genuinely historical — append the marker ${HISTORY_MARKER} to that line.\n` +
        offences.join('\n'),
    ).toEqual([]);
  });

  it('honours the history marker on an otherwise-offending line', () => {
    const line = `Before Epic 18 the credential carried MCP_AUTH_PASSWORD. ${HISTORY_MARKER}`;
    expect(RETIRED_AUTH_RE.test(line)).toBe(true);
    expect(line.includes(HISTORY_MARKER)).toBe(true);
  });
});
