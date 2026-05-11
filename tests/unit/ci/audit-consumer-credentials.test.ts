import { describe, expect, it } from 'vitest';
import { auditConsumerCredentials } from '../../../src/ci/audit-consumer-credentials.js';

const CLEAN_WORKFLOW = `name: clean
on: { push: { tags: ['v*'] } }
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/login-action@v3
        with:
          username: \${{ secrets.DOCKERHUB_USERNAME }}
          password: \${{ secrets.DOCKERHUB_TOKEN }}
      - env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          BOT_PAT: \${{ secrets.BOT_PAT }}
        run: echo ok
`;

const OKTA_LEAK_WORKFLOW = `name: leaky
on: { push: { tags: ['v*'] } }
jobs:
  smoke-test:
    runs-on: ubuntu-latest
    steps:
      - name: Run smoke test with consumer creds
        env:
          OKTA_CLIENT_SECRET: \${{ secrets.OKTA_CLIENT_SECRET }}
        run: ./smoke.sh
`;

const SUFFIX_LEAK_WORKFLOW = `name: leaky-2
on: { workflow_dispatch: {} }
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - env:
          EADTRUST_API_KEY: \${{ secrets.EADTRUST_API_KEY }}
        run: ./gate.sh
`;

describe('auditConsumerCredentials', () => {
  it('produces no findings on a workflow that only references operational secrets', () => {
    const result = auditConsumerCredentials({
      files: [{ path: '.github/workflows/clean.yml', content: CLEAN_WORKFLOW }],
    });
    expect(result.findings).toEqual([]);
    expect(result.scannedFiles).toEqual(['.github/workflows/clean.yml']);
  });

  it('flags secrets.OKTA_CLIENT_SECRET with prefix-match reason and the source line', () => {
    const result = auditConsumerCredentials({
      files: [{ path: '.github/workflows/leaky.yml', content: OKTA_LEAK_WORKFLOW }],
    });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.secretName).toBe('OKTA_CLIENT_SECRET');
    expect(finding.reason).toContain('forbidden prefix');
    expect(finding.line).toBeGreaterThan(0);
  });

  it('flags suffix-matched names (_KEY) that are not on the operational allowlist', () => {
    const result = auditConsumerCredentials({
      files: [{ path: '.github/workflows/leaky-2.yml', content: SUFFIX_LEAK_WORKFLOW }],
    });
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.secretName).toBe('EADTRUST_API_KEY');
    expect(finding.reason).toContain('forbidden suffix');
  });

  it('respects extraAllowlist entries (e.g. if Hugo legitimately needs *_KEY for an op secret)', () => {
    const result = auditConsumerCredentials({
      files: [{ path: '.github/workflows/leaky-2.yml', content: SUFFIX_LEAK_WORKFLOW }],
      extraAllowlist: ['EADTRUST_API_KEY'],
    });
    expect(result.findings).toEqual([]);
  });

  it('scans multiple files and aggregates findings across them', () => {
    const result = auditConsumerCredentials({
      files: [
        { path: '.github/workflows/a.yml', content: OKTA_LEAK_WORKFLOW },
        { path: 'actions/foo/action.yml', content: SUFFIX_LEAK_WORKFLOW },
      ],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.file).sort()).toEqual([
      '.github/workflows/a.yml',
      'actions/foo/action.yml',
    ]);
  });

  it('flags the live publish.yml as having no consumer-credential references today', async () => {
    // Sanity check: confirm the real workflow we ship is clean against the audit.
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
    );
    const publishYml = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
    const content = await fs.readFile(publishYml, 'utf8');
    const result = auditConsumerCredentials({
      files: [{ path: '.github/workflows/publish.yml', content }],
    });
    expect(result.findings).toEqual([]);
  });
});
