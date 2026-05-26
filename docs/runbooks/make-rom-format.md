# Make ROM artifact format

Specification of the `make-rom.json` artifact produced by [`src/adapters/make-rom/generate-make-rom.ts`](../../src/adapters/make-rom/generate-make-rom.ts). This document is the contract that the generator's output adheres to, and the reference for downstream consumers (humans importing into Make.com today; a future automated Make publisher tomorrow).

Addresses [Story 6.7](../../_bmad-output/planning-artifacts/epics.md). The original story scoped a markdown effort-estimate report (FR33); the implementation evolved into a structured Make-module descriptor instead — this doc reflects what was actually built.

## Status

- **v1.1 (current)**: artifact is generated and committed alongside other release artifacts. No automated publication to Make.com — the artifact is a hand-off to an operator who imports it manually.
- **Future (deferred)**: automated Make.com publish flow. Outside the scope of any current epic.

## File location and naming

The generator writes to:
```
<packageDir>/.make-rom/make-rom.json
```

Where `<packageDir>` is `pending-to-publish/<mcp-name>/` at pipeline runtime. The directory is created if missing. The file overwrites any previous version (deterministic per run).

## Top-level shape

```json
{
  "artifactSchemaVersion": 1,
  "module":     { ... },
  "connection": { ... },
  "actions":    [ ... ],
  "notes":      [ ... ]
}
```

### `artifactSchemaVersion`

Integer. Currently `1`. Bumped on any breaking change to the artifact shape (field rename, type change, removed required field). Additive changes — new optional fields — do **not** bump this version.

### `module`

The Make.com "module" metadata. One module per MCP.

| Field | Type | Source | Notes |
|---|---|---|---|
| `name` | string | `mcpName` input | kebab-case, matches the MCP id |
| `label` | string | derived from `name` | Title Case for Make's UI |
| `description` | string | `server.json#description` | falls back to a generated stub if missing |
| `sourceMcpPackageName` | string | `.distribution.yaml#npm_package_name` | full scoped name, e.g. `@g-digital/mcp-ead-factory` |
| `version` | string | pipeline input | aligned 1:1 with the source MCP version |
| `sourceRepoUrl` | string | `server.json#repository.url` | resolved against repository url; fallback to npm package URL |

### `connection`

The Make.com "connection" — the auth and config the operator's Make scenarios will reuse across actions. Derived from `server.json#packages[].environmentVariables` (the same source used for npm install blocks and Smithery `configSchema`).

```json
{
  "name": "<camelCaseFromMcpName>Api",
  "label": "<Title Case> Connection",
  "fields": [
    {
      "envName": "MCP_OPENID_CLIENT_ID",
      "label": "Mcp Openid Client Id",
      "type": "text",
      "required": true,
      "help": "<from env var description>"
    },
    {
      "envName": "MCP_AUTH_PASSWORD",
      "label": "Mcp Auth Password",
      "type": "password",
      "required": true,
      "help": "..."
    }
  ]
}
```

**Field type mapping** (derived from `isSecret`):
- `isSecret: true` → Make `password` field type
- `isSecret: false` (or omitted) → Make `text` field type

**Field `required`** maps directly from the env var's `isRequired` flag.

### `actions[]`

One entry per MCP tool surfaced by `tools/list`. The Inspector harness is launched against the MCP's `dist/server.js` (same harness used by Track A Layer 2) to enumerate the tool list — so the action set is always in sync with what the MCP actually advertises at runtime, not what's hand-written in metadata.

```json
{
  "name": "generate_evidence",
  "label": "Generate Evidence",
  "description": "Full workflow: authenticate ... and poll until COMPLETED or ERROR.",
  "parameters": [
    {
      "name": "file_path",
      "label": "File Path",
      "type": "text",
      "required": true,
      "help": "Absolute path to the file to hash and upload."
    },
    {
      "name": "metadata",
      "label": "Metadata",
      "type": "json",
      "required": false,
      "loweredFromComplexSchema": true,
      "help": "Free-form metadata to attach to the evidence."
    }
  ],
  "communication": {
    "placeholder": true,
    "placeholderReason": "MCP tools speak stdio JSON-RPC; Make needs an HTTP gateway. Point this at your hosted MCP-over-HTTP bridge before publishing the module.",
    "mcpToolName": "generate_evidence"
  }
}
```

