import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateN8nNode } from '../../../../src/adapters/n8n-adapter/generate-n8n-node.js';
import { oauth2NodeSpec } from '../../../helpers/n8n-oauth2-spec.js';

// Epic 18 constraint: the oauth2-client-credentials product (EAD Factory) does not
// take part in the single-user-key work, so its regenerated connector CODE must not
// move. Story 18.1 accepted exactly ONE deviation — a comment word — and nothing
// else was ever budgeted for.
//
// Story 18.4 broke that silently: `AUTO_ID_ROLE_FIELD` and its lookup were emitted
// outside every conditional, so EAD Factory gained an always-empty table and a
// dead branch (17 lines) that nobody declared. It rendered clean, compiled clean
// and passed every other test — the only thing that would have caught it is a
// byte-level pin, so here it is.
//
// The fixtures are the pre-Epic-18 render, produced from a `git worktree` of `main`
// with the same spec literal this test uses. They are `.txt` so neither `tsc` nor
// `eslint src tests` treats a frozen artifact as live source.
//
// If this test fails, the answer is almost never "update the fixture". It is:
// gate the new emission on the data that motivates it (the `{{#if autoIdRoleFields}}`
// precedent), so a product without that data emits nothing at all. Widening
// ACCEPTED_DEVIATIONS is a deliberate, reviewed act — it changes what EAD Factory's
// next release diff looks like, which Story 18.8 reviews by hand.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const fixturesDir = path.join(repoRoot, 'tests/fixtures/n8n-oauth2-byte-identity');

/**
 * Every difference Epic 18 is allowed to introduce into the oauth2 render, applied
 * to the pre-Epic-18 bytes to produce the expected current bytes. One entry, from
 * Story 18.1: the placeholder-substitution comment names a credential key, and the
 * user-key rename made `{email}` the wrong example. Behaviour-free.
 */
const ACCEPTED_DEVIATIONS: ReadonlyArray<{ story: string; before: string; after: string }> = [
  {
    story: '18.1',
    before: '// matched by credential key name (e.g. a {baseUrl} or {email} in a path).',
    after: '// matched by credential key name (e.g. a {baseUrl} or {userKey} in a path).',
  },
];

/**
 * The same budget for the credentials file. One entry, from Story 18.1 (FR62):
 * the `API Base URL` description was pipeline-invented copy that named a fake
 * host (`https://api.example.com`); it now carries the description authored in
 * the emitted `.env.example`. Hugo's call, 2026-09-07: respect the contract text.
 *
 * This is a text-only change — the credential's name, shape and fields are
 * untouched, so saved EAD Factory credentials keep working. EAD Factory is NOT
 * released in Epic 18, so this ships whenever EAD Factory next bumps; its
 * release notes must mention the changed field description. Tracked as Story
 * 18.10 in the epic.
 */
const ACCEPTED_CREDENTIAL_DEVIATIONS: ReadonlyArray<{ story: string; before: string; after: string }> = [
  {
    story: '18.1',
    before:
      "      description: 'Base URL of the EAD Factory REST API. Leave as-is for the production environment (default: https://api.example.com).',\n",
    after:
      '      description: "Gateway ROOT URL (e.g. https://api.int.gcloudfactory.com) \u2014 each manager\'s path prefix is appended automatically; do NOT include a manager path here",\n',
  },
];

