import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type SourceCheckStatus = 'present' | 'missing';

export interface SourceCheck {
  name: string;
  status: SourceCheckStatus;
  remediation?: string;
}

export interface SourceFolderReport {
  folder: string;
  expectedMcpName: string;
  checks: SourceCheck[];
  hasMissing: boolean;
}

export interface ValidateSourceFolderOptions {
  folder: string;
  expectedMcpName: string;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'] as const;
const README_FILES = ['README.md', 'README'] as const;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findFirstExisting(
  folder: string,
  candidates: readonly string[],
): Promise<string | null> {
  for (const name of candidates) {
    if (await fileExists(path.join(folder, name))) {
      return name;
    }
  }
  return null;
}

type PackageJsonRead =
  | { state: 'absent' }
  | { state: 'invalid'; message: string }
  | { state: 'present'; data: Record<string, unknown> };

async function readPackageJson(folder: string): Promise<PackageJsonRead> {
  const pkgPath = path.join(folder, 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent' };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { state: 'invalid', message: 'package.json root must be a JSON object' };
    }
    return { state: 'present', data: parsed as Record<string, unknown> };
  } catch (err) {
    return { state: 'invalid', message: (err as Error).message };
  }
}

export async function validateSourceFolder(
  opts: ValidateSourceFolderOptions,
): Promise<SourceFolderReport> {
  const { folder, expectedMcpName } = opts;
  const checks: SourceCheck[] = [];

  const pkg = await readPackageJson(folder);
  if (pkg.state === 'present') {
    checks.push({ name: 'package.json', status: 'present' });
  } else if (pkg.state === 'absent') {
    checks.push({
      name: 'package.json',
      status: 'missing',
      remediation: 'Create a package.json at the MCP root.',
    });
  } else {
    checks.push({
      name: 'package.json',
      status: 'missing',
      remediation: `package.json exists but is not valid JSON: ${pkg.message}`,
    });
  }

  if (pkg.state === 'present') {
    const value = pkg.data.mcpName;
    if (typeof value === 'string' && value === expectedMcpName) {
      checks.push({ name: 'package.json:mcpName', status: 'present' });
    } else if (value === undefined) {
      checks.push({
        name: 'package.json:mcpName',
        status: 'missing',
        remediation: `Add "mcpName": "${expectedMcpName}" to package.json (value derived from mcp-pipeline.yaml reverse_dns_name).`,
      });
    } else {
      checks.push({
        name: 'package.json:mcpName',
        status: 'missing',
        remediation: `Update mcpName in package.json from "${String(value)}" to "${expectedMcpName}" (value derived from mcp-pipeline.yaml reverse_dns_name).`,
      });
    }
  } else {
    checks.push({
      name: 'package.json:mcpName',
      status: 'missing',
      remediation: `Once package.json is valid, add "mcpName": "${expectedMcpName}" (value derived from mcp-pipeline.yaml reverse_dns_name).`,
    });
  }

  const licenseFile = await findFirstExisting(folder, LICENSE_FILES);
  if (licenseFile) {
    checks.push({ name: 'LICENSE', status: 'present' });
  } else {
    checks.push({
      name: 'LICENSE',
      status: 'missing',
      remediation: `Add a LICENSE file at the MCP root (one of: ${LICENSE_FILES.join(', ')}).`,
    });
  }

  const envExampleExists = await fileExists(path.join(folder, '.env.example'));
  if (envExampleExists) {
    checks.push({ name: '.env.example', status: 'present' });
  } else {
    checks.push({
      name: '.env.example',
      status: 'missing',
      remediation:
        'Add a .env.example file at the MCP root declaring required environment variables (one KEY=value per line, optional preceding # comment for description).',
    });
  }

  const readmeFile = await findFirstExisting(folder, README_FILES);
  if (readmeFile) {
    checks.push({ name: 'README', status: 'present' });
  } else {
    checks.push({
      name: 'README',
      status: 'missing',
      remediation: `Add a README file at the MCP root (one of: ${README_FILES.join(', ')}).`,
    });
  }

  return {
    folder,
    expectedMcpName,
    checks,
    hasMissing: checks.some((c) => c.status === 'missing'),
  };
}

async function main(): Promise<number> {
  const [folder, expectedMcpName] = process.argv.slice(2);
  if (!folder || !expectedMcpName) {
    process.stderr.write(
      'Usage: tsx src/validators/validate-source-folder.ts <folder> <expected-mcp-name>\n',
    );
    return 2;
  }
  const report = await validateSourceFolder({ folder, expectedMcpName });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.hasMissing ? 1 : 0;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  void main().then((code) => {
    process.exit(code);
  });
}
