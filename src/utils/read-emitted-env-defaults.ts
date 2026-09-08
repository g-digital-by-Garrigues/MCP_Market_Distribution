import { promises as fs } from 'node:fs';
import path from 'node:path';

// Story 18.5 (Epic 18): the defaults the EMITTED source itself carries.
//
// The pipeline may never author a per-product API host (contract boundary:
// `.env.example` and `src/` are generator-owned, we only consume them). When a
// required non-secret variable needs a concrete value in a published artifact,
// that value has to be DISCOVERED from the source tree we were handed.
//
// This scrape was previously private to the n8n adapter, where it filled the
// credential's `baseUrl` default. It is hoisted here — `src/utils/` is the
// neutral home both the adapters and the generators already depend on — so the
// install-block generator can reuse it without creating a layering edge in
// either direction.
//
// Shape is a name → default map on purpose: a second rule can be added later
// without a second hoist. An absent key means "nothing discoverable", which
// stays distinguishable from "discovered as empty".

/** Defaults the emitted source itself carries, keyed by env var name. */
export type EmittedEnvDefaults = Readonly<Record<string, string>>;

// Extract the production API base URL from the MCP's session_login.ts.
// Looks for: MCP_API_BASE_URL ?? "https://..." or MCP_API_BASE_URL ?? 'https://...'
const BASE_URL_RE = /MCP_API_BASE_URL\s*\?\?\s*["'](https?:\/\/[^"']+)["']/;

export async function readEmittedEnvDefaults(packageDir: string): Promise<EmittedEnvDefaults> {
  const defaults: Record<string, string> = {};

  const loginFile = path.join(packageDir, 'src', 'tools', 'session_login.ts');
  try {
    const content = await fs.readFile(loginFile, 'utf8');
    const m = BASE_URL_RE.exec(content);
    if (m?.[1]) defaults.MCP_API_BASE_URL = m[1];
  } catch {
    // No session_login.ts (EAD Factory has none) — nothing discoverable here.
    // That is a contract signal, not a constant to paste: the caller decides
    // what an undiscoverable required variable renders as.
  }

  return defaults;
}
