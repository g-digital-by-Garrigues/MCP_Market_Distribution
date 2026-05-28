import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { N8nNodeSpec } from './types.js';

// Story 5.1c: render the Handlebars templates under templates/n8n-adapter/
// against a `N8nNodeSpec` and write the resulting n8n community node
// source tree to disk. Output layout follows n8n's loader convention:
//   <outputDir>/
//   ├── package.json
//   ├── tsconfig.json
//   ├── README.md
//   ├── index.ts
//   ├── nodes/<ClassName>/<ClassName>.node.ts
//   └── credentials/<ClassName>Api.credentials.ts
//
// The orchestrator is intentionally pure: caller passes the spec + a
// destination path; we write the files atomically (mkdir-p, then write)
// and return the list of relative paths we wrote so callers can pipe it
// into a release report.

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'templates',
  'n8n-adapter',
);

// Register Handlebars helpers once. `json` is the workhorse — wraps a
// value in JSON.stringify so single quotes inside descriptions don't
// blow up TS. SafeString avoids Handlebars double-escaping the result.
let helpersRegistered = false;
function registerHelpers(): void {
  if (helpersRegistered) return;
  Handlebars.registerHelper('json', (value: unknown) => new Handlebars.SafeString(JSON.stringify(value)));
  // Story 12.2 (Epic 12): 'eq' helper for authStyle comparisons in node.ts.hbs
  Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  // 'safe' helper: returns a SafeString so the value is NOT HTML-escaped.
  // Used for pre-rendered string fragments like stubSuffix (', stub: true' or '').
  Handlebars.registerHelper('safe', (value: unknown) => new Handlebars.SafeString(String(value ?? '')));
  helpersRegistered = true;
}

interface CompiledTemplates {
  packageJson: HandlebarsTemplateDelegate<unknown>;
  tsconfig: HandlebarsTemplateDelegate<unknown>;
  tsupConfig: HandlebarsTemplateDelegate<unknown>;
  readme: HandlebarsTemplateDelegate<unknown>;
  index: HandlebarsTemplateDelegate<unknown>;
  node: HandlebarsTemplateDelegate<unknown>;
  credentials: HandlebarsTemplateDelegate<unknown>;
  // mcp-server-entry.ts.hbs removed in Story 12.2 (Epic 12):
  // REST-direct architecture no longer bundles the MCP subprocess.
}

let cachedTemplates: CompiledTemplates | null = null;

async function loadTemplate(name: string): Promise<HandlebarsTemplateDelegate<unknown>> {
  const raw = await fs.readFile(path.join(TEMPLATES_DIR, name), 'utf8');
  return Handlebars.compile(raw, { noEscape: true });
}

async function loadTemplates(): Promise<CompiledTemplates> {
  registerHelpers();
  if (cachedTemplates) return cachedTemplates;
  const [packageJson, tsconfig, tsupConfig, readme, index, node, credentials] = await Promise.all([
    loadTemplate('package.json.hbs'),
    loadTemplate('tsconfig.json.hbs'),
    loadTemplate('tsup.config.ts.hbs'),
    loadTemplate('README.md.hbs'),
    loadTemplate('index.ts.hbs'),
    loadTemplate('node.ts.hbs'),
    loadTemplate('credentials.ts.hbs'),
  ]);
  cachedTemplates = { packageJson, tsconfig, tsupConfig, readme, index, node, credentials };
  return cachedTemplates;
}

export interface GenerateN8nNodeOptions {
  spec: N8nNodeSpec;
  /** Absolute path where the n8n node source tree should be written. */
  outputDir: string;
  /**
   * Absolute path to the source MCP's logo PNG to bundle as the n8n
   * node icon. When set (and spec.iconBundled === true), the generator
   * copies this file to `nodes/<className>/icon.png` and the template
   * emits `icon: 'file:icon.png'` on the n8n description. n8n's
   * catalogue UI + workflow editor render this thumbnail next to the
   * displayName instead of the generic-box default.
   */
  sourceLogoAbsPath?: string;
  /** Optional: clear the output dir first. Defaults to true. */
  clean?: boolean;
}

export interface GenerateN8nNodeResult {
  /** Files written, relative to outputDir, sorted lexicographically. */
  filesWritten: string[];
}

export async function generateN8nNode(opts: GenerateN8nNodeOptions): Promise<GenerateN8nNodeResult> {
  const { spec, outputDir, clean = true } = opts;
  if (clean) {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir, { recursive: true });

  const tpl = await loadTemplates();

  const writes: Array<{ rel: string; content: string }> = [
    { rel: 'package.json', content: tpl.packageJson(spec) },
    { rel: 'tsconfig.json', content: tpl.tsconfig(spec) },
    { rel: 'tsup.config.ts', content: tpl.tsupConfig(spec) },
    { rel: 'README.md', content: tpl.readme(spec) },
    { rel: 'index.ts', content: tpl.index(spec) },
    {
      rel: path.posix.join('nodes', spec.className, `${spec.className}.node.ts`),
      content: tpl.node(spec),
    },
    {
      rel: path.posix.join('credentials', `${spec.credentialClassName}.credentials.ts`),
      content: tpl.credentials(spec),
    },
  ];

  // Sorted so the `filesWritten` output is deterministic regardless of
  // platform fs.readdir ordering — tests can snapshot it.
  writes.sort((a, b) => a.rel.localeCompare(b.rel));

  for (const { rel, content } of writes) {
    const absolute = path.join(outputDir, rel);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }

  const filesWritten = writes.map((w) => w.rel);

  // Icon: copy the source MCP's logo to nodes/<Class>/icon.png so
  // n8n's `description.icon = 'file:icon.png'` resolves at runtime.
  // We always normalise the destination filename to `icon.png`
  // regardless of how the source named its logo, so the manifest
  // reference is deterministic. Best-effort: when sourceLogoAbsPath
  // is unset OR the source file is missing, we silently skip — the
  // template falls back to no-icon and n8n shows the generic box
  // (still functional, just less branded).
  if (spec.iconBundled && opts.sourceLogoAbsPath) {
    const iconRel = path.posix.join('nodes', spec.className, 'icon.png');
    const iconAbs = path.join(outputDir, iconRel);
    try {
      await fs.mkdir(path.dirname(iconAbs), { recursive: true });
      await fs.copyFile(opts.sourceLogoAbsPath, iconAbs);
      filesWritten.push(iconRel);
      filesWritten.sort((a, b) => a.localeCompare(b));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  return { filesWritten };
}
