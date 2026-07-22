/**
 * The file set the n8n reviewers' scan lints: `package.json` plus the shippable
 * node and credential sources.
 *
 * `@n8n/scan-community-package` exports this as `SOURCE_FILE_PATTERNS`, but only
 * from 0.29.x onwards — and the dependency floats on `latest` (currently 0.27.1),
 * so both consumers have to cope with the export being absent. Falling back to
 * this literal keeps them mirroring the reviewers at every scanner version;
 * falling back to `analyzePackage`'s own default (`**\/*.ts`) would not, because
 * it also sweeps in build tooling like `tsup.config.ts` that the reviewers never
 * see and that cannot get a node rejected.
 *
 * Prefer the scanner's own export whenever it is present — this is the fallback,
 * not the source of truth.
 */
export const SOURCE_FILE_PATTERNS_FALLBACK: readonly string[] = [
  'package.json',
  '{nodes,credentials}/**/*.{js,ts,json}',
];
