import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadDistributionConfig } from '../distribution/load-distribution-config.js';
import { DEFAULT_GIT_TAG_PREFIX } from '../schemas/distribution-config.schema.js';

// Epic 18 review (F14): the release tag string was rebuilt from scratch in the
// `github-release` job as `TAG="v$MCP_VERSION"`, a third independent hardcode of
// the `v` prefix in a pipeline whose own config schema declares `git_tag_prefix`
// per product (`'ead-factory-v'` is a legal value —
// src/schemas/distribution-config.schema.ts). The job already had the ref the
// pipeline actually cloned (`needs.setup.outputs.repo_ref`); rebuilding it meant
// a product with a non-`v` prefix would fail `gh release create --verify-tag`
// AFTER npm, Docker Hub, the registry, Smithery and n8n had all published —
// unfixable without another version bump.
//
// Two halves to the fix:
//   1. `github-release` reuses `needs.setup.outputs.repo_ref` (publish.yml).
//   2. this module proves, in `setup`, that the ref the pipeline resolved is the
//      one the product's own `.distribution.yaml` declares.
//
// Why a check and not a resolver: `repo_ref` has to be known BEFORE the clone
// (`checkout-mcp-source` clones `--branch <ref>`), and `.distribution.yaml` only
// exists after it. So the pipeline resolves `v<version>` and this check refuses
// to continue if the product declares something else — fail-closed, in the first
// job, with a message that names the prefix, instead of a bare "Remote branch
// not found" or a post-publish `--verify-tag` failure.
//
// `.distribution.yaml` is generator-owned: we read it, we never rewrite it.

/** The tag a release rides, per the product's declared prefix. */
export function releaseTagRef(version: string, gitTagPrefix?: string): string {
  return `${gitTagPrefix ?? DEFAULT_GIT_TAG_PREFIX}${version}`;
}

export interface ReleaseTagRefCheckReport {
  mcpName: string;
  version: string;
  /** The ref the pipeline resolved and cloned (`needs.setup.outputs.repo_ref`). */
  actualRef: string;
  /** `git_tag_prefix` from the cloned `.distribution.yaml`, or the default. */
  declaredPrefix: string | null;
  /** The ref that prefix implies. */
  expectedRef: string | null;
  ok: boolean;
  problems: string[];
}

export interface CheckReleaseTagRefOptions {
  /** Pipeline repo root — the parent of `pending-to-publish/`. */
  repoRoot: string;
  mcpName: string;
  version: string;
  actualRef: string;
}

export async function checkReleaseTagRef(
  opts: CheckReleaseTagRefOptions,
): Promise<ReleaseTagRefCheckReport> {
  const base: ReleaseTagRefCheckReport = {
    mcpName: opts.mcpName,
    version: opts.version,
    actualRef: opts.actualRef,
    declaredPrefix: null,
    expectedRef: null,
    ok: false,
    problems: [],
  };

  let declaredPrefix: string;
  try {
    const config = await loadDistributionConfig(opts.repoRoot, opts.mcpName);
    declaredPrefix = config.git_tag_prefix ?? DEFAULT_GIT_TAG_PREFIX;
  } catch (err) {
    // Fail-closed: an unreadable contract is not a licence to assume `v`.
    return { ...base, problems: [(err as Error).message] };
  }

  const expectedRef = releaseTagRef(opts.version, declaredPrefix);
  if (expectedRef !== opts.actualRef) {
    return {
      ...base,
      declaredPrefix,
      expectedRef,
      problems: [
        `${opts.mcpName} declares git_tag_prefix '${declaredPrefix}' in .distribution.yaml, so this ` +
          `release rides '${expectedRef}' — but the pipeline resolved the ref as '${opts.actualRef}'. ` +
          `The pipeline resolves the ref before it can read the product's config, so it assumes ` +
          `'${DEFAULT_GIT_TAG_PREFIX}'. Failing here, in setup, instead of at 'gh release create ` +
          `--verify-tag' after everything has already been published.`,
      ],
    };
  }

  return { ...base, declaredPrefix, expectedRef, ok: true, problems: [] };
}

async function main(): Promise<number> {
  const [mcpName, version, actualRef] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  if (!mcpName || !version || !actualRef) {
    process.stderr.write(
      'Usage: tsx src/ci/verify-release-tag-ref.ts <mcp-name> <version> <resolved-ref>\n',
    );
    return 2;
  }

  const report = await checkReleaseTagRef({
    repoRoot: process.cwd(),
    mcpName,
    version,
    actualRef,
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.ok ? 0 : 1;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  void main().then((code) => {
    process.exit(code);
  });
}
