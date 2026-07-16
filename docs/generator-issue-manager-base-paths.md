# DRAFT — generator issue (not yet filed)

**Target repo:** `g-digital-by-Garrigues/Suite-GoCertius-MCP-Generator`
**Status:** awaiting Hugo's authorization to file. Delete this file once the issue exists and the contract doc cites its number.
**Routing rationale:** `.distribution.yaml` is generator-owned per `docs/n8n-adapter-contract.md` → "Division of ownership". Hand-editing `EAD-Factory-MCP/.distribution.yaml` would be wiped by the next regen — the exact trap generator issue #48 documented for `n8n_connector_display_name`.

---

**Title:** n8n: emit manager_api_base_paths + query_param_style in .distribution.yaml (3 pipeline stories are inert without them)

## Impact

Three shipped pipeline stories (MCP_Market_Distribution Epic 13: **13.3**, **13.4**, **13.6**) are **implemented, tested and completely inert for EAD Factory**, because they are gated on two `.distribution.yaml` fields the generator doesn't emit. The node still builds and publishes — it just silently keeps the old, wrong behavior. Nothing fails; that's what makes this easy to miss.

Verified 2026-07-15 by building the real spec from `pending-to-publish/ead-factory`:

```
queryParamStyle:     (absent)   → 13.6 inert
operationBasePrefix: (absent)   → 13.3 inert
resources:  Evidence, Notification, Signature          → not "… Manager"      → 13.4 inert
labels:     "Search Evidence Case File"                → not "EM Search Case File"
```

What each one costs today:

| Field | Gates | Effect when absent |
|---|---|---|
| `manager_api_base_paths` | 13.3 per-manager base path, 13.4 manager-aware naming | one credential cannot serve every manager (users configure one per manager); resources read `Evidence`/`Signature`/`Notification` instead of `Evidence Manager`/`Signature Manager`/`Notice Manager`, and operations read `Search Evidence Case File` instead of `EM Search Case File` — ambiguous when the node is used as an AI tool, where there is no Resource context |
| `query_param_style: flat` | 13.6 query serialization | the node emits `?filter[size]=2`, which EAD Factory's API **ignores** → searches return unfiltered results. Measured against INT: `?size=2` → 2 records, `?filter[size]=2` → **50** records |

## Root cause

`managerApiBasePaths` **already exists** in `products/ead-factory/product.config.ts` with the right values — it just never reaches the emitted YAML:

```ts
managerApiBasePaths: {
  evidence: "/digital-trust",
  signature: "/signature-manager",
  notification: "/notifications",
  chat: "/chat-bot-manager",
},
```

`packages/generator/templates/distribution.yaml.hbs` has no line for it, and `emit-distribution.ts` never passes it. `queryParamStyle` doesn't exist in `ProductConfig` at all yet.

## Fix

Both can ride the **template-pass-through** pattern already used for `n8nConnectorDescription` (`emit-distribution.ts`: *"same template-pass-through pattern, not part of the vendored schema"*), so **no change to `vendor/distribution-config.schema.ts` is needed** — `buildDistributionConfig`'s `raw` object stays untouched.

1. `packages/generator/src/types.ts` — add to `ProductConfig`:
   ```ts
   /** GET query-parameter serialization the product's API expects. Omit for 'bracket' (default). */
   queryParamStyle?: "bracket" | "flat";
   ```
2. `packages/generator/templates/distribution.yaml.hbs` — after the `n8n_connector_description` block:
   ```hbs
   {{#if managerApiBasePathsYaml}}
   # Per-manager gateway base paths — one credential serves every manager.
   manager_api_base_paths:
   {{{managerApiBasePathsYaml}}}
   {{/if}}{{#if queryParamStyle}}query_param_style: {{queryParamStyle}}
   {{/if}}
   ```
3. `packages/generator/src/emit-distribution.ts` — in the `tpl({...})` call:
   ```ts
   managerApiBasePathsYaml: product.managerApiBasePaths
     ? Object.entries(product.managerApiBasePaths)
         .map(([k, v]) => `  ${k}: "${v}"`)
         .join("\n")
     : undefined,
   queryParamStyle: product.queryParamStyle,
   ```
4. `products/ead-factory/product.config.ts` — add next to `managerApiBasePaths`:
   ```ts
   // EAD Factory's API only honours flat query params; bracketed ones are ignored
   // (measured: ?size=2 → 2 records, ?filter[size]=2 → 50).
   queryParamStyle: "flat",
   ```

gocertius / ead-enterprise-suite are single-API products: they set neither field, and the pipeline's behavior for them is unchanged (both default to absent).

Expected result in `EAD-Factory-MCP/.distribution.yaml`:

```yaml
manager_api_base_paths:
  evidence: "/digital-trust"
  signature: "/signature-manager"
  notification: "/notifications"
  chat: "/chat-bot-manager"
query_param_style: flat
```

## Notes

- The `chat` entry is fine to emit even though Chat isn't curated yet (OQ-F) — the pipeline only maps prefixes for managers that actually have operations, so an unused key is inert.
- The **"Notice Manager"** wording is pipeline-side (`RESOURCE_DISPLAY_MULTI`) and needs nothing here. The `notification` slug, paths and env vars stay as they are.
- Please don't hand-edit `EAD-Factory-MCP/.distribution.yaml` as a shortcut — the header says *"Auto-generated by @suite/generator. Do not edit"*, and the next regen would wipe it. Same trap as issue #48.

## Contract reference

`docs/n8n-adapter-contract.md` in MCP_Market_Distribution → "Generator obligations" #3.
