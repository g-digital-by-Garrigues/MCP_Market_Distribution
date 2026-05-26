import { describe, expect, it } from 'vitest';
import {
  AUTHORIZED_ROLES,
  validateAuthor,
  type AuthorPermission,
} from '../../../src/slash-command/validate-author.js';

describe('validateAuthor — authorized roles', () => {
  it.each<AuthorPermission>(['admin', 'maintain', 'write'])(
    'authorizes %s',
    (role) => {
      const result = validateAuthor(role, 'someone');
      expect(result.authorized).toBe(true);
      expect(result.role).toBe(role);
      expect(result.unauthorizedReply).toBeUndefined();
    },
  );

  it('exposes the authorized role set as a frozen, read-only Set', () => {
    expect(AUTHORIZED_ROLES.has('admin')).toBe(true);
    expect(AUTHORIZED_ROLES.has('maintain')).toBe(true);
    expect(AUTHORIZED_ROLES.has('write')).toBe(true);
    expect(AUTHORIZED_ROLES.has('triage')).toBe(false);
    expect(AUTHORIZED_ROLES.has('read')).toBe(false);
    expect(AUTHORIZED_ROLES.has('none')).toBe(false);
    expect(AUTHORIZED_ROLES.size).toBe(3);
  });
});

describe('validateAuthor — unauthorized roles', () => {
  it.each<AuthorPermission>(['triage', 'read', 'none'])(
    'rejects %s with a formatted reply',
    (role) => {
      const result = validateAuthor(role, 'someone');
      expect(result.authorized).toBe(false);
      expect(result.role).toBe(role);
      expect(result.unauthorizedReply).toBeDefined();
      expect(result.unauthorizedReply).toContain('@someone');
      expect(result.unauthorizedReply).toContain(`\`${role}\``);
      expect(result.unauthorizedReply).toContain('docs/runbooks/slash-command-policy.md');
    },
  );

  it('preserves the @-mention username exactly', () => {
    const result = validateAuthor('read', 'user-with-dashes_and_underscores');
    expect(result.unauthorizedReply).toContain('@user-with-dashes_and_underscores');
  });
});

describe('validateAuthor — null/undefined/unknown input', () => {
  it('maps null role to "none" and rejects (API error case)', () => {
    const result = validateAuthor(null, 'someone');
    expect(result.authorized).toBe(false);
    expect(result.role).toBe('none');
  });

  it('maps undefined role to "none" and rejects', () => {
    const result = validateAuthor(undefined, 'someone');
    expect(result.authorized).toBe(false);
    expect(result.role).toBe('none');
  });

  it('maps unknown role strings to "none" and rejects (fail-closed)', () => {
    const result = validateAuthor('owner', 'someone');
    expect(result.authorized).toBe(false);
    expect(result.role).toBe('none');
  });

  it('normalizes case (GitHub API returns lowercase but be defensive)', () => {
    expect(validateAuthor('Admin', 'someone').authorized).toBe(true);
    expect(validateAuthor('WRITE', 'someone').authorized).toBe(true);
    expect(validateAuthor('  Maintain  ', 'someone').authorized).toBe(true);
  });
});

describe('validateAuthor — message wording stability', () => {
  it('includes the policy doc reference (smoke test for runbook discoverability)', () => {
    const reply = validateAuthor('read', 'someone').unauthorizedReply ?? '';
    expect(reply).toMatch(/docs\/runbooks\/slash-command-policy\.md/);
  });

  it('mentions the current role so operators see what they have', () => {
    const reply = validateAuthor('triage', 'someone').unauthorizedReply ?? '';
    expect(reply).toMatch(/triage/);
  });

  it('uses "write access" not "push access" — matches the Story 6.5 acceptance wording', () => {
    const reply = validateAuthor('read', 'someone').unauthorizedReply ?? '';
    expect(reply).toMatch(/write access/);
  });
});
