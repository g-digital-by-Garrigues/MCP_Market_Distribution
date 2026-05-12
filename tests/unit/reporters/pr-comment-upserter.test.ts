import { describe, expect, it, vi } from 'vitest';

import {
  upsertComment,
  type GithubClient,
  type GithubComment,
} from '../../../src/reporters/pr-comment-upserter.js';

function fakeClient(initial: GithubComment[] = []): {
  client: GithubClient;
  comments: GithubComment[];
  calls: { listComments: number; createComment: number; updateComment: number };
} {
  const comments = [...initial];
  const calls = { listComments: 0, createComment: 0, updateComment: 0 };
  const client: GithubClient = {
    listComments: vi.fn(async () => {
      calls.listComments += 1;
      return comments;
    }),
    createComment: vi.fn(async ({ body }) => {
      calls.createComment += 1;
      const c = { id: 1_000 + comments.length, body };
      comments.push(c);
      return { id: c.id };
    }),
    updateComment: vi.fn(async ({ comment_id, body }) => {
      calls.updateComment += 1;
      const i = comments.findIndex((c) => c.id === comment_id);
      if (i === -1) throw new Error(`fake: comment ${comment_id} not found`);
      comments[i] = { id: comment_id, body };
    }),
  };
  return { client, comments, calls };
}

const RELEASE_MARKER = '<!-- release-report:ead-factory-v1.0.0 -->';
const ERROR_MARKER = '<!-- error-report:run-99 -->';

describe('upsertComment', () => {
  it('creates a new comment when no existing comment carries the marker', async () => {
    const { client, comments, calls } = fakeClient([
      { id: 1, body: 'unrelated comment from someone else' },
      { id: 2, body: 'another unrelated' },
    ]);
    const body = `${RELEASE_MARKER}\n\n# Release ead-factory-v1.0.0\n**Status:** ✅ Complete\n`;
    const result = await upsertComment(
      { owner: 'g-digital-by-Garrigues', repo: 'MCP_Market_Distribution', prNumber: 42, marker: RELEASE_MARKER, body },
      client,
    );

    expect(result.action).toBe('created');
    expect(calls).toEqual({ listComments: 1, createComment: 1, updateComment: 0 });
    expect(comments.find((c) => c.id === result.comment_id)?.body).toBe(body);
    // Other comments untouched.
    expect(comments.find((c) => c.id === 1)?.body).toBe('unrelated comment from someone else');
  });

  it('updates the existing comment in place when one carries the marker', async () => {
    const { client, comments, calls } = fakeClient([
      { id: 1, body: 'unrelated' },
      { id: 2, body: `${RELEASE_MARKER}\n\n# OLD body` },
      { id: 3, body: 'also unrelated' },
    ]);
    const body = `${RELEASE_MARKER}\n\n# NEW body — re-run of the same release\n`;
    const result = await upsertComment(
      { owner: 'g-digital-by-Garrigues', repo: 'MCP_Market_Distribution', prNumber: 42, marker: RELEASE_MARKER, body },
      client,
    );

    expect(result.action).toBe('updated');
    expect(result.comment_id).toBe(2);
    expect(calls).toEqual({ listComments: 1, createComment: 0, updateComment: 1 });
    expect(comments.find((c) => c.id === 2)?.body).toBe(body);
    // Comments 1 and 3 untouched, never deleted.
    expect(comments.find((c) => c.id === 1)?.body).toBe('unrelated');
    expect(comments.find((c) => c.id === 3)?.body).toBe('also unrelated');
  });

  it('treats the release-report and error-report markers as independent (different families coexist)', async () => {
    const { client, comments } = fakeClient([
      { id: 1, body: `${ERROR_MARKER}\n\nGate failure body` },
    ]);
    const body = `${RELEASE_MARKER}\n\n# Release body`;

    const result = await upsertComment(
      { owner: 'g-digital-by-Garrigues', repo: 'MCP_Market_Distribution', prNumber: 42, marker: RELEASE_MARKER, body },
      client,
    );

    // The error-report comment must NOT have matched the release-report marker.
    expect(result.action).toBe('created');
    // Now 2 comments coexist: one error-report, one release-report.
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toContain(ERROR_MARKER);
    expect(comments[1]?.body).toContain(RELEASE_MARKER);
  });

  it('ignores comments whose body is null/undefined (gh API returns null for deleted/hidden bodies)', async () => {
    const { client } = fakeClient([
      { id: 1, body: null },
      { id: 2, body: undefined },
      { id: 3, body: 'unrelated' },
    ]);
    const body = `${RELEASE_MARKER}\n\nbody`;
    const result = await upsertComment(
      { owner: 'g-digital-by-Garrigues', repo: 'MCP_Market_Distribution', prNumber: 42, marker: RELEASE_MARKER, body },
      client,
    );
    expect(result.action).toBe('created');
  });

  it('throws if the body does not contain the marker (callers must embed it)', async () => {
    const { client, calls } = fakeClient();
    await expect(
      upsertComment(
        {
          owner: 'g-digital-by-Garrigues',
          repo: 'MCP_Market_Distribution',
          prNumber: 42,
          marker: RELEASE_MARKER,
          body: 'forgot to include the marker',
        },
        client,
      ),
    ).rejects.toThrow(/does not contain the marker/);
    expect(calls.listComments).toBe(0);
  });

  it('requests per_page=100 to avoid missing the marker on PRs with many comments', async () => {
    const { client } = fakeClient();
    await upsertComment(
      {
        owner: 'g-digital-by-Garrigues',
        repo: 'MCP_Market_Distribution',
        prNumber: 42,
        marker: RELEASE_MARKER,
        body: `${RELEASE_MARKER}\nbody`,
      },
      client,
    );
    expect(client.listComments).toHaveBeenCalledWith({
      owner: 'g-digital-by-Garrigues',
      repo: 'MCP_Market_Distribution',
      issue_number: 42,
      per_page: 100,
    });
  });

  it('multi-run scenario: 3 successive upserts on the same release produce a SINGLE comment that gets updated in place', async () => {
    const { client, comments, calls } = fakeClient();
    for (const round of [1, 2, 3]) {
      const body = `${RELEASE_MARKER}\n# Release attempt ${round}`;
      await upsertComment(
        { owner: 'g-digital-by-Garrigues', repo: 'MCP_Market_Distribution', prNumber: 42, marker: RELEASE_MARKER, body },
        client,
      );
    }
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain('attempt 3');
    expect(calls).toEqual({ listComments: 3, createComment: 1, updateComment: 2 });
  });
});
