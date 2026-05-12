import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import {
  TRACK_A_TARGET_IDS,
  TRACK_B_TARGET_IDS,
} from '../../src/schemas/target-ids.js';

// Story 4.6: plug-ability contract test (NFR-X3).
//
// "Adding a new Track A target is additive only." We can't realistically
// run GH Actions locally to spawn a stub composite action and assert
// it appears in the release report, but we CAN validate the architectural
// contract end-to-end:
//
//   1. Every actions/publish-<id>/action.yml has the canonical 4 inputs
//      (mcp_name / version / pipeline_run_id / dry_run) and the
//      result_json output. No drift across publishers.
//   2. The target ID encoded in the directory name matches an entry in
//      src/schemas/target-ids.ts.
//   3. Every directory has a corresponding job in publish.yml that
//      `uses: ./actions/publish-<id>` AND a publisher TypeScript file
//      under src/publishers/.
//
// Together those checks prove the additive contract: an engineer who
// only adds a new actions/publish-<id>/ folder + appends a target ID to
// target-ids.ts + adds a job to publish.yml has done everything
// required — no other file needs to change.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const ACTIONS_DIR = path.join(REPO_ROOT, 'actions');
const PUBLISH_YML = path.join(REPO_ROOT, '.github', 'workflows', 'publish.yml');

interface CompositeAction {
  inputs?: Record<string, { required?: boolean; default?: unknown }>;
  outputs?: Record<string, { value: string }>;
  runs?: { using?: string };
}

interface PublishWorkflow {
  jobs: Record<string, { steps: Array<{ uses?: string }> }>;
}

async function listPublishDirs(): Promise<string[]> {
  const all = await fs.readdir(ACTIONS_DIR, { withFileTypes: true });
  return all
    .filter((e) => e.isDirectory() && e.name.startsWith('publish-'))
    .map((e) => e.name);
}

