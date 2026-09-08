import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { EnvironmentVariableEntry } from './generate-environment-variables.js';
import { sortObjectKeysRecursive } from '../utils/stable-stringify.js';
import type { EmittedEnvDefaults } from '../utils/read-emitted-env-defaults.js';

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
  /**
   * Story 18.5 (AC1): defaults DISCOVERED in the emitted source, keyed by env var name
   * (see `src/utils/read-emitted-env-defaults.ts`). The caller that already knows the
   * source tree does the scrape; this function stays a pure function of its inputs.
   *
   * Optional on purpose: every existing call site stays valid, and an absent map
   * degrades to the AC2 marker, which is the safe direction.
   */
  emittedDefaults?: EmittedEnvDefaults;
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

// Story 18.5: a required variable must render as something a human can see and act on.
// A bare '' is indistinguishable from an optional blank and boots the server with an
// empty value instead of failing loudly.
//
//   secret                     → <PASTE_<NAME>_HERE>   (a value you paste)
//   non-secret, default found  → the discovered value  (AC1)
//   non-secret, no default     → <SET_<NAME>_HERE>     (a value you must look up, AC2)
//
// Secret is tested FIRST so no discovered value can ever reach a secret (NFR-S5), even
// if the discovery map happens to carry its name.
/**
 * Variables whose absence from discovery is a defect rather than a fact about the
 * product. Membership is a claim that a canonical per-product value EXISTS — so a
 * placeholder would be wrong, not merely unhelpful. Keep this list short and
 * evidence-backed; it is a stopgap for a distinction the contract cannot yet express.
 */
const DISCOVERY_IS_MANDATORY: ReadonlySet<string> = new Set(['MCP_API_BASE_URL']);

/** Thrown when an install block cannot be rendered without shipping something wrong. */
export class InstallBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallBlockError';
  }
}

function buildEnvBlock(
  envVars: readonly EnvironmentVariableEntry[],
  emittedDefaults: EmittedEnvDefaults,
): Record<string, string> {
  const required = [...envVars]
    .filter((v) => v.isRequired)
    .sort((a, b) => a.name.localeCompare(b.name));
  const env: Record<string, string> = {};
  for (const entry of required) {
    if (entry.isSecret) {
      env[entry.name] = `<PASTE_${entry.name}_HERE>`;
      continue;
    }
    const discovered = emittedDefaults[entry.name];
    if (!discovered && DISCOVERY_IS_MANDATORY.has(entry.name)) {
      // Narrow by necessity, not by preference. `isRequired` alone cannot separate
      // "there is a canonical value and discovery lost it" from "there is no canonical
      // value and a placeholder is correct" — EAD Factory declares MCP_SVC_TOKEN_URL
      // and MCP_SVC_CLIENT_ID required with no value that could ever be baked in.
      // MCP_API_BASE_URL is the one variable where a placeholder is KNOWN to be wrong
      // when the contract marks it required: the server refuses to start without it,
      // so a snippet carrying <SET_...> cannot boot. Discovery is a regex over the
      // generator-owned `src/tools/session_login.ts`, which is an implementation
      // detail we do not control; when it stops matching, this fails the build
      // instead of silently degrading eight install blocks per product.
      // Raised with generation on MCP_Market_Distribution#255 — the durable fix is
      // for the contract to declare which variables have a canonical value.
      throw new InstallBlockError(
        `${entry.name} is declared isRequired: true but no value could be discovered from the emitted source. ` +
          'This variable has a per-product canonical value and the server refuses to start without it, so an install ' +
          'block placeholder would ship a snippet that cannot boot. Discovery reads `src/tools/session_login.ts`; if the ' +
          'emitted source moved or restructured that default, update readEmittedEnvDefaults rather than shipping a placeholder.',
      );
    }
    env[entry.name] = discovered ? discovered : `<SET_${entry.name}_HERE>`;
  }
  return env;
}

const templateCache = new Map<ClientId, HandlebarsTemplateDelegate<unknown>>();

async function loadTemplate(clientId: ClientId): Promise<HandlebarsTemplateDelegate<unknown>> {
  const cached = templateCache.get(clientId);
  if (cached) return cached;
  const templatePath = path.join(TEMPLATES_DIR, `${clientId}.hbs`);
  const content = (await fs.readFile(templatePath, 'utf8')).replace(/\r\n/g, '\n');
  const compiled = Handlebars.compile(content, { noEscape: true });
  templateCache.set(clientId, compiled);
  return compiled;
}

export async function generateInstallBlock(
  opts: GenerateInstallBlockOptions,
): Promise<InstallBlockResult> {
  const { config, environmentVariables, clientId, emittedDefaults = {} } = opts;

  if (!SUPPORTED_CLIENT_IDS.includes(clientId)) {
    throw new Error(
      `clientId '${clientId}' is not supported. Allowed: ${SUPPORTED_CLIENT_IDS.join(', ')}.`,
    );
  }

  const shortName = deriveShortName(config.reverse_dns_name);
  const topLevelKey = topLevelKeyFor(clientId);
  const env = buildEnvBlock(environmentVariables, emittedDefaults);

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
