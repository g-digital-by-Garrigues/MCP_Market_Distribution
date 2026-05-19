import { z } from 'zod';

// Canonical output shape emitted by every publisher composite action via its
// `result_json` output. The release reporter (Story 3.5) collects an array
// of these and renders the per-target table; the slash-command dispatcher
// (Story 4.10) reads them to decide whether to dispatch a `/retry-publish`
// on a partial failure.
//
//   target            — the canonical target identifier (matches the action
//                       directory name minus the `publish-` prefix, e.g.
//                       'npm', 'docker-hub', 'mcp-publisher', 'smithery').
//   status            — succeeded: actually published / would have published.
//                       skipped:   publisher did not produce the artifact in
//                                  this run. TWO causes share this status:
//                                    (a) Intentional skip — target disabled
//                                        (e.g. smithery in v1.0). In this
//                                        case version_published is null.
//                                    (b) Idempotency hit — version was
//                                        already live on the target. In
//                                        this case version_published is set
//                                        to the live version.
//                                  The release-reporter (Story 3.5) renders
//                                  these two cases with different badges
//                                  (⏭ skipped vs ♻️ already-published) so
//                                  engineers don't mistake (b) for (a).
//                       failed:    publisher could not produce the artifact.
//   target_url        — public URL where the artifact lives. In dry-run, this
//                       is a deterministic placeholder of the form
//                       `https://example.invalid/dry-run/<target>/<mcp>/<version>`
//                       so the release report still renders consistently.
//   version_published — semver actually live on the target after the action
//                       returned. For succeeded: the version just published.
//                       For skipped: the version that was already there.
//                       For failed: null.
//   duration_ms       — wall-clock duration from action start to end.
//   attempts          — how many times the underlying probe/publish was tried
//                       (always ≥ 1; the idempotency check counts as 1).
//   dry_run           — whether the action ran in dry-run mode. The release
//                       report uses this to know whether to render the
//                       `**Status: DRY RUN**` marker (Story 2.9).
//   error             — populated only when status === 'failed'.
//   metadata          — opaque target-specific extras (e.g. image digest for
//                       Docker Hub, npm provenance attestation URL).

export const publisherOutputSchema = z
  .object({
    target: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'skipped']),
    target_url: z.string().url(),
    version_published: z.string().nullable(),
    duration_ms: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    dry_run: z.boolean(),
    error: z
      .object({
        message: z.string().min(1),
        cause: z.string().optional(),
        action: z.string().optional(),
      })
      .optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type PublisherOutput = z.infer<typeof publisherOutputSchema>;

// Build a deterministic placeholder URL for dry-run mode. Composite actions
// call this when they want a `target_url` that's distinguishable from real
// publication URLs but stable across runs (so byte-equality fixture tests
// of the release report stay deterministic).
export function dryRunPlaceholderUrl(target: string, mcpName: string, version: string): string {
  return `https://example.invalid/dry-run/${target}/${encodeURIComponent(mcpName)}/${encodeURIComponent(version)}`;
}
