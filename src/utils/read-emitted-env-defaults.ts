import type { DistributionConfig } from '../schemas/distribution-config.schema.js';

// Story 18.5 (Epic 18): the defaults the EMITTED contract itself carries.
//
// The pipeline may never author a per-product API host (contract boundary:
// `.distribution.yaml`, `.env.example` and `src/` are generator-owned, we only
// consume them). When a required non-secret variable needs a concrete value in a
// published artifact, that value has to come from what we were handed.
//
// Until 2026-11 this was a regex over the generator-owned `src/tools/session_login.ts`
// (`MCP_API_BASE_URL ?? "https://…"`): an implementation detail that would have
// broken silently on any rename or refactor. Generation now DECLARES the host as
// `api_base_url` in `.distribution.yaml` (agreed on #255, first propagated with
// generator @3a1ff12), and, as agreed there, the regex is gone rather than kept as
// a fallback — a second, inferred source would only hide a missing declaration.
//
// Shared by the n8n adapter (credential `baseUrl` default) and the install-block
// generator. Shape is a name → default map on purpose: a second declared default can
// be added without changing either consumer. An absent key means "nothing declared",
// which stays distinguishable from "declared as empty".

/** Defaults the emitted contract itself carries, keyed by env var name. */
export type EmittedEnvDefaults = Readonly<Record<string, string>>;

export function readEmittedEnvDefaults(
  distribution: Pick<DistributionConfig, 'api_base_url'>,
): EmittedEnvDefaults {
  const defaults: Record<string, string> = {};
  // `null` is generation saying "this product has no fixed host" — a contract signal,
  // not a value to paste. Absent is a tag cut before the field existed. Both leave the
  // key out; the caller decides what an undeclared required variable renders as.
  if (typeof distribution.api_base_url === 'string') {
    defaults.MCP_API_BASE_URL = distribution.api_base_url;
  }
  return defaults;
}
