import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateEnvironmentVariables } from '../../../src/generators/generate-environment-variables.js';
import { POST_E18_ENV_VARS } from '../../fixtures/env-sets/post-e18-user-key.js';

// Story 18.1 / FR61: the n8n credential form is derived exclusively from the
// emitted contract. POST_E18_ENV_VARS is hand-written so the adapter tests read
// well, but it must never drift from the generator-owned `.env.example`. This
// round trip pins it: the committed 76-line GoCertius `.env.example` (origin/main
// @ 2623d6e), run through the real generator, must reproduce the fixture exactly —
// same entries, same order (localeCompare, so MCP_ALLOW_INSECURE_FILE_URL sorts
// before MCP_ALLOWED_HOSTS), same isSecret/isRequired, and the same
// ` (See … for credential acquisition.)` suffix on the two secrets.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_EXAMPLE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'env-example',
  'gocertius-post-e18.env.example',
);

describe('POST_E18_ENV_VARS ↔ the emitted GoCertius .env.example', () => {
  it('is exactly what generateEnvironmentVariables emits for the committed .env.example', async () => {
    const envExampleContent = await fs.readFile(ENV_EXAMPLE, 'utf8');
    const { environmentVariables } = generateEnvironmentVariables({
      envExampleContent,
      credentialHelpUrl: 'https://www.gocertius.io',
    });
    expect(environmentVariables).toEqual(POST_E18_ENV_VARS);
  });

  it('declares 13 variables, one credential secret, and a required non-secret base URL', async () => {
    const envExampleContent = await fs.readFile(ENV_EXAMPLE, 'utf8');
    const { environmentVariables } = generateEnvironmentVariables({
      envExampleContent,
      credentialHelpUrl: 'https://www.gocertius.io',
    });
    expect(environmentVariables).toHaveLength(13);
    // The retired email/password flow is gone from the emitted contract.
    const names = environmentVariables.map((v) => v.name);
    expect(names).not.toContain('MCP_AUTH_EMAIL');
    expect(names).not.toContain('MCP_AUTH_PASSWORD');
    expect(names).not.toContain('MCP_AUTH_JWT');
    expect(names).not.toContain('MCP_SVC_TOKEN_URL');
    // Requiredness is NOT inferred from secrecy — the fixture pins both
    // off-diagonal cases (FR61).
    const baseUrl = environmentVariables.find((v) => v.name === 'MCP_API_BASE_URL')!;
    expect(baseUrl).toMatchObject({ isSecret: false, isRequired: true });
    const clientSecret = environmentVariables.find((v) => v.name === 'MCP_SVC_CLIENT_SECRET')!;
    expect(clientSecret).toMatchObject({ isSecret: true, isRequired: false });
    const userKey = environmentVariables.find((v) => v.name === 'MCP_AUTH_USER_KEY')!;
    expect(userKey).toMatchObject({ isSecret: true, isRequired: true });
    expect(userKey.description).toContain(
      '(See https://www.gocertius.io for credential acquisition.)',
    );
  });
});