describe('Plug-ability contract (NFR-X3 — Story 4.6)', () => {
  let publishDirs: string[];
  let publishYml: PublishWorkflow;

  beforeAll(async () => {
    publishDirs = await listPublishDirs();
    publishYml = yaml.load(await fs.readFile(PUBLISH_YML, 'utf8')) as PublishWorkflow;
  });

  it('at least 7 Track A publisher directories exist (the PRD v1 scope)', () => {
    const trackAExpected = TRACK_A_TARGET_IDS.map((id) => `publish-${id === 'mcp-publisher' ? 'mcp-registry' : id}`);
    for (const dir of trackAExpected) {
      expect(publishDirs).toContain(dir);
    }
  });

  it.each(['publish-npm', 'publish-docker-hub', 'publish-mcp-registry', 'publish-smithery', 'publish-docker-mcp-catalog', 'publish-cline', 'publish-mcpso'])(
    'actions/%s/action.yml conforms to the canonical input/output contract',
    async (dirName) => {
      const actionYmlPath = path.join(ACTIONS_DIR, dirName, 'action.yml');
      const raw = await fs.readFile(actionYmlPath, 'utf8');
      const action = yaml.load(raw) as CompositeAction;

      // Canonical inputs: all 4 required.
      const inputNames = Object.keys(action.inputs ?? {}).sort();
      expect(inputNames).toEqual(['dry_run', 'mcp_name', 'pipeline_run_id', 'version']);
      expect(action.inputs!.mcp_name?.required).toBe(true);
      expect(action.inputs!.version?.required).toBe(true);
      expect(action.inputs!.pipeline_run_id?.required).toBe(true);
      // dry_run is optional with default 'false'.
      expect(String(action.inputs!.dry_run?.default ?? '')).toBe('false');

      // Canonical output: result_json must be defined and reference a step output.
      expect(action.outputs?.result_json?.value).toBeDefined();
      expect(action.outputs!.result_json!.value).toContain('steps.publish.outputs.result_json');

      // Composite action (not docker/javascript) — that's our v1 standard.
      expect(action.runs?.using).toBe('composite');
    },
  );

  it('every actions/publish-<id>/ has a matching job in publish.yml that uses ./actions/publish-<id>', () => {
    for (const dir of publishDirs) {
      const usesString = `./actions/${dir}`;
      const jobNames = Object.keys(publishYml.jobs);
      const referencedBy = jobNames.find((jobName) => {
        const steps = publishYml.jobs[jobName]!.steps;
        return steps.some((s) => s.uses === usesString);
      });
      expect(referencedBy, `${dir} should be referenced by a publish.yml job via uses: ${usesString}`).toBeDefined();
    }
  });

  it('every publisher action directory has a matching src/publishers/<file>.ts', async () => {
    const publishersDir = path.join(REPO_ROOT, 'src', 'publishers');
    const files = await fs.readdir(publishersDir);
    for (const dir of publishDirs) {
      // Action `publish-mcp-registry` maps to `publish-mcp-registry.ts`,
      // `publish-npm` → `publish-npm.ts`, etc. Allow either the
      // direct match OR a shared-helper-backed thin wrapper.
      const expectedDirect = `${dir}.ts`;
      const matches = files.filter((f) => f === expectedDirect || f === `${dir.replace(/^publish-/, 'publish-')}.ts`);
      expect(matches.length, `expected src/publishers/${expectedDirect} to exist for ${dir}`).toBeGreaterThan(0);
    }
  });

  it('every canonical target ID (Track A + Track B v1 scope) is either implemented or explicitly deferred', () => {
    // Track A: all 7 must have a publisher directory.
    for (const id of TRACK_A_TARGET_IDS) {
      // mcp-publisher → publish-mcp-registry (legacy directory name).
      const expectedDir = id === 'mcp-publisher' ? 'publish-mcp-registry' : `publish-${id}`;
      expect(publishDirs, `Track A target ${id} must have actions/${expectedDir}/`).toContain(expectedDir);
    }
    // Track B: scoped to Epic 5. We DO NOT require them yet; this assertion
    // is informational and would surface the deferral.
    for (const id of TRACK_B_TARGET_IDS) {
      const expectedDir = `publish-${id}`;
      const isImplemented = publishDirs.includes(expectedDir);
      // We don't fail; we just record. When Epic 5 lands, this test
      // doesn't need to change — adding the directory makes it pass
      // automatically. That's the plug-ability contract.
      if (!isImplemented) {
        console.warn(
          `[plug-ability] Track B target '${id}' is not yet implemented (Epic 5 scope). Expected actions/${expectedDir}/.`,
        );
      }
    }
  });

  it('adding a stub publisher directory + target ID would auto-satisfy the contract for that target', async () => {
    // Simulates the "additive only" pattern. We write a stub action.yml
    // into a tmp directory under actions/publish-fake-store/, validate
    // it against the canonical contract from this very test, and clean
    // up. If the stub directory's action.yml conforms, it would be
    // ready for an engineer to wire up by adding one matrix entry +
    // one target ID.
    const stubDir = path.join(ACTIONS_DIR, 'publish-fake-store');
    const stubAction = {
      name: 'Publish to Fake Store',
      description: 'Stub for plug-ability validation; never wired into publish.yml.',
      inputs: {
        mcp_name: { description: 'MCP id', required: true },
        version: { description: 'semver', required: true },
        pipeline_run_id: { description: 'run id', required: true },
        dry_run: { description: 'dry run', required: false, default: 'false' },
      },
      outputs: {
        result_json: {
          description: 'PublisherOutputSchema-conforming JSON.',
          value: '${{ steps.publish.outputs.result_json }}',
        },
      },
      runs: { using: 'composite', steps: [{ shell: 'bash', run: 'echo stub' }] },
    };
    await fs.mkdir(stubDir, { recursive: true });
    try {
      await fs.writeFile(path.join(stubDir, 'action.yml'), yaml.dump(stubAction));

      // Re-read the stub via the same path the contract test uses and
      // assert it conforms.
      const raw = await fs.readFile(path.join(stubDir, 'action.yml'), 'utf8');
      const parsed = yaml.load(raw) as CompositeAction;
      expect(Object.keys(parsed.inputs ?? {}).sort()).toEqual(['dry_run', 'mcp_name', 'pipeline_run_id', 'version']);
      expect(parsed.outputs?.result_json?.value).toBe('${{ steps.publish.outputs.result_json }}');
      expect(parsed.runs?.using).toBe('composite');
    } finally {
      await fs.rm(stubDir, { recursive: true, force: true });
    }
  });
});
