# Smithery fallback runbook

What to do when the pipeline can't publish to Smithery automatically and you need to push the new version by hand.

This runbook is the fallback for [`publish-smithery`](../../src/publishers/publish-smithery.ts) — the MCPB-bundle publisher (Track C output) that runs in the pipeline. It addresses [Story 6.2](../../_bmad-output/planning-artifacts/epics.md).

## When to use this runbook

Run through manual publication when any of these holds:

- The pipeline's `publish-smithery` job consistently fails with the `cause` field pointing at a Smithery-side problem (HTTP 5xx, CLI auth errors, rate limits) rather than a problem with our MCPB bundle.
- The Smithery dashboard shows the previous version but the latest pipeline run reported `succeeded` ≥ 30 minutes ago — the CLI accepted the upload but Smithery's deploy pipeline silently dropped it (we've seen this with auth-gated MCPs during partial outages).
- Smithery has posted an official incident on status.smithery.ai that overlaps with your pipeline run timestamps.
- `SMITHERY_TOKEN` was rotated and the pipeline secret hasn't been updated yet (the publish will fail with `cli auth failed`; the fix is updating the org secret, but you may want the new version live sooner than that takes).

If the failure is in **our** code or generated MCPB bundle (gate failures on Track C, manifest validation errors, missing required files), this runbook doesn't apply — re-run `/prep-mcp`, fix the source, and re-tag.

## Prerequisites

- The MCPB bundle artifact from a successful pipeline run. Either:
  - Download the `mcpb-bundle-<mcp>-v<version>` artifact from the failed (or partial) GH Actions run, OR
  - Re-generate locally with `pnpm tsx src/adapters/mcpb-adapter/run-mcpb-adapter-build.ts <mcp-name> <version> pending-to-publish/<mcp> _mcpb-bundle false`
- A `SMITHERY_TOKEN` with publish permissions for the `g-digital` namespace. The pipeline holds this as an org secret; for manual publishes you'll need a fresh token from your Smithery account settings.
- `npx` available and outbound HTTPS to `smithery.ai` and `npm`.

## Manual publish (≤ 5 minutes)

```bash
# 1. From the bundle directory (containing manifest.json + server/ + the .mcpb file):
cd path/to/mcpb-bundle

# 2. Run the same CLI the pipeline uses, with the same pinned version.
SMITHERY_TOKEN="<your-token>" \
  npx -y @smithery/cli@^4.11.1 mcp publish \
  <mcp-name>-v<version>.mcpb \
  -n g-digital/<mcp-name>
```

That command is identical to what `publish-smithery.ts` runs in CI (look at lines around `smithery mcp publish` in the publisher source). If the CLI prints a success line with a Smithery URL, you're done.

## Verification

```bash
# Confirm the version is live on Smithery:
curl -s https://smithery.ai/api/servers/g-digital/<mcp-name> | python3 -m json.tool | grep version
```

The reported version should match what you just published. Also load `https://smithery.ai/server/g-digital/<mcp-name>` in a browser — the version chip on the page should match.

## When manual publish also fails

If `smithery mcp publish` itself errors:

| stderr signal | Likely cause | Fix |
|---|---|---|
| `401 Unauthorized` / `auth failed` | `SMITHERY_TOKEN` expired or wrong | Generate a fresh token at `smithery.ai/account/tokens`; if your CI failure was also auth, rotate the org secret too |
| `409 Conflict` / `version already exists` | Idempotent re-attempt — the version is already there | This isn't really a failure. Verify via the curl command above and move on |
| `503 / 5xx` / network timeouts | Smithery-side outage | Check status.smithery.ai; retry in 30 minutes. If extended, leave a comment on the release PR with the outage timestamp so the partial-publish report stays accurate |
| `invalid manifest` / `validation failed` | Bundle is broken (not a Smithery problem) | This is a bug in our generator or the source MCP. Don't paper over it — re-run `/prep-mcp` and inspect the manifest |
| `rate limit` | Too many publishes in a short window | Wait the cooldown the response specifies (usually a few minutes) and retry. If recurring, consider talking to Smithery support about quota |

## Post-incident: updating the release report

The pipeline-generated release report (`_bmad-output/release-reports/<mcp>-v<version>.md` on `MCP_Market_Distribution/main`) will still show `❌ failed` for Smithery if the pipeline's attempt failed. Update it:

1. Edit the file on `main`
2. Change the Smithery row from `❌ failed` to `✅ succeeded (manual fallback YYYY-MM-DD)`
3. Open a PR with the title `docs(release): mark <mcp>-v<version> Smithery as manual-publish` and merge
4. The CI run for the merge does not re-publish — release reports are append-only docs to `main`

## Historical context

The original Smithery integration (PRD Story 4.2, pre-MCPB) was an auto-deploy via git push to a configured branch, with a polling loop in the pipeline to confirm the deploy succeeded within 15 minutes. That model was replaced in PRs #99–#104 by the MCPB bundle + Smithery CLI flow, which is faster, idempotent, and self-attesting.

The 15-minute timeout from the original Story 6.6 ("Pin Smithery deploy verification policy") doesn't apply to the new model — the CLI returns synchronously on success or failure. Story 6.6 is being treated as obsolete for v1.1+ and remains tracked only as historical context.

## See also

- [`release-checklist.md`](./release-checklist.md) — the pre-release checklist that prevents most Smithery failures from happening in the first place
- [`publish-smithery.ts`](../../src/publishers/publish-smithery.ts) — the publisher this runbook covers
- [Story 6.2 acceptance criteria](../../_bmad-output/planning-artifacts/epics.md) — original requirement