async function renderOauth2Node(): Promise<{ node: string; credentials: string }> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth2-identity-'));
  try {
    await generateN8nNode({ spec: oauth2NodeSpec(), outputDir });
    return {
      node: await fs.readFile(path.join(outputDir, 'nodes/EadFactory/EadFactory.node.ts'), 'utf8'),
      credentials: await fs.readFile(
        path.join(outputDir, 'credentials/EadFactoryOAuth2Api.credentials.ts'),
        'utf8',
      ),
    };
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

function applyAcceptedDeviations(
  preEpic18: string,
  deviations: ReadonlyArray<{ story: string; before: string; after: string }> = ACCEPTED_DEVIATIONS,
): string {
  let expected = preEpic18;
  for (const dev of deviations) {
    expect(
      expected.includes(dev.before),
      `accepted deviation from story ${dev.story} no longer matches the pre-Epic-18 fixture`,
    ).toBe(true);
    expected = expected.replace(dev.before, dev.after);
  }
  return expected;
}

describe('oauth2-client-credentials render — byte identity budget', () => {
  it('differs from the pre-Epic-18 node.ts by exactly the accepted deviations', async () => {
    const preEpic18 = await fs.readFile(
      path.join(fixturesDir, 'EadFactory.node.pre-epic18.txt'),
      'utf8',
    );
    const { node } = await renderOauth2Node();
    expect(node).toBe(applyAcceptedDeviations(preEpic18));
  });

  it('differs from the pre-Epic-18 credentials file by exactly the accepted deviations', async () => {
    const preEpic18 = await fs.readFile(
      path.join(fixturesDir, 'EadFactoryOAuth2Api.credentials.pre-epic18.txt'),
      'utf8',
    );
    const { credentials } = await renderOauth2Node();
    expect(credentials).toBe(applyAcceptedDeviations(preEpic18, ACCEPTED_CREDENTIAL_DEVIATIONS));
  });

  it('changes nothing about the credential name, class or field set', async () => {
    // The reason the description change is safe to ship on EAD Factory's own
    // schedule: saved credentials bind to the class and field names, not to copy.
    const preEpic18 = await fs.readFile(
      path.join(fixturesDir, 'EadFactoryOAuth2Api.credentials.pre-epic18.txt'),
      'utf8',
    );
    const { credentials } = await renderOauth2Node();
    const shape = (src: string) =>
      src.split('\n').filter((l) => /name = |extends = |name: '|displayName: '/.test(l));
    expect(shape(credentials)).toEqual(shape(preEpic18));
  });

  it('emits no role-alias table or lookup when the product has no role-aware operation', async () => {
    // The named assertion, so the failure reads as a cause rather than as a diff:
    // an empty map must produce NOTHING, not `const AUTO_ID_ROLE_FIELD … = {\n};`.
    const { node } = await renderOauth2Node();
    expect(oauth2NodeSpec().autoIdRoleFields).toBeUndefined();
    expect(node).not.toContain('AUTO_ID_ROLE_FIELD');
    expect(node).not.toContain('roleRule');
  });

  it('emits the role-alias table and lookup when the product does have one', async () => {
    // The other half of the gate: gating must not have disabled the feature.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth2-identity-role-'));
    try {
      await generateN8nNode({
        spec: {
          ...oauth2NodeSpec(),
          autoIdRoleFields: [
            {
              operation: 'signature_participant_create',
              param: 'role',
              byValue: { SIGNATORY: 'signatoryId', VALIDATOR: 'validatorId' },
            },
          ],
        },
        outputDir,
      });
      const node = await fs.readFile(
        path.join(outputDir, 'nodes/EadFactory/EadFactory.node.ts'),
        'utf8',
      );
      expect(node).toContain(
        `  'signature_participant_create': { param: 'role', byValue: {"SIGNATORY":"signatoryId","VALIDATOR":"validatorId"} },`,
      );
      expect(node).toContain('const roleRule = AUTO_ID_ROLE_FIELD[operation];');
      // No blank-line damage on the emitting side either: the table sits one blank
      // line below AUTO_ID_OUTPUT_FIELD and one above OPERATION_META, as authored.
      expect(node).toContain('};\n\n// Role-specific alias');
      expect(node).toContain('};\n\n// HTTP metadata per operation');
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });

  it('resolves the role alias only through own properties of the emitted table', async () => {
    // FR-hardening: `role` is a caller-supplied request value and `byValue` is a
    // plain object literal, so an unguarded index reaches Object.prototype — a
    // role of 'constructor' or 'toString' would yield a truthy non-string and
    // write a garbage key onto the tool output. Assert the guard is in the
    // EMITTED code, which is where the value is actually indexed.
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oauth2-identity-proto-'));
    try {
      await generateN8nNode({
        spec: {
          ...oauth2NodeSpec(),
          autoIdRoleFields: [
            { operation: 'signature_participant_create', param: 'role', byValue: { SIGNATORY: 'signatoryId' } },
          ],
        },
        outputDir,
      });
      const node = await fs.readFile(
        path.join(outputDir, 'nodes/EadFactory/EadFactory.node.ts'),
        'utf8',
      );
      expect(node).toContain(
        'Object.prototype.hasOwnProperty.call(roleRule.byValue, roleKey)',
      );
      // And never the unguarded form the review found.
      expect(node).not.toContain(`roleRule.byValue[String(body[roleRule.param] ?? '')]`);
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe('the role-alias lookup semantics the emitted code implements', () => {
  // Executable proof that the guarded lookup behaves: same shape as the emitted
  // block, exercised directly, because the generated node cannot be imported here.
  function lookup(byValue: Record<string, string>, role: unknown): string | undefined {
    const roleKey = String(role ?? '');
    return Object.prototype.hasOwnProperty.call(byValue, roleKey) ? byValue[roleKey] : undefined;
  }

  const byValue = { SIGNATORY: 'signatoryId', VALIDATOR: 'validatorId' };

  it('maps a declared role to its alias', () => {
    expect(lookup(byValue, 'SIGNATORY')).toBe('signatoryId');
    expect(lookup(byValue, 'VALIDATOR')).toBe('validatorId');
  });

  it('maps an undeclared role (OBSERVER) to nothing', () => {
    expect(lookup(byValue, 'OBSERVER')).toBeUndefined();
    expect(lookup(byValue, undefined)).toBeUndefined();
  });

  it('does not resolve Object.prototype members', () => {
    for (const role of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(lookup(byValue, role), `role '${role}' must not resolve`).toBeUndefined();
    }
  });
});
