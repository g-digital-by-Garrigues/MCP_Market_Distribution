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

  it('exposes mcp_name, version, step, track, bump, dry_run inputs', () => {
    const inputs = parsed.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs).sort()).toEqual(
      ['bump', 'dry_run', 'mcp_name', 'step', 'track', 'version'],
    );
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
      ['dry_run', 'mcp_name', 'pipeline_run_id', 'repo_ref', 'repo_url', 'source', 'version'],
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

  it('Epic 4 publisher jobs (smithery, docker-mcp-catalog, cline, mcpso) gate on ledger-read flag and expose result_json', () => {
    for (const name of ['publish-smithery', 'publish-docker-mcp-catalog', 'publish-cline', 'publish-mcpso']) {
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
});
