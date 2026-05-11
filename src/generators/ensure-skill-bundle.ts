export const SKILL_BUNDLE_GLOB = '.claude/commands/**/*.md';

export interface EnsureSkillBundleOptions {
  packageJson: Record<string, unknown>;
  extraGlobs?: readonly string[];
}

export interface EnsureSkillBundleResult {
  packageJson: Record<string, unknown>;
  added: string[];
}

export function ensureSkillBundle(
  opts: EnsureSkillBundleOptions,
): EnsureSkillBundleResult {
  const { packageJson, extraGlobs = [] } = opts;
  const required = [SKILL_BUNDLE_GLOB, ...extraGlobs];

  const existing = Array.isArray(packageJson.files)
    ? (packageJson.files as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  const next: string[] = [...existing];
  const added: string[] = [];
  for (const glob of required) {
    if (!next.includes(glob)) {
      next.push(glob);
      added.push(glob);
    }
  }

  if (added.length === 0) {
    return { packageJson, added: [] };
  }

  return {
    packageJson: { ...packageJson, files: next },
    added,
  };
}
