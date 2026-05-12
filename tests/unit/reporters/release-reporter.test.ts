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
