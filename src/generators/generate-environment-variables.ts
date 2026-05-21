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
// Structured metadata inside a comment: `# description: …`, `# isSecret: true|false`,
// `# isRequired: true|false`. When ANY structured field is present in the comment
// block immediately preceding a KV line, the parser switches to "structured mode"
// for that var: only the structured fields are used, and free-text comments
// (typically section headers like `# Flow 1: Email / password`) are discarded.
// This keeps backward compatibility with the free-text format used by
// EAD-Factory-MCP while letting @suite/generator-style files declare metadata
// explicitly without leaking section headers into descriptions.
const STRUCTURED_FIELD_RE = /^(description|isSecret|isRequired)\s*:\s*(.*)$/i;

function isSecretKey(name: string, allowlist: readonly string[]): boolean {
  if (allowlist.includes(name)) return true;
  return SECRET_SUFFIX_PATTERNS.some((re) => re.test(name));
}

function parseBool(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

export function generateEnvironmentVariables(
  opts: GenerateEnvironmentVariablesOptions,
): EnvironmentVariablesManifest {
  const { envExampleContent, credentialHelpUrl, secretKeysAllowlist = [] } = opts;

  const lines = envExampleContent.split(/\r?\n/);
  const entries: EnvironmentVariableEntry[] = [];
  const seen = new Set<string>();

  let descriptionBuffer: string[] = [];
  let structuredDescription: string | null = null;
  let structuredIsSecret: boolean | null = null;
  let structuredIsRequired: boolean | null = null;
  let optionalMarker = false;

  const resetContext = (): void => {
    descriptionBuffer = [];
    structuredDescription = null;
    structuredIsSecret = null;
    structuredIsRequired = null;
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
      if (!text) continue;

      const structMatch = STRUCTURED_FIELD_RE.exec(text);
      if (structMatch) {
        const key = structMatch[1]!.toLowerCase();
        const value = structMatch[2]!.trim();
        if (key === 'description') {
          structuredDescription = value;
        } else if (key === 'issecret') {
          const b = parseBool(value);
          if (b !== null) structuredIsSecret = b;
        } else if (key === 'isrequired') {
          const b = parseBool(value);
          if (b !== null) structuredIsRequired = b;
        }
        continue;
      }

      descriptionBuffer.push(text);
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

      const hasStructured =
        structuredDescription !== null ||
        structuredIsSecret !== null ||
        structuredIsRequired !== null;

      let baseDescription: string;
      let isSecret: boolean;
      let isRequired: boolean;

      if (hasStructured) {
        baseDescription = structuredDescription ?? name;
        isSecret = structuredIsSecret ?? isSecretKey(name, secretKeysAllowlist);
        isRequired = structuredIsRequired ?? !optionalMarker;
      } else {
        baseDescription =
          descriptionBuffer.length > 0 ? descriptionBuffer.join(' ') : name;
        isSecret = isSecretKey(name, secretKeysAllowlist);
        isRequired = !optionalMarker;
      }

      const description = isSecret
        ? `${baseDescription} (See ${credentialHelpUrl} for credential acquisition.)`
        : baseDescription;

      entries.push({
        description,
        isRequired,
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
