import { describe, expect, it } from 'vitest';
import { readEmittedEnvDefaults } from '../../../src/utils/read-emitted-env-defaults.js';

// The API host is DECLARED by generation as `.distribution.yaml#api_base_url`
// (agreed on #255; it replaced a regex over the generator-owned session_login.ts).
// Synthetic host only — no product API host may appear anywhere in this repo's src/
// or templates/, and there is no reason to put one here.
const SYNTHETIC_HOST = 'https://api.example.test';

describe('readEmittedEnvDefaults', () => {
  it('maps a declared api_base_url onto MCP_API_BASE_URL', () => {
    expect(readEmittedEnvDefaults({ api_base_url: SYNTHETIC_HOST })).toEqual({
      MCP_API_BASE_URL: SYNTHETIC_HOST,
    });
  });

  it('returns {} when generation declares the product has no fixed host (null)', () => {
    const defaults = readEmittedEnvDefaults({ api_base_url: null });
    expect(defaults).toEqual({});
    expect(defaults).not.toHaveProperty('MCP_API_BASE_URL');
  });

  it('returns {} — not { MCP_API_BASE_URL: "" } — for a tag cut before the field existed', () => {
    const defaults = readEmittedEnvDefaults({});
    expect(defaults).toEqual({});
    expect(defaults).not.toHaveProperty('MCP_API_BASE_URL');
  });
});
