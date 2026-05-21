import { describe, expect, it } from 'vitest';
import { generateEnvironmentVariables } from '../../../src/generators/generate-environment-variables.js';

const HELP_URL = 'https://eadtrust.example.com/onboarding';

describe('generateEnvironmentVariables — happy paths', () => {
  it('converts a single KEY=value line into one entry with name as description', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: 'APP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables).toEqual([
      { description: 'APP_PORT', isRequired: true, isSecret: false, name: 'APP_PORT' },
    ]);
  });

  it('uses a preceding # comment as description when present', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# The HTTP port the server binds to.\nAPP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe(
      'The HTTP port the server binds to.',
    );
  });

  it('joins multiple consecutive # comments into the description', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent:
        '# First line of description.\n# Second line continues.\nAPP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe(
      'First line of description. Second line continues.',
    );
  });

  it('flips isRequired to false when a # OPTIONAL marker precedes the key', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# OPTIONAL\nAPP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.isRequired).toBe(false);
  });

  it('combines a description comment with the # OPTIONAL marker', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# The HTTP port.\n# OPTIONAL\nAPP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe('The HTTP port.');
    expect(manifest.environmentVariables[0]?.isRequired).toBe(false);
  });

  it('an empty line between a comment and a KEY resets the description buffer', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# Detached comment.\n\nAPP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe('APP_PORT');
  });
});

describe('generateEnvironmentVariables — isSecret detection', () => {
  it('flags *_SECRET, *_TOKEN, *_KEY, *_PASSWORD suffixes as isSecret=true and appends credential URL', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: [
        'OAUTH_CLIENT_SECRET=xxx',
        'GITHUB_TOKEN=ghp_xxx',
        'API_KEY=abc',
        'DB_PASSWORD=hunter2',
        'APP_PORT=3000',
      ].join('\n'),
      credentialHelpUrl: HELP_URL,
    });

    const byName = Object.fromEntries(
      manifest.environmentVariables.map((e) => [e.name, e]),
    );
    expect(byName.OAUTH_CLIENT_SECRET?.isSecret).toBe(true);
    expect(byName.GITHUB_TOKEN?.isSecret).toBe(true);
    expect(byName.API_KEY?.isSecret).toBe(true);
    expect(byName.DB_PASSWORD?.isSecret).toBe(true);
    expect(byName.APP_PORT?.isSecret).toBe(false);
    for (const name of ['OAUTH_CLIENT_SECRET', 'GITHUB_TOKEN', 'API_KEY', 'DB_PASSWORD']) {
      expect(byName[name]?.description).toContain(
        `(See ${HELP_URL} for credential acquisition.)`,
      );
    }
    expect(byName.APP_PORT?.description).not.toContain(HELP_URL);
  });

  it('treats keys in the secret allowlist as secrets even without a matching suffix', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: 'CUSTOM_VAULT_HANDLE=abc\nNORMAL_VAR=def\n',
      credentialHelpUrl: HELP_URL,
      secretKeysAllowlist: ['CUSTOM_VAULT_HANDLE'],
    });
    const byName = Object.fromEntries(
      manifest.environmentVariables.map((e) => [e.name, e]),
    );
    expect(byName.CUSTOM_VAULT_HANDLE?.isSecret).toBe(true);
    expect(byName.NORMAL_VAR?.isSecret).toBe(false);
  });
});

