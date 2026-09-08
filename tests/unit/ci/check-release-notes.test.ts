import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  checkReleaseNotes,
  firstLineNamesVersion,
  minimalNote,
  runCli,
} from '../../../src/ci/check-release-notes.js';
import { RELEASE_NOTES_REL_PATH, parseReleaseNotes } from '../../../src/utils/release-notes.js';

// Story 18.7 (AC7): the check that runs in `setup`, before any publisher.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures/release-notes');

describe('checkReleaseNotes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-notes-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(content: string): Promise<void> {
    const target = path.join(dir, RELEASE_NOTES_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  it('fails when the note is absent — an optional surface stays empty', async () => {
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.ok).toBe(false);
    expect(report.present).toBe(false);
    expect(report.problems.join(' ')).toContain(RELEASE_NOTES_REL_PATH);
  });

  it('fails when the note is present but unparseable', async () => {
    await write('# v2.0.0\n\n<!-- N8N_UPGRADE -->\nunclosed\n');
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.ok).toBe(false);
    expect(report.present).toBe(true);
    expect(report.parsed).toBe(false);
  });

  it('fails on a stale note left over from the previous release', async () => {
    await write('# GoCertius MCP v1.9.0\n\nOld news.\n');
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.ok).toBe(false);
    expect(report.namesVersion).toBe(false);
    expect(report.problems.join(' ')).toContain('v2.0.0');
  });

  it('passes the real 2.0.0 fixture', async () => {
    await write(await fs.readFile(path.join(fixturesDir, 'gocertius-2.0.0.md'), 'utf8'));
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.ok).toBe(true);
    expect(report.hasN8nUpgrade).toBe(true);
    expect(report.firstLine).toBe('# GoCertius MCP v2.0.0');
  });

  // Epic 18 review (F8/F10): `hasN8nUpgrade` used to be computed, reported and
  // then thrown away — `ok` was decided by the version check alone. A note with
  // no span passed, and the connector README shipped its "Upgrading from 1.x"
  // section EMPTY on a breaking release. FR59: a gate that cannot verify fails.
  it('fails a markerless note — the connector section would ship empty', async () => {
    await write('# v2.0.0\n\nServer-only change.\n');
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.hasN8nUpgrade).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('N8N_UPGRADE');
  });

  it('reports BOTH problems when the note is stale AND markerless', async () => {
    await write('# v1.9.0\n\nOld news.\n');
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.problems).toHaveLength(2);
  });

  // Epic 18 review (F6): `firstLine.includes('v2.0.0')` is true of a
  // `# v2.0.0-rc.1` note, so a left-behind RC note would have shipped verbatim
  // as the GA Release body and as the connector's upgrade section.
  it('rejects a release-candidate note left behind at the GA version', async () => {
    await write(minimalNote('2.0.0').replace('# v2.0.0', '# v2.0.0-rc.1'));
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.namesVersion).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('rejects a longer version that merely starts with the expected one', async () => {
    await write(minimalNote('1.2.3').replace('# v1.2.3', '# v1.2.30'));
    const report = await checkReleaseNotes(dir, '1.2.3');
    expect(report.ok).toBe(false);
  });

  it('matches the version on a boundary, not as a substring', () => {
    expect(firstLineNamesVersion('# GoCertius MCP v2.0.0', '2.0.0')).toBe(true);
    expect(firstLineNamesVersion('# v2.0.0 — the user key release', '2.0.0')).toBe(true);
    expect(firstLineNamesVersion('# v2.0.0.', '2.0.0')).toBe(true);
    expect(firstLineNamesVersion('# v2.0.0-rc.1', '2.0.0')).toBe(false);
    expect(firstLineNamesVersion('# v2.0.0+build.5', '2.0.0')).toBe(false);
    expect(firstLineNamesVersion('# v1.2.30', '1.2.3')).toBe(false);
    expect(firstLineNamesVersion('# rev2.0.0', '2.0.0')).toBe(false);
    // A pre-release publish must still be able to name itself.
    expect(firstLineNamesVersion('# v2.0.0-rc.1', '2.0.0-rc.1')).toBe(true);
    expect(firstLineNamesVersion('# v2.0.0', '2.0.0-rc.1')).toBe(false);
  });

  it('emits a minimal note that itself passes every rule', async () => {
    await write(minimalNote('2.0.0'));
    const report = await checkReleaseNotes(dir, '2.0.0');
    expect(report.ok).toBe(true);
    expect(parseReleaseNotes(minimalNote('2.0.0')).n8nUpgrade).toBeTruthy();
  });
});

// Epic 18 review (F4): the `setup` gate was hard-fail on every non-dry-run, and
// `/retry-publish` dispatches with `dry_run: 'false'`. Every tag published
// before Epic 18 lacks `.github/RELEASE_NOTES.md`, and the file must ride the
// tag — so retrying ONE failed publisher on ANY existing release was impossible
// without re-tagging a published version, which the runbook forbids. The retry
// path now dispatches `release_note_check: advisory`, which reaches the CLI as
// `--advisory`: same report, same problems, exit 0, and no invented body.
describe('check-release-notes CLI', () => {
  const execFileAsync = promisify(execFile);
  let dir: string;
  let stdout: string;
  let stderr: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'check-notes-cli-'));
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeNote(content: string): Promise<void> {
    const target = path.join(dir, RELEASE_NOTES_REL_PATH);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  it('exits 1 on a missing note by default — the fresh-publish path stays fail-closed', async () => {
    expect(await runCli([dir, '2.0.0'])).toBe(1);
    expect(JSON.parse(stdout).ok).toBe(false);
    expect(stderr).toContain('check-release-notes');
  });

  it('exits 0 on a missing note with --advisory, so a retry of a published tag still runs', async () => {
    expect(await runCli([dir, '2.0.0', '--advisory'])).toBe(0);
    // The signal survives: the caller reads `.ok`, not the exit code.
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it('writes no body in advisory mode when the note is unusable — never invents one', async () => {
    const bodyPath = path.join(dir, 'release-body.md');
    expect(await runCli([dir, '2.0.0', '--advisory', '--emit-body', bodyPath])).toBe(0);
    await expect(fs.access(bodyPath)).rejects.toThrow();
  });

  it('writes the body when the note is good, in either mode', async () => {
    await writeNote(minimalNote('2.0.0'));
    const bodyPath = path.join(dir, 'release-body.md');
    expect(await runCli([dir, '2.0.0', '--advisory', '--emit-body', bodyPath])).toBe(0);
    expect(await fs.readFile(bodyPath, 'utf8')).toContain('Nothing to do in n8n');
    expect(await runCli([dir, '2.0.0', '--emit-body', bodyPath])).toBe(0);
  });

  it('exits 2 on a usage error, which is neither a pass nor a note problem', async () => {
    expect(await runCli([dir])).toBe(2);
  });

  // One real spawn, so the exported function above is not the only thing that
  // has ever been proved: `process.exit(code)` really carries the exit code the
  // workflow branches on.
  it('propagates the exit code through the real process boundary', async () => {
    await expect(
      execFileAsync('pnpm', ['tsx', 'src/ci/check-release-notes.ts', dir, '2.0.0'], {
        cwd: repoRoot,
      }),
    ).rejects.toMatchObject({ code: 1 });
  }, 30_000);
});
