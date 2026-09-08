import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkReleaseTagRef,
  releaseTagRef,
} from '../../../src/ci/verify-release-tag-ref.js';
import { writeTestConfig } from '../../helpers/write-test-config.js';

// Epic 18 review (F14): the `github-release` job rebuilt the tag as
// `TAG="v$MCP_VERSION"` instead of reusing the ref `setup` had already computed
// and cloned. `git_tag_prefix` is per-product in the generator-owned
// `.distribution.yaml` ('ead-factory-v' is a legal value), so a non-`v` product
// would have failed `gh release create --verify-tag` AFTER npm, Docker Hub, the
// registry, Smithery and n8n had all published.

describe('releaseTagRef', () => {
  it('defaults to the "v" prefix', () => {
    expect(releaseTagRef('1.3.2')).toBe('v1.3.2');
  });

  it('honours a declared per-product prefix', () => {
    expect(releaseTagRef('1.3.2', 'ead-factory-v')).toBe('ead-factory-v1.3.2');
  });
});

describe('checkReleaseTagRef', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tag-ref-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('passes when the product declares no prefix and the ref is v<version>', async () => {
    await writeTestConfig({ repoRoot, mcpName: 'ead-factory' });
    const report = await checkReleaseTagRef({
      repoRoot,
      mcpName: 'ead-factory',
      version: '1.3.2',
      actualRef: 'v1.3.2',
    });
    expect(report.ok).toBe(true);
    expect(report.declaredPrefix).toBe('v');
    expect(report.expectedRef).toBe('v1.3.2');
  });

  it('passes when the declared prefix matches the resolved ref', async () => {
    await writeTestConfig({
      repoRoot,
      mcpName: 'ead-factory',
      distributionOverrides: { git_tag_prefix: 'ead-factory-v' },
    });
    const report = await checkReleaseTagRef({
      repoRoot,
      mcpName: 'ead-factory',
      version: '1.3.2',
      actualRef: 'ead-factory-v1.3.2',
    });
    expect(report.ok).toBe(true);
  });

  it('fails in setup — not after publishing — when the declared prefix is not the resolved ref', async () => {
    await writeTestConfig({
      repoRoot,
      mcpName: 'ead-factory',
      distributionOverrides: { git_tag_prefix: 'ead-factory-v' },
    });
    const report = await checkReleaseTagRef({
      repoRoot,
      mcpName: 'ead-factory',
      version: '1.3.2',
      actualRef: 'v1.3.2',
    });
    expect(report.ok).toBe(false);
    expect(report.expectedRef).toBe('ead-factory-v1.3.2');
    expect(report.problems.join(' ')).toContain('ead-factory-v1.3.2');
  });

  it('fails closed when the contract cannot be read at all', async () => {
    await writeTestConfig({ repoRoot, mcpName: 'ead-factory', skipDistribution: true });
    const report = await checkReleaseTagRef({
      repoRoot,
      mcpName: 'ead-factory',
      version: '1.3.2',
      actualRef: 'v1.3.2',
    });
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('.distribution.yaml');
  });
});
