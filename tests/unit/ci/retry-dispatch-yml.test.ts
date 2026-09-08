import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import yaml from 'js-yaml';

const RETRY_YML = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'retry-dispatch.yml',
);

interface RetryWorkflow {
  on: { issue_comment: { types: string[] } };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; 'runs-on': string; steps: Array<Record<string, unknown>> }>;
}

describe('.github/workflows/retry-dispatch.yml', () => {
  let parsed: RetryWorkflow;
  beforeAll(async () => {
    const raw = await fs.readFile(RETRY_YML, 'utf8');
    parsed = yaml.load(raw) as RetryWorkflow;
  });

  it('triggers on issue_comment.created (PR-comment slash-commands)', () => {
    expect(parsed.on.issue_comment.types).toEqual(['created']);
  });

  it('concurrency-keyed per PR with cancel-in-progress so stale dispatchers fall out', () => {
    expect(parsed.concurrency.group).toContain('retry-dispatch-');
    expect(parsed.concurrency.group).toContain('issue.number');
    expect(parsed.concurrency['cancel-in-progress']).toBe(true);
  });

  it('requires actions:write permission so it can dispatch publish.yml', () => {
    expect(parsed.permissions.actions).toBe('write');
    expect(parsed.permissions['pull-requests']).toBe('write');
    expect(parsed.permissions.issues).toBe('write');
  });

  it('only runs when the comment is on a PR (issue.pull_request != null gate)', () => {
    const job = parsed.jobs.dispatch;
    expect(job).toBeDefined();
    expect(job!.if).toContain('issue.pull_request');
  });

  it('dispatch job script invokes parseCommand from the shared TS module (not duplicated logic)', () => {
    const script = JSON.stringify(parsed.jobs.dispatch!.steps);
    expect(script).toContain('parse-command');
    // Calls the github-script PAT API methods needed for the contract.
    expect(script).toContain('getCollaboratorPermissionLevel');
    expect(script).toContain('createWorkflowDispatch');
    expect(script).toContain('listComments');
  });

  // Epic 18 review (F4): the release-note gate is fail-closed on every
  // non-dry-run, and this dispatcher sets `dry_run: 'false'`. A retry targets a
  // tag that already exists and the note must ride the tag, so without an
  // explicit advisory flag a retry of any release published before Epic 18
  // could only pass by re-tagging a published version — the one thing
  // docs/runbooks/release-checklist.md forbids.
  it("dispatches with release_note_check: 'advisory' so a retry of a published tag is not blocked", () => {
    const script = JSON.stringify(parsed.jobs.dispatch!.steps);
    expect(script).toContain("dry_run: 'false'");
    expect(script).toContain("release_note_check: 'advisory'");
  });
});