#### Parameter type mapping

Derived from each tool's `inputSchema` (JSON Schema). Lowering rules in [`json-schema-to-make-param.ts`](../../src/adapters/make-rom/json-schema-to-make-param.ts):

| JSON Schema | Make param `type` | Notes |
|---|---|---|
| `string` (no enum, no format) | `text` | plain string |
| `string` + `enum` | `select` | `options` populated from the enum |
| `string` + `format: "password"` | (still `text`; see connection above) | Passwords belong in the connection, not action params |
| `number` (float-capable) | `number` | |
| `integer` | `integer` | |
| `boolean` | `boolean` | |
| `array` of any | `json` | with `loweredFromComplexSchema: true` |
| `object` (nested) | `json` | with `loweredFromComplexSchema: true` |
| Any unrecognized | `json` | with `loweredFromComplexSchema: true` |

`loweredFromComplexSchema: true` is the explicit signal to the human operator that this parameter needs hand-curation in Make's UI — the structure was too rich for Make's primitive-parameter model to express without losing fidelity, so the artifact ships it as JSON and expects the operator to compose the inner shape in Make's expression editor.

#### `communication` block (placeholder)

MCP servers speak **stdio JSON-RPC**, not HTTP. Make.com modules require an HTTP "communication" spec (URL, method, headers, body). The generator can't auto-derive this — the operator must run an HTTP gateway in front of the MCP and point Make at it.

The artifact emits this gap explicitly:

```json
"communication": {
  "placeholder": true,
  "placeholderReason": "MCP tools speak stdio JSON-RPC; Make needs an HTTP gateway...",
  "mcpToolName": "<tool name>"
}
```

The `mcpToolName` field is the tool the gateway must route this Make action to. The operator reads this and configures their gateway's routing accordingly.

### `notes[]`

Array of warning strings the generator surfaced while building the artifact. Always include:

- One note per parameter that was lowered to `json` from a complex schema (so the human sees the count up front)
- The HTTP gateway placeholder reminder

The operator should treat `notes` as a manual-completion checklist before importing the module into Make.

## Determinism

The generator is deterministic given identical inputs (same MCP source, same version, same `.distribution.yaml`). Output JSON keys are alphabetically ordered in nested objects (NFR-R1); arrays preserve source order (`tools/list` order from the Inspector harness, env var declaration order from `server.json`).

This means the file can be byte-compared between consecutive pipeline runs to detect drift.

## Validation

There is no published JSON Schema for the artifact yet — the TypeScript types in [`types.ts`](../../src/adapters/make-rom/types.ts) are the canonical contract. Consumers (humans, future automated publishers) should treat that file as authoritative.

If you need to validate an artifact file outside the pipeline, the safest approach today is to `import type { MakeRomArtifact } from '@g-digital/mcp-market-distribution/adapters/make-rom/types'` and use TypeScript's structural typing.

## When the generator runs

- Track B parallel job: `generate-make-rom` is queued alongside the n8n adapter generation
- Always runs on a real publish (not just dry-run)
- Failure modes (any throw `GenerateMakeRomError`):
  - `tools_list` — Inspector harness couldn't enumerate the MCP's tools (the MCP wouldn't start, or crashed on initialize)
  - `server_json` — `server.json` is missing or malformed
  - `distribution_config` — `.distribution.yaml` is missing or fails schema validation
  - `launch` — `dist/server.js` (or the resolved entry) doesn't exist

If any of these fire, the corresponding pipeline job fails with a structured `ErrorReport` pointing at the missing/broken file. Fix the source artifact and re-run `/prep-mcp`.

## See also

- [`release-checklist.md`](./release-checklist.md) — pre-publish runbook that ensures the inputs (server.json, .distribution.yaml, dist/) are sound
- [`generate-make-rom.ts`](../../src/adapters/make-rom/generate-make-rom.ts) — the generator
- [`types.ts`](../../src/adapters/make-rom/types.ts) — the canonical type contract
- [`json-schema-to-make-param.ts`](../../src/adapters/make-rom/json-schema-to-make-param.ts) — JSON-schema → Make param lowering
- [Story 6.7 acceptance criteria](../../_bmad-output/planning-artifacts/epics.md) — original story
