import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { McpbBundleSpec } from './types.js';

// Story 5.9c: render the Handlebars templates under templates/mcpb-adapter/
// and stage the source MCP files into the bundle layout. Writes the
// pre-pack tree at <outputDir>/:
//
//   manifest.json
//   README.md
//   LICENSE                              ← copied from sourceMcpDir
//   server/index.js                      ← copied from sourceMcpDir/dist/server.js
//   server/package.json                  ← copied from sourceMcpDir/package.json
//   server/<rest of dist/>                ← copied recursively
//
// What this orchestrator does NOT do:
//   - `npm install --omit=dev` inside server/ to populate node_modules.
//     That's an impure shell-out and belongs in the CLI shim
//     (run-mcpb-adapter-build.ts) so this orchestrator stays pure and
//     unit-testable without child-process mocking.
//   - `mcpb pack` to ZIP the staged tree into a .mcpb file. Same
//     rationale — that's CLI shim territory.
//
// Caller receives `filesWritten` (relative to outputDir, sorted) so the
// release report can pipe an accurate list and tests can snapshot it.

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'templates',
  'mcpb-adapter',
);

let helpersRegistered = false;
function registerHelpers(): void {
  if (helpersRegistered) return;
  Handlebars.registerHelper('json', (value: unknown) => new Handlebars.SafeString(JSON.stringify(value)));
  // `userConfigRef configKey` → returns the literal substitution string
  // `${user_config.<configKey>}` (without surrounding quotes). Used in
  // the manifest.json template to populate mcp_config.env values. The
  // template wraps it with `{{json (userConfigRef ...)}}` so the json
  // helper adds the JSON-quoting on the way out. Direct interpolation
  // of `${user_config.{{configKey}}}` in the template trips the
  // Handlebars parser because the trailing `}}}` is greedy-parsed as a
  // triple-close mustache.
  Handlebars.registerHelper('userConfigRef', (configKey: string) => `\${user_config.${configKey}}`);
  helpersRegistered = true;
}

interface CompiledTemplates {
  manifest: HandlebarsTemplateDelegate<unknown>;
  readme: HandlebarsTemplateDelegate<unknown>;
}

let cachedTemplates: CompiledTemplates | null = null;

async function loadTemplate(name: string): Promise<HandlebarsTemplateDelegate<unknown>> {
  const raw = await fs.readFile(path.join(TEMPLATES_DIR, name), 'utf8');
  return Handlebars.compile(raw, { noEscape: true });
}

async function loadTemplates(): Promise<CompiledTemplates> {
  registerHelpers();
  if (cachedTemplates) return cachedTemplates;
  const [manifest, readme] = await Promise.all([
    loadTemplate('manifest.json.hbs'),
    loadTemplate('README.md.hbs'),
  ]);
  cachedTemplates = { manifest, readme };
  return cachedTemplates;
}

export interface GenerateMcpbBundleOptions {
  spec: McpbBundleSpec;
  /** Absolute path where the pre-pack bundle tree should be written. */
  outputDir: string;
  /**
   * Absolute path of the source MCP's checkout. The orchestrator reads
   * `package.json`, `LICENSE` (if present) and the entire `dist/`
   * directory from here and stages them into the bundle's `server/`
   * directory.
   */
  sourceMcpDir: string;
  /** Optional: clear the output dir first. Defaults to true. */
  clean?: boolean;
}

export interface GenerateMcpbBundleResult {
  /** Files written, relative to outputDir, sorted lexicographically. */
  filesWritten: string[];
}

async function copyRecursive(srcDir: string, dstDir: string): Promise<string[]> {
  // Returns the relative paths (relative to dstDir's PARENT, i.e.
  // bundle root) of every file written. Caller appends these to the
  // top-level filesWritten array.
  const written: string[] = [];
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      const inner = await copyRecursive(srcPath, dstPath);
      written.push(...inner);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
      written.push(dstPath);
    }
  }
  return written;
}

async function safeCopyFile(src: string, dst: string): Promise<boolean> {
  try {
    await fs.copyFile(src, dst);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function generateMcpbBundle(
  opts: GenerateMcpbBundleOptions,
): Promise<GenerateMcpbBundleResult> {
  const { spec, outputDir, sourceMcpDir, clean = true } = opts;
  if (clean) {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir, { recursive: true });

  const tpl = await loadTemplates();

  // 1) Templated bundle files: manifest.json + README.md.
  const filesWritten: string[] = [];
  const manifestPath = path.join(outputDir, 'manifest.json');
  await fs.writeFile(manifestPath, tpl.manifest(spec), 'utf8');
  filesWritten.push('manifest.json');

  const readmePath = path.join(outputDir, 'README.md');
  await fs.writeFile(readmePath, tpl.readme(spec), 'utf8');
  filesWritten.push('README.md');

  // 2) LICENSE: optional, copied verbatim from the source MCP if present.
  const licenseSrc = path.join(sourceMcpDir, 'LICENSE');
  const licenseDst = path.join(outputDir, 'LICENSE');
  if (await safeCopyFile(licenseSrc, licenseDst)) {
    filesWritten.push('LICENSE');
  }

  // 3) Staged source — server/package.json + server/dist tree.
  //    The bundle's `server/` directory matches the manifest spec's
  //    bundle layout. We do NOT yet run `npm install --omit=dev`
  //    here (see top-of-file comment) — that's the CLI shim's job
  //    immediately after this generator returns.
  const serverDir = path.join(outputDir, 'server');
  await fs.mkdir(serverDir, { recursive: true });

  const pkgSrc = path.join(sourceMcpDir, 'package.json');
  const pkgDst = path.join(serverDir, 'package.json');
  if (!(await safeCopyFile(pkgSrc, pkgDst))) {
    throw new Error(
      `Source MCP package.json missing at ${pkgSrc}. The generator requires a built MCP source tree.`,
    );
  }
  filesWritten.push(path.posix.join('server', 'package.json'));

  // The compiled source lives at sourceMcpDir/dist. We copy that tree
  // recursively into the bundle's server/ directory (preserving
  // sub-paths) so the manifest's `entry_point` (server/index.js)
  // resolves. The MCP's build step (handled upstream by the CI's
  // `npm run build`) is what populates dist/.
  const distSrc = path.join(sourceMcpDir, 'dist');
  try {
    await fs.stat(distSrc);
  } catch {
    throw new Error(
      `Source MCP dist/ missing at ${distSrc}. Run \`npm run build\` in the source MCP repo before invoking the MCPB generator.`,
    );
  }

  // Rename dist/server.js → server/index.js so the entry_point in the
  // manifest is the conventional `server/index.js`. Every other
  // compiled file under dist/ retains its sub-path under server/.
  const distEntries = await fs.readdir(distSrc, { withFileTypes: true });
  for (const entry of distEntries) {
    const srcPath = path.join(distSrc, entry.name);
    let dstName = entry.name;
    if (entry.isFile() && entry.name === 'server.js') {
      dstName = 'index.js';
    }
    const dstPath = path.join(serverDir, dstName);
    if (entry.isDirectory()) {
      const inner = await copyRecursive(srcPath, dstPath);
      for (const f of inner) {
        filesWritten.push(path.posix.join('server', path.relative(serverDir, f).split(path.sep).join('/')));
      }
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, dstPath);
      filesWritten.push(path.posix.join('server', dstName));
    }
  }

  // Deterministic order so tests can snapshot.
  filesWritten.sort((a, b) => a.localeCompare(b));
  return { filesWritten };
}
