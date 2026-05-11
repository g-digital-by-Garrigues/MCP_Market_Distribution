import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { EnvironmentVariableEntry } from './generate-environment-variables.js';
import { sortObjectKeysRecursive } from '../utils/stable-stringify.js';

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
  'install-blocks',
);

export const SUPPORTED_CLIENT_IDS = [
  'claude-desktop',
  'claude-code-cli',
  'cursor',
  'windsurf',
  'cline',
  'vscode',
  'jetbrains',
  'zed',
] as const;

export type ClientId = (typeof SUPPORTED_CLIENT_IDS)[number];

export interface InstallBlockConfig {
  reverse_dns_name: string;
  npm_package_name: string;
  credential_help_url: string;
}

export interface GenerateInstallBlockOptions {
  config: InstallBlockConfig;
  environmentVariables: readonly EnvironmentVariableEntry[];
  clientId: ClientId;
}

export interface InstallBlockResult {
  markdown: string;
  parsed: Record<string, unknown>;
  topLevelKey: 'mcpServers' | 'servers';
  shortName: string;
}

function deriveShortName(reverseDnsName: string): string {
  const idx = reverseDnsName.lastIndexOf('/');
  if (idx < 0 || idx === reverseDnsName.length - 1) {
    throw new Error(
      `reverse_dns_name '${reverseDnsName}' must contain a '/<short-name>' suffix to derive the install-block server key.`,
    );
  }
  return reverseDnsName.slice(idx + 1);
}

function topLevelKeyFor(clientId: ClientId): 'mcpServers' | 'servers' {
  return clientId === 'vscode' ? 'servers' : 'mcpServers';
}

function buildEnvBlock(
  envVars: readonly EnvironmentVariableEntry[],
): Record<string, string> {
  const required = [...envVars]
    .filter((v) => v.isRequired)
    .sort((a, b) => a.name.localeCompare(b.name));
  const env: Record<string, string> = {};
  for (const entry of required) {
    env[entry.name] = entry.isSecret ? `<PASTE_${entry.name}_HERE>` : '';
  }
  return env;
}

const templateCache = new Map<ClientId, HandlebarsTemplateDelegate<unknown>>();

async function loadTemplate(clientId: ClientId): Promise<HandlebarsTemplateDelegate<unknown>> {
  const cached = templateCache.get(clientId);
  if (cached) return cached;
  const templatePath = path.join(TEMPLATES_DIR, `${clientId}.hbs`);
  const content = await fs.readFile(templatePath, 'utf8');
  const compiled = Handlebars.compile(content, { noEscape: true });
  templateCache.set(clientId, compiled);
  return compiled;
}

export async function generateInstallBlock(
  opts: GenerateInstallBlockOptions,
): Promise<InstallBlockResult> {
  const { config, environmentVariables, clientId } = opts;

  if (!SUPPORTED_CLIENT_IDS.includes(clientId)) {
    throw new Error(
      `clientId '${clientId}' is not supported. Allowed: ${SUPPORTED_CLIENT_IDS.join(', ')}.`,
    );
  }

  const shortName = deriveShortName(config.reverse_dns_name);
  const topLevelKey = topLevelKeyFor(clientId);
  const env = buildEnvBlock(environmentVariables);

  const serverEntry: Record<string, unknown> = {
    args: ['-y', config.npm_package_name],
    command: 'npx',
  };
  if (Object.keys(env).length > 0) {
    serverEntry.env = env;
  }

  const body = sortObjectKeysRecursive({
    [topLevelKey]: {
      [shortName]: serverEntry,
    },
  });
  const jsonBody = JSON.stringify(body, null, 2);

  const template = await loadTemplate(clientId);
  const markdown = template({
    jsonBody,
    credentialHelpUrl: config.credential_help_url,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonBody) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Generated install block JSON is invalid: ${(err as Error).message}`);
  }

  const serialized = JSON.stringify(parsed);
  for (const entry of environmentVariables) {
    if (!entry.isSecret) continue;
    const possibleLeakSources = [entry.description];
    for (const source of possibleLeakSources) {
      if (source && /=/.test(source)) {
        const valueAfterEq = source.split('=').slice(1).join('=').trim();
        if (valueAfterEq && serialized.includes(valueAfterEq)) {
          throw new Error(
            `Install block leaks a concrete secret value for '${entry.name}' (NFR-S5 violation).`,
          );
        }
      }
    }
  }

  return { markdown, parsed, topLevelKey, shortName };
}

export async function generateAllInstallBlocks(
  opts: Omit<GenerateInstallBlockOptions, 'clientId'>,
): Promise<Record<ClientId, InstallBlockResult>> {
  const entries = await Promise.all(
    SUPPORTED_CLIENT_IDS.map(
      async (clientId): Promise<[ClientId, InstallBlockResult]> => [
        clientId,
        await generateInstallBlock({ ...opts, clientId }),
      ],
    ),
  );
  return Object.fromEntries(entries) as Record<ClientId, InstallBlockResult>;
}
