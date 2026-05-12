// Canonical Track A + Track B target identifiers.
//
// Single source of truth: the slash-command parser (Story 4.9) validates
// `step` against this list; the partial-publish report (Story 4.7)
// renders `/retry-publish?step=<id>` using these identifiers; the
// composite actions under actions/publish-<id>/ must match these IDs.
//
// Adding a new target = append to this array, AND add an
// actions/publish-<id>/action.yml, AND add a job to publish.yml. The
// plug-ability test (Story 4.6) enforces this contract.

export const TRACK_A_TARGET_IDS = [
  'npm',
  'docker-hub',
  'mcp-publisher',
  'smithery',
  'docker-mcp-catalog',
  'cline',
  'mcpso',
] as const;

export const TRACK_B_TARGET_IDS = [
  'n8n',
  'make-rom',
] as const;

export const ALL_TARGET_IDS = [...TRACK_A_TARGET_IDS, ...TRACK_B_TARGET_IDS] as const;

export type TrackATargetId = (typeof TRACK_A_TARGET_IDS)[number];
export type TrackBTargetId = (typeof TRACK_B_TARGET_IDS)[number];
export type TargetId = TrackATargetId | TrackBTargetId;

export function isValidTargetId(id: string): id is TargetId {
  return (ALL_TARGET_IDS as readonly string[]).includes(id);
}
