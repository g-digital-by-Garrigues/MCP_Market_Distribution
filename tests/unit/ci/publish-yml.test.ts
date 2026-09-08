import { describe, expect, it, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const PUBLISH_YML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'publish.yml',
);

interface PublishWorkflow {
  name: string;
  on: { push: { tags: string[] }; workflow_dispatch: { inputs: Record<string, unknown> } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { 'runs-on': string; steps: Array<Record<string, unknown>> }>;
}

describe('.github/workflows/publish.yml scaffold', () => {
  let parsed: PublishWorkflow;

  beforeAll(async () => {
    const raw = await fs.readFile(PUBLISH_YML, 'utf8');
    parsed = yaml.load(raw) as PublishWorkflow;
  });

  it('triggers on v* tag push and on workflow_dispatch', () => {
    expect(parsed.on.push.tags).toEqual(['v*']);
    expect(parsed.on.workflow_dispatch).toBeDefined();
  });

  it('exposes mcp_name, version, step, track, bump, dry_run, release_note_check inputs', () => {
    const inputs = parsed.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      ['bump', 'dry_run', 'mcp_name', 'release_note_check', 'step', 'track', 'version'],
    );
    // Epic 18 review (F4): 'advisory' exists ONLY for retries of an
    // already-published tag; a fresh publish must default to fail-closed.
    const noteCheck = inputs.release_note_check as { default: string; options: string[] };
    expect(noteCheck.default).toBe('enforce');
    expect(noteCheck.options).toEqual(['enforce', 'advisory']);
    const mcpName = inputs.mcp_name as { required: boolean; type: string };
    const version = inputs.version as { required: boolean; type: string };
    expect(mcpName.required).toBe(true);
    expect(version.required).toBe(true);
    const dryRun = inputs.dry_run as { type: string; default: boolean };
    expect(dryRun.type).toBe('boolean');
    expect(dryRun.default).toBe(false);
  });

  it('keys concurrency on publish-<mcp_name>-<version> with cancel-in-progress: false', () => {
    expect(parsed.concurrency.group).toContain('publish-');
    expect(parsed.concurrency.group).toContain('mcp_name');
    expect(parsed.concurrency.group).toContain('version');
    expect(parsed.concurrency['cancel-in-progress']).toBe(false);
  });

  it('declares a setup job on ubuntu-latest that installs deps and runs the build verify', () => {
    const setup = parsed.jobs.setup;
    expect(setup).toBeDefined();
    expect(setup!['runs-on']).toBe('ubuntu-latest');
    const stepFlat = JSON.stringify(setup!.steps);
    expect(stepFlat).toContain('pnpm install --frozen-lockfile');
    expect(stepFlat).toContain('pnpm tsx src/ci/resolve-workflow-context.ts');
    expect(stepFlat).toContain('pnpm run typecheck');
    expect(stepFlat).toContain('pnpm run test');
  });

  it('exports pipeline_run_id, mcp_name, version, source, dry_run + repo_url/repo_ref as job outputs', () => {
    const setup = parsed.jobs.setup as unknown as {
      outputs: Record<string, string>;
    } | undefined;
    expect(setup).toBeDefined();
    // repo_url + repo_ref added by the v1.1 per-MCP-repo refactor (Phase B):
    // downstream jobs use them to clone the MCP's own source repo into
    // pending-to-publish/<id>/ via the checkout-mcp-source composite action.
    expect(Object.keys(setup!.outputs).sort()).toEqual(
      [
        'dry_run',
        'mcp_name',
        'pipeline_run_id',
        'release_note_mode',
        'repo_ref',
        'repo_url',
        'source',
        'version',
      ],
    );
  });

  it('propagates DRY_RUN env to every Track A gate job and to gate-failure-summary', () => {
    const consumers = ['track-a-layer-1', 'track-a-layer-2', 'track-a-layer-3', 'gate-failure-summary'];
    for (const name of consumers) {
      const job = parsed.jobs[name] as unknown as { env?: Record<string, string> } | undefined;
      expect(job, name).toBeDefined();
      expect(job!.env, name).toBeDefined();
      expect(job!.env!.DRY_RUN, name).toBe('${{ needs.setup.outputs.dry_run }}');
    }
  });

  it('Track A publisher jobs (Stories 3.2/3.3/3.4) gate on track-a-layer-3 success + ledger-read flag, expose result_json', () => {
    const publishers = ['publish-npm', 'publish-docker-hub', 'publish-mcp-registry'];
    for (const name of publishers) {
      const job = parsed.jobs[name] as unknown as {
        needs?: string[];
        if?: string;
        outputs?: Record<string, string>;
        steps: Array<Record<string, unknown>>;
      } | undefined;
      expect(job, name).toBeDefined();
      expect(job!.needs, name).toContain('setup');
      expect(job!.needs, name).toContain('ledger-read');
      expect(job!.needs, name).toContain('track-a-layer-3');
      // The if-guard must check the per-target ledger flag.
      expect(job!.if, name).toContain('ledger-read.outputs.run_');
      // result_json must be exported so final-report can consume it.
      expect(job!.outputs?.result_json, name).toBe('${{ steps.publish.outputs.result_json }}');
      // The composite action is referenced as a relative path.
      const usesValues = job!.steps
        .map((s) => (s as { uses?: string }).uses)
        .filter((u): u is string => typeof u === 'string');
      expect(usesValues.some((u) => u.startsWith('./actions/publish-')), name).toBe(true);
    }
  });

  it('ledger-read job exposes per-target run flags + ledger_json', () => {
    const job = parsed.jobs['ledger-read'] as unknown as {
      outputs?: Record<string, string>;
    } | undefined;
    expect(job).toBeDefined();
    const expected = ['run_npm', 'run_docker_hub', 'run_mcp_publisher', 'run_smithery', 'run_docker_mcp_catalog', 'run_cline', 'run_mcpso', 'run_n8n', 'run_make_rom', 'ledger_json'];
    for (const key of expected) {
      expect(job!.outputs?.[key], key).toBeDefined();
    }
  });

  it('ledger-read runs checkout-mcp-source so read-ledger.ts can load .distribution.yaml for skip_targets', () => {
    // Regression: Phase C moved skip_targets out of mcp-pipeline.yaml
    // (this repo) into the per-MCP repo's .distribution.yaml. Without
    // checkout-mcp-source in ledger-read, the loader silently failed
    // and the skip filter was never applied — publish-smithery ran
    // despite skip_targets: [smithery]. The MCP source MUST be cloned
    // before read-ledger.ts runs.
    const job = parsed.jobs['ledger-read'] as unknown as {
      steps: Array<{ uses?: string }>;
    };
    const usesList = job.steps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(usesList).toContain('./actions/checkout-mcp-source');
  });

  it('publish-npm and publish-mcp-registry both have id-token: write for OIDC', () => {
    for (const name of ['publish-npm', 'publish-mcp-registry']) {
      const job = parsed.jobs[name] as unknown as { permissions?: Record<string, string> } | undefined;
      expect(job!.permissions?.['id-token'], name).toBe('write');
    }
  });

  it('publish-mcp-registry depends on publish-npm so package-ownership verification can read mcpName', () => {
    const job = parsed.jobs['publish-mcp-registry'] as unknown as { needs: string[] };
    expect(job.needs).toContain('publish-npm');
  });

  it('marketplace publishers (cline / mcpso / docker-mcp-catalog) depend on publish-npm so unpkg.com logo URLs resolve', () => {
    for (const name of ['publish-cline', 'publish-mcpso', 'publish-docker-mcp-catalog']) {
      const job = parsed.jobs[name] as unknown as { needs: string[]; if?: string };
      expect(job.needs, name).toContain('publish-npm');
      // The if-guard must check that publish-npm.outputs.result_json indicates 'succeeded',
      // otherwise we'd file marketplace issues referencing an npm version that doesn't exist.
      expect(job.if, name).toContain('publish-npm.outputs.result_json');
      expect(job.if, name).toContain('succeeded');
    }
  });

  it('Epic 4 publisher jobs (docker-mcp-catalog, cline, mcpso) gate on track-a-layer-3 + ledger-read flag and expose result_json', () => {
    // publish-smithery was moved out of this enumeration by Story 5.12.
    // It's now an artifact-consumer (Track C) that depends on
    // generate-mcpb-bundle + track-c-layer-3 rather than track-a-layer-3;
    // its contract is asserted in the dedicated test below.
    for (const name of ['publish-docker-mcp-catalog', 'publish-cline', 'publish-mcpso']) {
      const job = parsed.jobs[name] as unknown as {
        needs?: string[];
        if?: string;
        outputs?: Record<string, string>;
      } | undefined;
      expect(job, name).toBeDefined();
      expect(job!.needs, name).toContain('setup');
      expect(job!.needs, name).toContain('ledger-read');
      expect(job!.needs, name).toContain('track-a-layer-3');
      expect(job!.if, name).toContain('ledger-read.outputs.run_');
      expect(job!.outputs?.result_json, name).toBe('${{ steps.publish.outputs.result_json }}');
    }
  });

  it('publish-smithery gates on generate-mcpb-bundle + track-c-layer-3 + ledger flag, downloads the bundle artifact, forwards SMITHERY_TOKEN (Story 5.12)', () => {
    const job = parsed.jobs['publish-smithery'] as unknown as {
      needs?: string[];
      if?: string;
      outputs?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    } | undefined;
    expect(job).toBeDefined();
    expect(job!.needs).toContain('setup');
    expect(job!.needs).toContain('ledger-read');
    expect(job!.needs).toContain('generate-mcpb-bundle');
    expect(job!.needs).toContain('track-c-layer-3');
    // The old wiring depended on track-a-layer-3 (Track A gates over the
    // source MCP). 5.12 replaced that with the Track C chain because the
    // .mcpb bundle's correctness — not the source MCP's — is what we're
    // publishing to Smithery. Track A still feeds Track C transitively
    // via generate-mcpb-bundle's own needs.
    expect(job!.needs).not.toContain('track-a-layer-3');
    expect(job!.if).toContain("ledger-read.outputs.run_smithery == 'true'");
    expect(job!.if).toContain("track-c-layer-3.result == 'success'");
    expect(job!.outputs?.result_json).toBe('${{ steps.publish.outputs.result_json }}');
    const stepFlat = JSON.stringify(job!.steps);
    // Composite action invocation passes bundle_artifact_name (so
    // download-artifact in the composite resolves the .mcpb) and
    // smithery_token (sourced from the repo secret).
    expect(stepFlat).toContain('bundle_artifact_name');
    expect(stepFlat).toContain('smithery_token');
    expect(stepFlat).toContain('secrets.SMITHERY_TOKEN');
  });

  it('Track C — generate-mcpb-bundle job gates on track-a-layer-3 + ledger-read.run_smithery, uploads the bundle artifact (Story 5.12)', () => {
    const job = parsed.jobs['generate-mcpb-bundle'] as unknown as {
      needs?: string[];
      if?: string;
      outputs?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    } | undefined;
    expect(job).toBeDefined();
    expect(job!.needs).toContain('setup');
    expect(job!.needs).toContain('ledger-read');
    expect(job!.needs).toContain('track-a-layer-3');
    expect(job!.if).toContain('track-a-layer-3.result');
    expect(job!.if).toContain("ledger-read.outputs.run_smithery == 'true'");
    expect(job!.outputs?.artifact_name).toBeDefined();
    const stepFlat = JSON.stringify(job!.steps);
    expect(stepFlat).toContain('actions/upload-artifact');
    expect(stepFlat).toContain('run-mcpb-adapter-build.ts');
    expect(stepFlat).toContain('npm run build');
    // Same trap as Track B: upload-artifact@v4 silently drops dotfiles.
    // The bundle's `.spec.json` (Layer 1 truth source) + `.mcpb-build.json`
    // (release-report summary) are dotfiles, so include-hidden-files is
    // required.
    expect(stepFlat).toContain('include-hidden-files');
  });

  it('Track C layer 1/2/3 jobs chain via needs + download the MCPB bundle artifact', () => {
    const layers = ['track-c-layer-1', 'track-c-layer-2', 'track-c-layer-3'];
    for (const name of layers) {
      const job = parsed.jobs[name] as unknown as {
        needs?: string[];
        if?: string;
        steps: Array<Record<string, unknown>>;
      } | undefined;
      expect(job, name).toBeDefined();
      expect(job!.needs, name).toContain('setup');
      expect(job!.needs, name).toContain('generate-mcpb-bundle');
      const stepFlat = JSON.stringify(job!.steps);
      expect(stepFlat, name).toContain('actions/download-artifact');
      expect(stepFlat, name).toContain(`run-${name}.ts`);
    }
    // Layer 2 chains after Layer 1; Layer 3 chains after Layer 2.
    const layer2 = parsed.jobs['track-c-layer-2'] as unknown as { needs: string[] };
    expect(layer2.needs).toContain('track-c-layer-1');
    const layer3 = parsed.jobs['track-c-layer-3'] as unknown as { needs: string[] };
    expect(layer3.needs).toContain('track-c-layer-2');
  });

  it('final-report job runs always() and aggregates all 7 Track A publishers + Track B publish-n8n', () => {
    const job = parsed.jobs['final-report'] as unknown as {
      needs: string[];
      if?: string;
      permissions?: Record<string, string>;
    } | undefined;
    expect(job).toBeDefined();
    expect(job!.needs).toEqual(
      expect.arrayContaining([
        'setup',
        'publish-npm',
        'publish-docker-hub',
        'publish-mcp-registry',
        'publish-smithery',
        'publish-docker-mcp-catalog',
        'publish-cline',
        'publish-mcpso',
        'publish-n8n',
      ]),
    );
    expect(job!.if).toContain('always()');
    expect(job!.permissions?.contents).toBe('write');
    expect(job!.permissions?.['pull-requests']).toBe('write');
  });

  it("final-report commit-push uses race-safe pattern (fast-forward + replay + retry) — regression for run #26085194146 add/add", () => {
    // The previous logic was `git add → commit → git pull --rebase →
    // push`, which fails with an add/add merge conflict when an EARLIER
    // attempt of the same run already committed a different version of
    // the same file path. Concrete repro: run #26085194146 attempt -1
    // committed an all-skipped report at 60ddbe9; attempt -2 ran the
    // publishers successfully but its push died on the rebase conflict
    // because its workspace cloned the stale dispatch SHA. The fix
    // captures the render, fast-forwards to upstream HEAD, replays the
    // render so it always wins for the same MCP+version path, commits,
    // and pushes with retry on rejection.
    const job = parsed.jobs['final-report'] as unknown as {
      steps: Array<{ name?: string; run?: string }>;
    };
    const commitStep = job.steps.find((s) => s.name === 'Commit + push release-report to main');
    expect(commitStep).toBeDefined();
    const script = commitStep!.run ?? '';
    // No more naïve pull --rebase (that was the broken path).
    expect(script).not.toContain('git pull --rebase');
    // The race-safe shape.
    expect(script).toContain('rendered_content=$(cat "$REPORT_PATH")');
    expect(script).toContain('git fetch origin main');
    expect(script).toContain('git reset --hard origin/main');
    expect(script).toMatch(/printf .*"\$rendered_content".*> "\$REPORT_PATH"/);
    expect(script).toContain('max_attempts=5');
    expect(script).toContain('git push origin "HEAD:main"');
  });

  it('npx-verification job runs checkout-mcp-source so verify-npx-install.ts can read .distribution.yaml', () => {
    // Regression for run #26045698347: any job that calls into code
    // which loads .distribution.yaml MUST run checkout-mcp-source
    // first, because Phase C moved per-MCP fields out of this repo
    // into the MCP source repo. Same fix pattern as PR #78 for
    // ledger-read.
    const job = parsed.jobs['npx-verification'] as unknown as {
      steps: Array<{ uses?: string }>;
    };
    const usesList = job.steps.map((s) => s.uses).filter((u): u is string => !!u);
    expect(usesList).toContain('./actions/checkout-mcp-source');
  });

  it('Track B — generate-n8n-adapter job gates on track-a-layer-3 success + ledger-read.run_n8n, uploads an artifact', () => {
    const job = parsed.jobs['generate-n8n-adapter'] as unknown as {
      needs?: string[];
      if?: string;
      outputs?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    } | undefined;
    expect(job).toBeDefined();
    expect(job!.needs).toContain('setup');
    expect(job!.needs).toContain('ledger-read');
    expect(job!.needs).toContain('track-a-layer-3');
    expect(job!.if).toContain('track-a-layer-3.result');
    expect(job!.if).toContain("ledger-read.outputs.run_n8n == 'true'");
    expect(job!.outputs?.artifact_name).toBeDefined();
    // Must include the artifact upload so downstream jobs can fetch.
    const stepFlat = JSON.stringify(job!.steps);
    expect(stepFlat).toContain('actions/upload-artifact');
    expect(stepFlat).toContain('run-adapter-build.ts');
    // And it must run-build the MCP source first so dist/server.js exists.
    expect(stepFlat).toContain('npm run build');
    // upload-artifact@v4 SILENTLY drops dotfiles by default. The adapter
    // generator writes `.spec.json` (Layer 1's truth source) and
    // `.adapter-build.json` (release-report summary). Regression for
    // run #26039546691 where Layer 1 failed with ENOENT on the missing
    // dotfile.
    expect(stepFlat).toContain('include-hidden-files');
  });

  it('Track B layer 1/2/3 jobs chain via needs + download the n8n adapter artifact', () => {
    const layers = ['track-b-layer-1', 'track-b-layer-2', 'track-b-layer-3'];
    for (const name of layers) {
      const job = parsed.jobs[name] as unknown as {
        needs?: string[];
        if?: string;
        steps: Array<Record<string, unknown>>;
      } | undefined;
      expect(job, name).toBeDefined();
      expect(job!.needs, name).toContain('setup');
      expect(job!.needs, name).toContain('generate-n8n-adapter');
      const stepFlat = JSON.stringify(job!.steps);
      expect(stepFlat, name).toContain('actions/download-artifact');
      // The script for layer N is run-track-b-layer-N.ts; `name` is
      // already track-b-layer-N so we can build the path directly.
      expect(stepFlat, name).toContain(`run-${name}.ts`);
    }
    // Layer 2 chains after Layer 1; Layer 3 chains after Layer 2.
    const layer2 = parsed.jobs['track-b-layer-2'] as unknown as { needs: string[] };
    expect(layer2.needs).toContain('track-b-layer-1');
    const layer3 = parsed.jobs['track-b-layer-3'] as unknown as { needs: string[] };
    expect(layer3.needs).toContain('track-b-layer-2');
    // Layer 3 also re-checkouts MCP source so it can spawn dist/server.js.
    const layer3Steps = JSON.stringify(layer3 as unknown as { steps: unknown });
    expect(layer3Steps).toContain('checkout-mcp-source');
    expect(layer3Steps).toContain('npm run build');
  });

  it('publish-n8n job gates on track-b-layer-3 + publish-npm + ledger flag, exposes result_json, has OIDC id-token: write', () => {
    const job = parsed.jobs['publish-n8n'] as unknown as {
      needs?: string[];
      if?: string;
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    } | undefined;
    expect(job).toBeDefined();
    expect(job!.needs).toEqual(
      expect.arrayContaining([
        'setup',
        'ledger-read',
        'generate-n8n-adapter',
        'track-b-layer-3',
        'publish-npm',
      ]),
    );
    expect(job!.if).toContain('track-b-layer-3.result');
    expect(job!.if).toContain("ledger-read.outputs.run_n8n == 'true'");
    // Real-mode requires publish-npm to have succeeded; dry_run mode is the explicit exception.
    expect(job!.if).toContain('publish-npm.outputs.result_json');
    expect(job!.if).toContain('dry_run');
    expect(job!.outputs?.result_json).toBe('${{ steps.publish.outputs.result_json }}');
    expect(job!.permissions?.['id-token']).toBe('write');
    const stepFlat = JSON.stringify(job!.steps);
    expect(stepFlat).toContain('actions/download-artifact');
    expect(stepFlat).toContain('./actions/publish-n8n');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Story 18.7 (AC7): the release note is checked BEFORE anything publishes,
  // and the GitHub Release is created AFTER npm succeeds.
  // ─────────────────────────────────────────────────────────────────────

  it('setup checks the release note after the coherence check', () => {
    const setup = parsed.jobs.setup as unknown as {
      steps: Array<{ name?: string; if?: string; run?: string }>;
    };
    const idx = setup.steps.findIndex((s) => (s.run ?? '').includes('src/ci/check-release-notes.ts'));
    expect(idx, 'setup must run src/ci/check-release-notes.ts').toBeGreaterThan(-1);

    const coherenceIdx = setup.steps.findIndex((s) =>
      (s.run ?? '').includes('src/validators/validate-version-coherence.ts'),
    );
    const checkoutIdx = setup.steps.findIndex(
      (s) => (s as { uses?: string }).uses === './actions/checkout-mcp-source',
    );
    // After the clone (it needs the tree) and after the Story 8.2 check.
    expect(checkoutIdx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(checkoutIdx);
    expect(idx).toBeGreaterThan(coherenceIdx);

    const step = setup.steps[idx]!;
    expect(step.run).toContain('pending-to-publish/$MCP_NAME');
    // The failure has to be actionable in the run summary, like the 8.2 one.
    expect(step.run).toContain('GITHUB_STEP_SUMMARY');
  });

  // Epic 18 review (F11): the check was skipped entirely on dry-runs, and none
  // of the three source repos carries `.github/RELEASE_NOTES.md` at origin/main.
  // regression-e2e (all dry-runs) therefore stayed green while the next REAL
  // publish of ANY product was guaranteed to fail in `setup` for a file nobody
  // had been told to write. Dry-runs now run the check in advisory mode: the
  // gap is visible on every dry-run instead of on the first release.
  it('runs the release-note check on dry-runs too, in advisory mode', () => {
    const setup = parsed.jobs.setup as unknown as {
      steps: Array<{ if?: string; run?: string; env?: Record<string, string> }>;
    };
    const step = setup.steps.find((s) => (s.run ?? '').includes('src/ci/check-release-notes.ts'))!;
    // No `if:` gate at all — severity is decided by the mode, not by skipping.
    expect(step.if).toBeUndefined();
    expect(step.env?.RELEASE_NOTE_MODE).toContain('release_note_mode');
    expect(step.run).toContain('--advisory');
    expect(step.run).toContain('::warning::');

    // `setup` resolves the mode once: advisory on a dry-run or when the caller
    // (i.e. /retry-publish) asks for it, enforce otherwise, and a hard error on
    // an unrecognised value so a typo cannot silently disable the gate.
    const resolve = setup.steps.find((s) => (s.run ?? '').includes('release_note_mode='))!;
    expect(resolve.run).toContain('INPUT_RELEASE_NOTE_CHECK');
    expect(resolve.run).toContain('if [ "$dry_run" = "true" ]; then release_note_mode=advisory; fi');
    expect(resolve.run).toContain("release_note_check must be 'enforce' or 'advisory'");
  });

  // Epic 18 review (F14): `git_tag_prefix` is per-product in the
  // generator-owned .distribution.yaml, but the ref has to be resolved before
  // the clone can read it. Prove the assumption in setup rather than at
  // `gh release create --verify-tag`, after every store has published.
  it('setup verifies the resolved ref against the declared git_tag_prefix', () => {
    const setup = parsed.jobs.setup as unknown as {
      steps: Array<{ if?: string; run?: string; env?: Record<string, string> }>;
    };
    const step = setup.steps.find((s) =>
      (s.run ?? '').includes('src/ci/verify-release-tag-ref.ts'),
    );
    expect(step, 'setup must verify the tag ref against .distribution.yaml').toBeDefined();
    expect(step!.if).toContain("dry_run != 'true'");
    expect(step!.env?.REPO_REF).toContain('repo_ref');
  });

  it('declares a github-release job gated on publish-npm success and non-dry-run', () => {
    const job = parsed.jobs['github-release'] as unknown as {
      needs?: string[];
      if?: string;
      permissions?: Record<string, string>;
      steps: Array<Record<string, unknown>>;
    } | undefined;
    expect(job).toBeDefined();
    expect(job!.needs).toEqual(expect.arrayContaining(['setup', 'publish-npm']));
    expect(job!.if).toContain("needs.publish-npm.result == 'success'");
    expect(job!.if).toContain("needs.setup.outputs.dry_run != 'true'");
    // The write goes through this job's own GITHUB_TOKEN, which under
    // workflow_call is scoped to the CALLING source repo — the very repo the
    // Release lands on. It used to be routed through BOT_PAT instead, which is
    // deliberately read-only on our repos, so POST /releases came back 404
    // after every store had already published (v2.0.0, both products).
    expect(job!.permissions?.contents).toBe('write');
  });

  it('github-release derives owner/repo from setup.outputs.repo_url, never github.repository', () => {
    const job = parsed.jobs['github-release'] as unknown as { steps: Array<Record<string, unknown>> };
    const flat = JSON.stringify(job.steps);
    expect(flat).toContain('needs.setup.outputs.repo_url');
    // github.repository is the PIPELINE repo on a direct workflow_dispatch.
    expect(flat).not.toContain('github.repository }}/releases');
    expect(flat).toContain('checkout-mcp-source');
    expect(flat).toContain('--emit-body');
    // BOT_PAT must not come back: it cannot write here, and reaching for it
    // again would mean widening the bot's rights to do what the native token
    // already does. See docs/runbooks/bot-pat-rotation.md.
    expect(flat).not.toContain('secrets.BOT_PAT');
  });

  // The one path where the native token is NOT enough: a direct
  // workflow_dispatch on the pipeline repo, where GITHUB_TOKEN is scoped to
  // MCP_Market_Distribution and has no rights on the source repo. That must
  // say so, not surface as an unexplained 404 the way the BOT_PAT era did.
  it('github-release refuses a cross-repo write its token cannot make', () => {
    const job = parsed.jobs['github-release'] as unknown as {
      steps: Array<{ env?: Record<string, string>; run?: string }>;
    };
    const create = job.steps.find((s) => (s.run ?? '').includes('gh release create'))!;
    expect(create.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(create.env?.TOKEN_REPO).toBe('${{ github.repository }}');
    expect(create.run).toContain('"$OWNER_REPO" != "$TOKEN_REPO"');
  });

  // Epic 18 review (F14): the job used to rebuild `TAG="v$MCP_VERSION"` — a
  // third independent hardcode of the `v` prefix — while already declaring the
  // ref it cloned. With `--verify-tag`, a product whose declared prefix is not
  // `v` would fail here, after everything had already been published.
  it('github-release reuses the ref setup resolved instead of rebuilding v<version>', () => {
    const job = parsed.jobs['github-release'] as unknown as {
      steps: Array<{ name?: string; env?: Record<string, string>; run?: string }>;
    };
    const step = job.steps.find((s) => (s.run ?? '').includes('gh release create'))!;
    expect(step.env?.TAG).toBe('${{ needs.setup.outputs.repo_ref }}');
    expect(step.run).not.toContain('TAG="v$MCP_VERSION"');
    // A ref that is not a release tag ('main' on a dry-run) must never reach gh.
    expect(step.run).toContain('"$TAG" = "main"');
  });

  // Epic 18 review (F4): on an advisory run (a retry of an already-published
  // tag) the note may legitimately be absent. FR62 forbids inventing the body,
  // so the Release is skipped with a warning rather than failed or faked.
  it('github-release skips the Release when there is no authored body, never invents one', () => {
    const job = parsed.jobs['github-release'] as unknown as {
      steps: Array<{ env?: Record<string, string>; run?: string }>;
    };
    const emit = job.steps.find((s) => (s.run ?? '').includes('--emit-body'))!;
    expect(emit.env?.RELEASE_NOTE_MODE).toContain('release_note_mode');
    expect(emit.run).toContain('--advisory');
    const create = job.steps.find((s) => (s.run ?? '').includes('gh release create'))!;
    expect(create.run).toContain('if [ ! -f release-body.md ]');
  });

  it('github-release creates with --verify-tag and edits when the release already exists', () => {
    const job = parsed.jobs['github-release'] as unknown as { steps: Array<Record<string, unknown>> };
    const flat = JSON.stringify(job.steps);
    expect(flat).toContain('gh release create');
    expect(flat).toContain('--verify-tag');
    expect(flat).toContain('gh release edit');
    expect(flat).toContain('gh release view');
    expect(flat).toContain('--notes-file');
  });

  it('keeps github-release out of the release report and the ledger (it is not a TargetId)', () => {
    const finalReport = parsed.jobs['final-report'] as unknown as {
      needs: string[];
      steps: Array<Record<string, unknown>>;
    };
    expect(finalReport.needs).not.toContain('github-release');
    expect(JSON.stringify(finalReport.steps)).not.toContain('github-release');
  });
});