describe('generateEnvironmentVariables — NFR-S5 / NFR-R1', () => {
  it('NFR-S5: no concrete values from .env.example appear in the output', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: [
        'API_KEY=super-secret-value-12345',
        '# The port',
        'APP_PORT=8080',
        'OAUTH_CLIENT_SECRET="quoted-value-with-spaces"',
      ].join('\n'),
      credentialHelpUrl: HELP_URL,
    });
    const stringified = JSON.stringify(manifest);
    expect(stringified).not.toContain('super-secret-value-12345');
    expect(stringified).not.toContain('8080');
    expect(stringified).not.toContain('quoted-value-with-spaces');
  });

  it('NFR-R1: entries are sorted alphabetically by name', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: 'ZULU=1\nALPHA=2\nMIKE=3\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables.map((e) => e.name)).toEqual([
      'ALPHA',
      'MIKE',
      'ZULU',
    ]);
  });

  it('NFR-R1: each entry serializes with alphabetically ordered keys', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: 'API_KEY=abc\n',
      credentialHelpUrl: HELP_URL,
    });
    const stringified = JSON.stringify(manifest.environmentVariables[0]);
    expect(stringified).toBe(
      `{"description":"API_KEY (See ${HELP_URL} for credential acquisition.)","isRequired":true,"isSecret":true,"name":"API_KEY"}`,
    );
  });

  it('NFR-R1: output is byte-identical when the same input is run twice', () => {
    const input = {
      envExampleContent: '# Port\nAPP_PORT=3000\n# OPTIONAL\nAPI_KEY=abc\n',
      credentialHelpUrl: HELP_URL,
    };
    const first = JSON.stringify(generateEnvironmentVariables(input));
    const second = JSON.stringify(generateEnvironmentVariables(input));
    expect(first).toBe(second);
  });
});

describe('generateEnvironmentVariables — structured metadata (# description:/isSecret:/isRequired:)', () => {
  it('uses # description: as the description and ignores preceding free-text comments (section headers)', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: [
        '# Flow 1: Email / password',
        '# description: Your account email address',
        '# isSecret: false',
        'MCP_AUTH_EMAIL=',
      ].join('\n'),
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe(
      'Your account email address',
    );
  });

  it('honors # isSecret: true|false instead of guessing from the name suffix', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: [
        '# description: A username with no name-suffix hint',
        '# isSecret: true',
        'MCP_AUTH_HANDLE=',
      ].join('\n'),
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.isSecret).toBe(true);
    expect(manifest.environmentVariables[0]?.description).toContain(HELP_URL);
  });

  it('honors # isRequired: false (so PORT-style optional vars stop landing in smithery.required)', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: [
        '# Transport (optional)',
        '# description: HTTP port when running in hosted mode',
        '# isRequired: false',
        '# isSecret: false',
        'PORT=8080',
      ].join('\n'),
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]).toMatchObject({
      description: 'HTTP port when running in hosted mode',
      isRequired: false,
      isSecret: false,
      name: 'PORT',
    });
  });

  it('falls back to free-text concatenation when no structured field is present (back-compat with EAD-Factory)', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# Okta application client ID.\n# Required.\nOKTA_CLIENT_ID=\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe(
      'Okta application client ID. Required.',
    );
  });

  it('a malformed boolean in # isSecret falls back to the name-suffix heuristic', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: [
        '# description: My secret-y thing',
        '# isSecret: probably',
        'API_KEY=',
      ].join('\n'),
      credentialHelpUrl: HELP_URL,
    });
    // API_KEY matches the *_KEY suffix → isSecret stays true via heuristic.
    expect(manifest.environmentVariables[0]?.isSecret).toBe(true);
  });
});

describe('generateEnvironmentVariables — edge cases', () => {
  it('returns an empty array for an empty .env.example', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables).toEqual([]);
  });

  it('returns an empty array when only comments and blank lines are present', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# Just a comment\n\n# Another\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables).toEqual([]);
  });

  it('deduplicates: the first occurrence wins for repeated keys', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# First description\nAPP_PORT=3000\n# Override attempt\nAPP_PORT=4000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables).toHaveLength(1);
    expect(manifest.environmentVariables[0]?.description).toBe('First description');
  });

  it('handles CRLF line endings the same as LF', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: '# Comment\r\nAPP_PORT=3000\r\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.description).toBe('Comment');
  });

  it('accepts `export KEY=value` shell-style declarations', () => {
    const manifest = generateEnvironmentVariables({
      envExampleContent: 'export APP_PORT=3000\n',
      credentialHelpUrl: HELP_URL,
    });
    expect(manifest.environmentVariables[0]?.name).toBe('APP_PORT');
  });
});
