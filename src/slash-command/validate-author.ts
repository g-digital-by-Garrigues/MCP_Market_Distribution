// Story 6.5: slash-command author validation policy.
//
// The retry-dispatch workflow (Story 4.10) fetches the commenter's
// GitHub collaborator permission level and then decides whether to
// dispatch the retry. This module is the decision policy — extracted
// from the inline workflow JavaScript so it's:
//
//   1. Unit-testable (the inline JS was not),
//   2. The canonical source of truth for which roles are authorized,
//   3. The canonical source of truth for the wording of the rejection reply.
//
// The policy is documented at docs/runbooks/slash-command-policy.md
// with the rationale (FR36/FR37 are publish-state-changing commands
// that consume CI minutes; restricting to repo-write keeps the cost
// surface bounded to people who already have push rights and could
// have triggered the same publish via a tag push anyway).

/** GitHub collaborator permission roles, in descending order of privilege. */
export type AuthorPermission =
  | 'admin'
  | 'maintain'
  | 'write'
  | 'triage'
  | 'read'
  | 'none';

/**
 * Roles that authorize a slash-command dispatch. Write-equivalent (push
 * access) and above.
 *
 * - `admin` — full repo admin
 * - `maintain` — non-admin with settings + push
 * - `write` — push access
 *
 * Explicitly NOT authorized (read-only paths through the repo):
 *
 * - `triage` — can label/close issues but not push code
 * - `read` — read-only collaborator
 * - `none` — not a collaborator at all
 *
 * If GitHub adds a new role above `write` in the future, add it here
 * AND update the unit tests in tests/unit/slash-command/validate-author.test.ts.
 */
export const AUTHORIZED_ROLES: ReadonlySet<AuthorPermission> = new Set([
  'admin',
  'maintain',
  'write',
]);

export interface AuthorValidationResult {
  /** True iff the role is in AUTHORIZED_ROLES. */
  authorized: boolean;
  /** The role we evaluated. 'none' if input was null/undefined/unrecognized. */
  role: AuthorPermission;
  /**
   * Pre-formatted reply message when `authorized` is false. The
   * dispatcher posts this verbatim as a PR comment so the policy
   * wording lives in one place. Undefined when `authorized` is true
   * (no reply needed — the dispatch proceeds).
   */
  unauthorizedReply?: string;
}

/**
 * Validate a GitHub collaborator role for slash-command dispatch
 * authorization.
 *
 * Pure function — no I/O, no side effects. The retry-dispatch
 * workflow is responsible for resolving the role via
 * `repos.getCollaboratorPermissionLevel`; this function decides
 * whether that role authorizes the dispatch and provides the
 * formatted rejection reply when it doesn't.
 *
 * @param role     The role string from GitHub's collaborator API,
 *                 or null/undefined if the API call failed or the
 *                 user isn't a collaborator. Both map to 'none'.
 * @param username The commenter's GitHub login, used in the
 *                 rejection reply. The caller is expected to
 *                 pass the same login they're @-mentioning.
 */
export function validateAuthor(
  role: string | null | undefined,
  username: string,
): AuthorValidationResult {
  const normalized = normalizeRole(role);
  if (AUTHORIZED_ROLES.has(normalized)) {
    return { authorized: true, role: normalized };
  }
  return {
    authorized: false,
    role: normalized,
    unauthorizedReply: `@${username} you need write access to this repo to dispatch a retry. Current role: \`${normalized}\`. See docs/runbooks/slash-command-policy.md for the rationale.`,
  };
}

function normalizeRole(role: string | null | undefined): AuthorPermission {
  if (role === null || role === undefined) return 'none';
  const lc = role.trim().toLowerCase();
  switch (lc) {
    case 'admin':
    case 'maintain':
    case 'write':
    case 'triage':
    case 'read':
    case 'none':
      return lc;
    default:
      // Unknown role — fail closed (treat as 'none', not authorized).
      return 'none';
  }
}
