import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  classifyReleaseStatus,
  generateReleaseReport,
  releaseReportMarker,
  type GenerateReleaseReportInput,
} from '../../../src/reporters/release-reporter.js';
import type { PublisherOutput } from '../../../src/schemas/publisher-output.schema.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'release-reports',
);

async function loadFixture(name: string): Promise<{ input: GenerateReleaseReportInput; expected: string }> {
  const input = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, `${name}.input.json`), 'utf8')) as GenerateReleaseReportInput;
  const expected = await fs.readFile(path.join(FIXTURES_DIR, `${name}.expected.md`), 'utf8');
  // Normalize CRLF that git on Windows may have applied during checkout —
  // the generator always emits LF.
  return { input, expected: expected.replace(/\r\n/g, '\n') };
}

describe('generateReleaseReport (byte-equality fixtures)', () => {
  it('renders an all-succeeded release as Status: ✅ Complete with alphabetical-target table', async () => {
    const { input, expected } = await loadFixture('complete');
    expect(generateReleaseReport(input)).toBe(expected);
  });

  it('renders a mixed-result release as Status: ⚠️ Partial (X of Y)', async () => {
    const { input, expected } = await loadFixture('partial');
    expect(generateReleaseReport(input)).toBe(expected);
  });

  it('renders a fully dry-run release with the **Status: DRY RUN** marker (not Complete)', async () => {
    const { input, expected } = await loadFixture('dry-run');
    expect(generateReleaseReport(input)).toBe(expected);
  });

  it('renders a multi-failed partial release with one Failures subsection per failed target', async () => {
    const { input, expected } = await loadFixture('multi-failed');
    expect(generateReleaseReport(input)).toBe(expected);
  });

  it('renders an all-failed release as ❌ Failed with one Failures subsection per target', async () => {
    const { input, expected } = await loadFixture('all-failed');
    expect(generateReleaseReport(input)).toBe(expected);
  });

  it('renders 6-succeeded + 1-skipped as ✅ Complete (skipped does NOT degrade status to Partial)', async () => {
    const { input, expected } = await loadFixture('one-skipped');
    expect(generateReleaseReport(input)).toBe(expected);
  });

  it("renders status='skipped' WITH version_published as ♻️ already-published (idempotency hit), distinct from intentional skip", () => {
    // Background: the `skipped` enum overloads two end states — an
    // intentional skip (publisher never ran; version_published === null,
    // e.g. smithery in v1.0) AND an idempotency hit (target already
    // had the version; version_published is set, e.g. mcp-publisher on
    // a retry that lands after the version is already in the registry).
    // Rendering both as "⏭ skipped" misled engineers reviewing the
    // ead-factory v1.0.5 + v1.0.6 reports — they read "mcp-publisher
    // skipped" and asked whether the registry actually carried the new
    // version (it did). The renderer now differentiates the two so the
    // audit trail is unambiguous.
    const md = generateReleaseReport({
      metadata: {
        mcp_name: 'ead-factory',
        version: '9.9.9',
        pipeline_run_id: 'r-1',
        workflow_run_url: 'https://example.invalid/r/1',
      },
      outputs: [
        {
          target: 'mcp-publisher',
          status: 'skipped',
          target_url: 'https://registry.modelcontextprotocol.io/v0/servers/io.github.g-digital-by-Garrigues/ead-factory',
          version_published: '9.9.9',
          duration_ms: 1200,
          attempts: 1,
          dry_run: false,
        },
        {
          target: 'smithery',
          status: 'skipped',
          target_url: 'https://example.invalid/skipped/smithery',
          version_published: null,
          duration_ms: 0,
          attempts: 1,
          dry_run: false,
        },
      ],
    });
    // Idempotency hit: ♻️ marker, registry url visible.
    expect(md).toContain('| mcp-publisher | ♻️ already-published |');
    // Intentional skip: ⏭ stays the same.
    expect(md).toContain('| smithery | ⏭ skipped |');
    // Status line stays Complete (both count as ok-side per classifyReleaseStatus).
    expect(md).toContain('**Status:** ✅ Complete');
  });

  it('is deterministic: same input emitted twice produces identical bytes', async () => {
    const { input } = await loadFixture('complete');
    const a = generateReleaseReport(input);
    const b = generateReleaseReport(input);
    expect(a).toBe(b);
  });

  it('row ordering is alphabetical-by-target regardless of input order', async () => {
    const { input } = await loadFixture('complete');
    const reversed: GenerateReleaseReportInput = {
      ...input,
      outputs: [...input.outputs].reverse(),
    };
    expect(generateReleaseReport(reversed)).toBe(generateReleaseReport(input));
  });
});

describe('classifyReleaseStatus', () => {
  function out(target: string, status: PublisherOutput['status'], dry_run = false): PublisherOutput {
    return {
      target,
      status,
      target_url: `https://example.invalid/${target}`,
      version_published: status === 'failed' ? null : '1.0.0',
      duration_ms: 1,
      attempts: 1,
      dry_run,
    };
  }

  it('empty array → failed (no successful publish happened)', () => {
    expect(classifyReleaseStatus([])).toBe('failed');
  });

  it('all succeeded → complete', () => {
    expect(classifyReleaseStatus([out('npm', 'succeeded'), out('docker-hub', 'succeeded')])).toBe('complete');
  });

  it('all succeeded + skipped → complete', () => {
    expect(classifyReleaseStatus([out('npm', 'succeeded'), out('docker-hub', 'skipped')])).toBe('complete');
  });

  it('all failed → failed', () => {
    expect(classifyReleaseStatus([out('npm', 'failed'), out('docker-hub', 'failed')])).toBe('failed');
  });

  it('one failed + one succeeded → partial', () => {
    expect(classifyReleaseStatus([out('npm', 'failed'), out('docker-hub', 'succeeded')])).toBe('partial');
  });

  it('EVERY output is dry_run → dry-run (overrides per-target status mix)', () => {
    expect(
      classifyReleaseStatus([out('npm', 'succeeded', true), out('docker-hub', 'succeeded', true)]),
    ).toBe('dry-run');
  });

  it('some dry_run, some not → does NOT classify as dry-run (it must be all-or-nothing)', () => {
    expect(
      classifyReleaseStatus([out('npm', 'succeeded', true), out('docker-hub', 'succeeded', false)]),
    ).toBe('complete');
  });
});

describe('releaseReportMarker', () => {
  it('produces a stable marker the PR-comment upserter (Story 3.6) can search for', () => {
    expect(releaseReportMarker('ead-factory', '1.0.0')).toBe('<!-- release-report:ead-factory-v1.0.0 -->');
  });

  it('marker is the first line of the generated report (so upserter find-by-startsWith works)', () => {
    const md = generateReleaseReport({
      metadata: {
        mcp_name: 'ead-factory',
        version: '2.0.0',
        pipeline_run_id: 'run-9',
        workflow_run_url: 'https://example.invalid/run/9',
      },
      outputs: [],
    });
    expect(md.startsWith('<!-- release-report:ead-factory-v2.0.0 -->')).toBe(true);
  });
});
