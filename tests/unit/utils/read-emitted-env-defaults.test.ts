import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEmittedEnvDefaults } from '../../../src/utils/read-emitted-env-defaults.js';

// Story 18.5 (AC4/AC6): the scrape hoisted out of the n8n adapter, now shared with
// the install-block generator. Synthetic host only — no product API host may appear
// anywhere in this repo's src/ or templates/, and there is no reason to put one here.
const SYNTHETIC_HOST = 'https://api.example.test';

let pkgDir: string;

async function writeLoginFile(content: string): Promise<void> {
  const toolsDir = path.join(pkgDir, 'src', 'tools');
  await fs.mkdir(toolsDir, { recursive: true });
  await fs.writeFile(path.join(toolsDir, 'session_login.ts'), content, 'utf8');
}

describe('readEmittedEnvDefaults', () => {
  beforeEach(async () => {
    pkgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emitted-env-defaults-'));
  });

  afterEach(async () => {
    await fs.rm(pkgDir, { recursive: true, force: true });
  });

  it('discovers MCP_API_BASE_URL from a double-quoted default in src/tools/session_login.ts', async () => {
    await writeLoginFile(
      `const BASE_URL = process.env.MCP_API_BASE_URL ?? "${SYNTHETIC_HOST}";\n`,
    );
    await expect(readEmittedEnvDefaults(pkgDir)).resolves.toEqual({
      MCP_API_BASE_URL: SYNTHETIC_HOST,
    });
  });

  it('discovers MCP_API_BASE_URL from a single-quoted default', async () => {
    await writeLoginFile(
      `const BASE_URL = process.env.MCP_API_BASE_URL ?? '${SYNTHETIC_HOST}';\n`,
    );
    await expect(readEmittedEnvDefaults(pkgDir)).resolves.toEqual({
      MCP_API_BASE_URL: SYNTHETIC_HOST,
    });
  });

  it('returns {} when src/tools/session_login.ts is absent (EAD Factory has none)', async () => {
    await expect(readEmittedEnvDefaults(pkgDir)).resolves.toEqual({});
  });

  it('returns {} — not { MCP_API_BASE_URL: "" } — when the file carries no matching default', async () => {
    await writeLoginFile('export async function sessionLogin(): Promise<void> {}\n');
    const defaults = await readEmittedEnvDefaults(pkgDir);
    expect(defaults).toEqual({});
    expect(defaults).not.toHaveProperty('MCP_API_BASE_URL');
  });
});
