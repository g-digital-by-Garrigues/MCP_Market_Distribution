import { promises as fs } from 'node:fs';
import path from 'node:path';

// Resolve the runnable entry script of an MCP at `mcpFolder` by reading
// its `package.json#bin`. The bin entry is the source of truth: it's
// what `npx -y <pkg>` uses, what container ENTRYPOINTs invoke, and
// what `require.resolve(<pkg>/<bin>)` returns in n8n / mcpb consumers.
//
// Returns a path RELATIVE to `mcpFolder` (e.g. `dist/cli.js`). Falls
// back to `dist/server.js` when `package.json#bin` is absent — this
// preserves the historic default the gates used before EAD-Factory-MCP
// PR #9 split bootstrap into `dist/cli.js` and exported `createServer`
// from `dist/server.js`. New MCPs onboarding the pipeline are expected
// to declare a bin entry; the fallback exists to keep legacy fixtures
// and any pre-bin MCPs working until they migrate.

export interface ResolveMcpEntryOptions {
  /** Fallback when package.json#bin is absent. Defaults to `dist/server.js`. */
  fallback?: string;
}

export async function resolveMcpEntryRelPath(
  mcpFolder: string,
  opts: ResolveMcpEntryOptions = {},
): Promise<string> {
  const fallback = opts.fallback ?? 'dist/server.js';
  try {
    const pkgRaw = await fs.readFile(path.join(mcpFolder, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { bin?: string | Record<string, string> };
    if (typeof pkg.bin === 'string') return pkg.bin;
    if (pkg.bin && typeof pkg.bin === 'object') {
      const first = Object.values(pkg.bin)[0];
      if (typeof first === 'string') return first;
    }
  } catch {
    // package.json missing or malformed — fall through to default.
  }
  return fallback;
}
