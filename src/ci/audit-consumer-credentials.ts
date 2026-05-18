import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// NFR-S3 guard: the pipeline never reads consumer credentials. The audit
// scans every workflow file and composite-action source for `secrets.<NAME>`
// references and flags any whose name matches the consumer-credential
// heuristic (Okta-prefixed, or the same `*_SECRET/_TOKEN/_KEY/_PASSWORD`
// suffix patterns the .env.example parser uses to set isSecret=true).
// Operational secrets the pipeline DOES need (Docker Hub, bot PAT, npm,
// GitHub Actions' built-ins) are listed in OPERATIONAL_ALLOWLIST.

export const OPERATIONAL_ALLOWLIST: readonly string[] = [
  'GITHUB_TOKEN',
  'DOCKERHUB_USERNAME',
  'DOCKERHUB_TOKEN',
  'BOT_PAT',
  'NPM_TOKEN',
  // ANTHROPIC_API_KEY — Story 5.6b: gates the n8n adapter's optional
  // LLM-refine pass (refine-with-llm.ts). Operational, not a consumer
  // credential. Refine short-circuits when this is absent so CI without
  // the key still publishes the adapter (with naive title-case copy).
  'ANTHROPIC_API_KEY',
];

const SECRET_REFERENCE_RE = /\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}/g;
const FORBIDDEN_PREFIXES: readonly RegExp[] = [
  /^OKTA_/i,
];
const FORBIDDEN_SUFFIXES: readonly RegExp[] = [
  /_SECRET$/i,
  /_TOKEN$/i,
  /_KEY$/i,
  /_PASSWORD$/i,
];

export interface AuditFinding {
  file: string;
  secretName: string;
  line: number;
  reason: string;
}

export interface AuditResult {
  scannedFiles: string[];
  findings: AuditFinding[];
}

export interface AuditOptions {
  files: ReadonlyArray<{ path: string; content: string }>;
  extraAllowlist?: readonly string[];
}

function isAllowed(name: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(name);
}

function classifyForbidden(name: string): string | null {
  for (const re of FORBIDDEN_PREFIXES) {
    if (re.test(name)) return `matches forbidden prefix ${re.source}`;
  }
  for (const re of FORBIDDEN_SUFFIXES) {
    if (re.test(name)) return `matches forbidden suffix ${re.source}`;
  }
  return null;
}

export function auditConsumerCredentials(opts: AuditOptions): AuditResult {
  const allowlist = new Set([...OPERATIONAL_ALLOWLIST, ...(opts.extraAllowlist ?? [])]);
  const findings: AuditFinding[] = [];
  const scannedFiles: string[] = [];

  for (const file of opts.files) {
    scannedFiles.push(file.path);
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      let match: RegExpExecArray | null;
      const re = new RegExp(SECRET_REFERENCE_RE.source, 'g');
      while ((match = re.exec(line)) !== null) {
        const name = match[1]!;
        if (isAllowed(name, Array.from(allowlist))) continue;
        const reason = classifyForbidden(name);
        if (reason) {
          findings.push({
            file: file.path,
            secretName: name,
            line: idx + 1,
            reason: `secrets.${name} ${reason}; if this is a legitimate operational secret, add it to OPERATIONAL_ALLOWLIST in src/ci/audit-consumer-credentials.ts.`,
          });
        }
      }
    });
  }

  return { scannedFiles, findings };
}

async function readDirRecursive(dir: string, accept: (p: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await readDirRecursive(full, accept)));
    } else if (e.isFile() && accept(full)) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<number> {
  const repoRoot = process.cwd();
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const actionsDir = path.join(repoRoot, 'actions');
  const matches = (p: string) => p.endsWith('.yml') || p.endsWith('.yaml');
  const files: Array<{ path: string; content: string }> = [];
  for (const f of await readDirRecursive(workflowsDir, matches)) {
    files.push({ path: path.relative(repoRoot, f), content: await fs.readFile(f, 'utf8') });
  }
  for (const f of await readDirRecursive(actionsDir, matches)) {
    files.push({ path: path.relative(repoRoot, f), content: await fs.readFile(f, 'utf8') });
  }
  const result = auditConsumerCredentials({ files });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.findings.length > 0) {
    process.stderr.write(
      `\nNFR-S3 violation: ${result.findings.length} forbidden secret reference(s) found in CI sources.\n`,
    );
    return 1;
  }
  return 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
