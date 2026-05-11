export interface EnvironmentVariableEntry {
  description: string;
  isRequired: boolean;
  isSecret: boolean;
  name: string;
}

export interface EnvironmentVariablesManifest {
  environmentVariables: EnvironmentVariableEntry[];
}

export interface GenerateEnvironmentVariablesOptions {
  envExampleContent: string;
  credentialHelpUrl: string;
  secretKeysAllowlist?: readonly string[];
}

const SECRET_SUFFIX_PATTERNS: readonly RegExp[] = [
  /_SECRET$/,
  /_TOKEN$/,
  /_KEY$/,
  /_PASSWORD$/,
];

const OPTIONAL_MARKER_RE = /^#\s*OPTIONAL\b/;
const COMMENT_LINE_RE = /^#\s?(.*)$/;
const KV_LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function isSecretKey(name: string, allowlist: readonly string[]): boolean {
  if (allowlist.includes(name)) return true;
  return SECRET_SUFFIX_PATTERNS.some((re) => re.test(name));
}

export function generateEnvironmentVariables(
  opts: GenerateEnvironmentVariablesOptions,
): EnvironmentVariablesManifest {
  const { envExampleContent, credentialHelpUrl, secretKeysAllowlist = [] } = opts;

  const lines = envExampleContent.split(/\r?\n/);
  const entries: EnvironmentVariableEntry[] = [];
  const seen = new Set<string>();

  let descriptionBuffer: string[] = [];
  let optionalMarker = false;

  const resetContext = (): void => {
    descriptionBuffer = [];
    optionalMarker = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      resetContext();
      continue;
    }

    if (OPTIONAL_MARKER_RE.test(line)) {
      optionalMarker = true;
      continue;
    }

    const commentMatch = COMMENT_LINE_RE.exec(line);
    if (commentMatch) {
      const text = commentMatch[1]?.trim() ?? '';
      if (text) descriptionBuffer.push(text);
      continue;
    }

    const kvMatch = KV_LINE_RE.exec(line);
    if (kvMatch) {
      const name = kvMatch[1];
      if (!name || seen.has(name)) {
        resetContext();
        continue;
      }
      seen.add(name);

      const isSecret = isSecretKey(name, secretKeysAllowlist);
      const baseDescription =
        descriptionBuffer.length > 0 ? descriptionBuffer.join(' ') : name;
      const description = isSecret
        ? `${baseDescription} (See ${credentialHelpUrl} for credential acquisition.)`
        : baseDescription;

      entries.push({
        description,
        isRequired: !optionalMarker,
        isSecret,
        name,
      });
      resetContext();
      continue;
    }

    resetContext();
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { environmentVariables: entries };
}
