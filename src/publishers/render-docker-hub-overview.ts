import { promises as fs } from 'node:fs';
import path from 'node:path';

import Handlebars from 'handlebars';
import yaml from 'js-yaml';

/**
 * Docker Hub's `full_description` cap. Sending more returns HTTP 400 with no
 * usable body, which is exactly how this went unnoticed: the publisher posted
 * the whole README, Docker Hub rejected it, and the failure was a log warning
 * on an otherwise-green publish. Measured on gocertius: the README fitted at
 * v1.5.0 (24,488 bytes) and stopped fitting at v1.5.1 (25,133), so the live
 * overview froze two releases back and kept advertising `MCP_AUTH_PASSWORD`
 * long after that variable was retired.
 *
 * The README is the wrong source anyway — it is written for a repository
 * reader, keeps growing, and would breach this cap again on the next release.
 * We render a purpose-built overview instead and check it against the cap
 * BEFORE the request, so an over-long overview is our bug, reported as ours,
 * rather than an opaque 400 from a third party.
 */
export const DOCKER_HUB_FULL_DESCRIPTION_MAX = 25_000;

export interface EnvVarEntry {
  name: string;
  description: string;
  isSecret: boolean;
  isRequired: boolean;
}

/**
 * Reads the structured `.env.example` the generator emits, where each variable
 * is preceded by a block of `# key: value` annotations:
 *
 *   # Free prose, ignored.
 *   # description: What the variable is for.
 *   # isSecret: true
 *   # isRequired: true
 *   MCP_AUTH_USER_KEY=
 *
 * The annotation keys are read by name. Taking "the last comment line" instead
 * — as `file-marketplace-issue.ts` still does — yields `isRequired: true` as
 * the description of every variable.
 */
export function parseEnvExample(raw: string): EnvVarEntry[] {
  const entries: EnvVarEntry[] = [];
  let block: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      block.push(trimmed.replace(/^#\s*/, ''));
      continue;
    }
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (!m) {
      // A blank line separates prose from the block it introduces, so it must
      // NOT clear the annotations — the generator writes them contiguously,
      // but a stray blank must not silently drop a description.
      if (trimmed.length > 0) block = [];
      continue;
    }
    const annotation = (key: string): string | undefined => {
      const hit = block.find((l) => l.toLowerCase().startsWith(`${key.toLowerCase()}:`));
      return hit?.slice(hit.indexOf(':') + 1).trim();
    };
    const described = annotation('description');
    // Fall back to the last line of free prose, never to an annotation line.
    const prose = [...block].reverse().find((l) => !/^[a-z]+:/i.test(l));
    entries.push({
      name: m[1]!,
      description: described ?? prose ?? '',
      isSecret: annotation('isSecret') === 'true',
      isRequired: annotation('isRequired') === 'true',
    });
    block = [];
  }
  return entries;
}

export interface DockerHubOverviewInput {
  /** Pipeline-internal MCP id (kebab-case) — the key clients use in mcpServers. */
  mcpName: string;
  /** Absolute path to the MCP source tree (pending-to-publish/<mcp_name>). */
  packageDir: string;
  /** Repo root, for locating templates/. */
  repoRoot: string;
  version: string;
  dockerImageName: string;
  npmPackageName: string;
  repoUrl: string;
  license: string;
  /** Tag the release notes live under, e.g. 'v2.0.0'. */
  releaseTag: string;
}

async function readJsonField(file: string, field: string): Promise<string> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/**
 * The SOURCE MCP repo, from `mcp-pipeline.yaml#mcps.<name>.repo_url`.
 *
 * The overview's documentation links must land on the product's own repo. The
 * other publishers still hardcode the pipeline repo here (see the TODO in
 * publish-docker-mcp-catalog.ts), which sends a reader to a repository that
 * does not contain the server they just pulled.
 */
export async function readSourceRepoUrl(repoRoot: string, mcpName: string): Promise<string> {
  const raw = await fs.readFile(path.join(repoRoot, 'mcp-pipeline.yaml'), 'utf8');
  const parsed = yaml.load(raw) as { mcps?: Record<string, { repo_url?: unknown }> } | undefined;
  const url = parsed?.mcps?.[mcpName]?.repo_url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error(`mcp-pipeline.yaml#mcps.${mcpName}.repo_url is missing or not a string`);
  }
  return url.trim().replace(/\/+$/, '');
}

export interface DockerHubDescriptions {
  /** `full_description` — the repository overview page. */
  full: string;
  /** `description` — the one-line summary under the repository name. */
  short: string;
}

export async function renderDockerHubOverview(
  input: DockerHubOverviewInput,
): Promise<DockerHubDescriptions> {
  const tpl = await fs.readFile(
    path.join(input.repoRoot, 'templates', 'store-descriptions', 'docker-hub-overview.hbs'),
    'utf8',
  );
  const description =
    (await readJsonField(path.join(input.packageDir, 'server.json'), 'description')) ||
    (await readJsonField(path.join(input.packageDir, 'package.json'), 'description'));

  let envVars: EnvVarEntry[] = [];
  try {
    envVars = parseEnvExample(await fs.readFile(path.join(input.packageDir, '.env.example'), 'utf8'));
  } catch {
    // No .env.example: the overview still renders, just without the table.
  }

  const full = Handlebars.compile(tpl, { noEscape: true })({
    mcp_name: input.mcpName,
    description,
    version: input.version,
    docker_image_name: input.dockerImageName,
    npm_package_name: input.npmPackageName,
    repo_url: input.repoUrl,
    license: input.license,
    release_tag: input.releaseTag,
    required_env: envVars.filter((e) => e.isRequired),
    optional_env: envVars.filter((e) => !e.isRequired),
  });

  return { full: full.trimEnd() + '\n', short: description };
}
