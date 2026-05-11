export type BumpKind = 'none' | 'patch' | 'minor' | 'major';

export type BumpLabel = 'bump:patch' | 'bump:minor' | 'bump:major';

export type BumpSource = 'conventional-commits' | 'label-override' | 'no-change';

export interface DetermineNextVersionOptions {
  commits: readonly string[];
  prLabels?: readonly string[];
  currentVersion: string;
}

export interface NextVersionResult {
  bump: BumpKind;
  nextVersion: string;
  source: BumpSource;
  appliedLabel?: BumpLabel;
  detectedBumpFromCommits: BumpKind;
  explanation: string;
}

const BUMP_PRIORITY: Record<BumpKind, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

const LABEL_TO_BUMP: Record<BumpLabel, BumpKind> = {
  'bump:patch': 'patch',
  'bump:minor': 'minor',
  'bump:major': 'major',
};

const LABEL_PRECEDENCE: readonly BumpLabel[] = ['bump:major', 'bump:minor', 'bump:patch'];

const HEADER_RE = /^(?<type>[a-zA-Z]+)(?:\([^)]*\))?(?<breaking>!)?:/;
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE: /m;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

interface CommitAnalysis {
  type: string | null;
  breaking: boolean;
}

function analyzeCommit(message: string): CommitAnalysis {
  const lines = message.split(/\r?\n/);
  const subject = lines[0] ?? '';
  const body = lines.slice(1).join('\n');
  const match = HEADER_RE.exec(subject);
  const type = match?.groups?.type?.toLowerCase() ?? null;
  const breakingHeader = match?.groups?.breaking === '!';
  const breakingBody = BREAKING_FOOTER_RE.test(body);
  return { type, breaking: breakingHeader || breakingBody };
}

function bumpFromCommit(analysis: CommitAnalysis): BumpKind {
  if (analysis.breaking) return 'major';
  if (analysis.type === 'feat') return 'minor';
  if (analysis.type === 'fix') return 'patch';
  return 'none';
}

function highestBump(commits: readonly string[]): BumpKind {
  let highest: BumpKind = 'none';
  for (const message of commits) {
    const candidate = bumpFromCommit(analyzeCommit(message));
    if (BUMP_PRIORITY[candidate] > BUMP_PRIORITY[highest]) {
      highest = candidate;
    }
  }
  return highest;
}

function parseSemver(version: string): [number, number, number] {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(
      `currentVersion '${version}' is not a valid semver MAJOR.MINOR.PATCH (e.g., '1.0.0').`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function applyBump(version: string, bump: BumpKind): string {
  const [major, minor, patch] = parseSemver(version);
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'none':
      return version;
  }
}

function pickLabelOverride(prLabels: readonly string[]): BumpLabel | undefined {
  for (const candidate of LABEL_PRECEDENCE) {
    if (prLabels.includes(candidate)) return candidate;
  }
  return undefined;
}

export function determineNextVersion(opts: DetermineNextVersionOptions): NextVersionResult {
  const { commits, prLabels = [], currentVersion } = opts;
  const detectedBumpFromCommits = highestBump(commits);
  const labelOverride = pickLabelOverride(prLabels);

  if (labelOverride) {
    const bump = LABEL_TO_BUMP[labelOverride];
    return {
      bump,
      nextVersion: applyBump(currentVersion, bump),
      source: 'label-override',
      appliedLabel: labelOverride,
      detectedBumpFromCommits,
      explanation: `Bump '${bump}' applied from PR label '${labelOverride}' (overrides commit-derived bump '${detectedBumpFromCommits}').`,
    };
  }

  if (detectedBumpFromCommits === 'none') {
    return {
      bump: 'none',
      nextVersion: currentVersion,
      source: 'no-change',
      detectedBumpFromCommits,
      explanation:
        'No releasable Conventional Commits found (no feat:, fix:, or BREAKING CHANGE). Version unchanged.',
    };
  }

  return {
    bump: detectedBumpFromCommits,
    nextVersion: applyBump(currentVersion, detectedBumpFromCommits),
    source: 'conventional-commits',
    detectedBumpFromCommits,
    explanation: `Bump '${detectedBumpFromCommits}' derived from Conventional Commits analysis.`,
  };
}
