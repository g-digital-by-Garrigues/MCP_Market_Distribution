// Story 3.6: PR comment upserter.
//
// Both Story 2.6's gate-failure summary and Story 3.7's final-report job
// post a markdown comment to the release PR. We want them to UPDATE the
// existing comment in place rather than stack duplicate comments on every
// re-run — engineers should see a single canonical comment per (run_id,
// release) at any moment.
//
// The find-and-update key is a stable HTML marker embedded as line 1 of
// the body, e.g. `<!-- release-report:ead-factory-v1.0.0 -->` or
// `<!-- error-report:<pipeline_run_id> -->`. We never delete comments —
// the only mutations are create + update.
//
// Inject a small GithubClient interface so unit tests can run without
// touching the network. The composite action wires this to @octokit/rest
// via @actions/github.

export interface GithubComment {
  readonly id: number;
  readonly body: string | null | undefined;
}

export interface GithubClient {
  listComments(args: {
    owner: string;
    repo: string;
    issue_number: number;
    per_page?: number;
  }): Promise<readonly GithubComment[]>;
  createComment(args: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ id: number }>;
  updateComment(args: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }): Promise<void>;
}

export interface UpsertCommentInput {
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly repo: string;
  /** Target PR number (== issue number on GitHub's API). */
  readonly prNumber: number;
  /**
   * The exact marker string that uniquely identifies this comment family
   * — e.g. `<!-- release-report:ead-factory-v1.0.0 -->`. We match
   * existing comments by `body.includes(marker)` so the marker can sit
   * anywhere in the body, but in practice the release reporter puts it
   * on line 1 and the error reporter puts it on line 1 too.
   */
  readonly marker: string;
  /** Full markdown body to post (must already contain the marker). */
  readonly body: string;
}

export type UpsertAction = 'created' | 'updated';

export interface UpsertCommentResult {
  readonly action: UpsertAction;
  readonly comment_id: number;
}

export async function upsertComment(
  input: UpsertCommentInput,
  client: GithubClient,
): Promise<UpsertCommentResult> {
  if (!input.body.includes(input.marker)) {
    throw new Error(
      `upsertComment: body does not contain the marker "${input.marker}". The marker must be embedded in the body so future runs can find this comment.`,
    );
  }

  // GitHub paginates by 30 by default; ask for the max (100) since release
  // PRs occasionally accumulate many comments and we don't want to miss
  // ours and create a duplicate.
  const comments = await client.listComments({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    per_page: 100,
  });

  const existing = comments.find(
    (c) => typeof c.body === 'string' && c.body.includes(input.marker),
  );

  if (existing) {
    await client.updateComment({
      owner: input.owner,
      repo: input.repo,
      comment_id: existing.id,
      body: input.body,
    });
    return { action: 'updated', comment_id: existing.id };
  }

  const created = await client.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    body: input.body,
  });
  return { action: 'created', comment_id: created.id };
}
