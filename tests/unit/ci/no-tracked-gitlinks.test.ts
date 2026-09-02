import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the 2026-09-02 cleanup (action A5 of the Epic 17 retrospective).
 *
 * `pending-to-publish/{ead-enterprise-suite,ead-factory,gocertius}` were tracked as
 * bare gitlinks (mode 160000) with no `.gitmodules` entry. Consequences, all of them
 * quiet rather than loud:
 *   * a clean checkout reported three modified paths forever, so `git status` stopped
 *     being a usable signal before a release;
 *   * every `actions/checkout` step logged `fatal: No url found for submodule path
 *     'pending-to-publish/<mcp>' in .gitmodules` and exited 128;
 *   * a commit made from this repo captured a pointer instead of the artifacts — the
 *     v1.0-layout residue behind the /prep-mcp bug fixed in #241.
 *
 * Nothing in CI needs them: every MCP in mcp-pipeline.yaml has a `repo_url`, and
 * `actions/checkout-mcp-source` clones the source repo over the directory on each run.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('git index hygiene', () => {
  it('tracks no gitlinks (mode 160000) anywhere', () => {
    // Fails loudly if git is unavailable rather than skipping: a check that cannot run
    // must not report success (Story 15.1's lesson, applied to this test).
    const listing = execFileSync('git', ['ls-files', '-s'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    const gitlinks = listing
      .split('\n')
      .filter((line) => line.startsWith('160000'))
      .map((line) => line.split('\t')[1] ?? line);
    expect(gitlinks, `tracked gitlinks: ${gitlinks.join(', ')}`).toEqual([]);
  });

  it('ignores the per-MCP source clones, so they cannot be re-added by accident', async () => {
    const gitignore = await fs.readFile(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('pending-to-publish/*/');
  });
});
