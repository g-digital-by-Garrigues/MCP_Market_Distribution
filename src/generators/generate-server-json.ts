import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { createRequire } from 'node:module';
import type { EnvironmentVariableEntry } from './generate-environment-variables.js';
import { safeStableStringify, sortObjectKeysRecursive } from '../utils/stable-stringify.js';

const requireCjs = createRequire(import.meta.url);
const addFormats = requireCjs('ajv-formats') as (ajv: InstanceType<typeof Ajv2020>) => void;

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
  'server-json',
);

export interface ServerJsonConfig {
  reverse_dns_name: string;
  npm_package_name: string;
  mcp_schema_version: string;
}

export interface ServerJsonPackageJsonFields {
  description?: string;
  repository?: string | { type?: string; url: string };
}

export interface GenerateServerJsonOptions {
  config: ServerJsonConfig;
  packageJson: ServerJsonPackageJsonFields;
  environmentVariables: readonly EnvironmentVariableEntry[];
  version: string;
}

export interface GeneratedServerJson {
  json: string;
  parsed: Record<string, unknown>;
}

interface TemplateData {
  schemaUrl: string;
  description: string;
  name: string;
  packages: Array<{
    environmentVariables: readonly EnvironmentVariableEntry[];
    identifier: string;
    registryType: 'npm';
    transport: { type: 'stdio' };
    version: string;
  }>;
  repository: { source: string; url: string };
  version: string;
  websiteUrl?: string;
}

function buildSchemaUrl(mcpSchemaVersion: string): string {
  return `https://static.modelcontextprotocol.io/schemas/${mcpSchemaVersion}/server.schema.json`;
}

function extractRepositoryUrl(pkg: ServerJsonPackageJsonFields): string {
  const repo = pkg.repository;
  if (!repo) {
    throw new Error(
      'package.json#repository is required to build server.json#repository.url (FR6).',
    );
  }
  const url = typeof repo === 'string' ? repo : repo.url;
  if (!url) {
    throw new Error('package.json#repository.url is required to build server.json (FR6).');
  }
  return url.replace(/^git\+/, '').replace(/\.git$/, '');
}

let cachedTemplate: HandlebarsTemplateDelegate<unknown> | null = null;
let cachedValidator: ValidateFunction | null = null;
let helperRegistered = false;

function registerJsonHelper(): void {
  if (helperRegistered) return;
  Handlebars.registerHelper('json', (value: unknown) =>
    new Handlebars.SafeString(JSON.stringify(sortObjectKeysRecursive(value))),
  );
  helperRegistered = true;
}

async function loadTemplate(): Promise<HandlebarsTemplateDelegate<unknown>> {
  if (cachedTemplate) return cachedTemplate;
  registerJsonHelper();
  const templatePath = path.join(TEMPLATES_DIR, 'v2025-12-11.hbs');
  const content = (await fs.readFile(templatePath, 'utf8')).replace(/\r\n/g, '\n');
  cachedTemplate = Handlebars.compile(content, { noEscape: true });
  return cachedTemplate;
}

async function loadValidator(): Promise<ValidateFunction> {
  if (cachedValidator) return cachedValidator;
  const schemaPath = path.join(TEMPLATES_DIR, 'server-schema-v2025-12-11.json');
  const schemaContent = await fs.readFile(schemaPath, 'utf8');
  const schema = JSON.parse(schemaContent) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

export async function generateServerJson(
  opts: GenerateServerJsonOptions,
): Promise<GeneratedServerJson> {
  const { config, packageJson, environmentVariables, version } = opts;

  if (!packageJson.description) {
    throw new Error('package.json#description is required to build server.json (FR6).');
  }

  const sortedEnvVars = [...environmentVariables].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const data: TemplateData = {
    schemaUrl: buildSchemaUrl(config.mcp_schema_version),
    description: packageJson.description,
    name: config.reverse_dns_name,
    packages: [
      {
        environmentVariables: sortedEnvVars,
        identifier: config.npm_package_name,
        registryType: 'npm',
        transport: { type: 'stdio' },
        version,
      },
    ],
    repository: { source: 'github', url: extractRepositoryUrl(packageJson) },
    version,
  };

  const template = await loadTemplate();
  const rendered = template(data);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch (err) {
    throw new Error(
      `Rendered server.json is not valid JSON (likely a template bug): ${(err as Error).message}`,
    );
  }

  const sorted = sortObjectKeysRecursive(parsed) as Record<string, unknown>;
  const json = safeStableStringify(sorted, 2);

  const validate = await loadValidator();
  if (!validate(sorted)) {
    const errors = validate.errors ?? [];
    const message = errors
      .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
      .join('; ');
    throw new Error(`Generated server.json failed schema validation: ${message}`);
  }

  return { json, parsed: sorted };
}
