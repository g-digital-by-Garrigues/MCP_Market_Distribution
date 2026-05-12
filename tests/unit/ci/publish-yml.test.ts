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

  it('exports pipeline_run_id, mcp_name, version, source, dry_run as job outputs', () => {
    const setup = parsed.jobs.setup as unknown as {
      outputs: Record<string, string>;
    } | undefined;
    expect(setup).toBeDefined();
    expect(Object.keys(setup!.outputs).sort()).toEqual(
      ['dry_run', 'mcp_name', 'pipeline_run_id', 'source', 'version'],
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
});
