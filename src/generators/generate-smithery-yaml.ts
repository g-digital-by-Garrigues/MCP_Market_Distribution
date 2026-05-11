import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Handlebars from 'handlebars';
import { Ajv2020 } from 'ajv/dist/2020.js';
import yaml from 'js-yaml';
import type { EnvironmentVariableEntry } from './generate-environment-variables.js';
import { sortObjectKeysRecursive } from '../utils/stable-stringify.js';

const requireCjs = createRequire(import.meta.url);
const addFormats = requireCjs('ajv-formats') as (ajv: InstanceType<typeof Ajv2020>) => void;

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'templates',
  'smithery-yaml',
);

export const SMITHERY_RUNTIMES = ['typescript', 'container'] as const;
export type SmitheryRuntime = (typeof SMITHERY_RUNTIMES)[number];

export interface GenerateSmitheryYamlOptions {
  environmentVariables: readonly EnvironmentVariableEntry[];
  runtime?: SmitheryRuntime;
}

export interface GeneratedSmitheryYaml {
  yaml: string;
  parsed: Record<string, unknown>;
}

interface ConfigSchema {
  $schema: string;
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  type: 'object';
}

interface SmitheryRoot {
  configSchema: ConfigSchema;
  env?: Record<string, string>;
  runtime: SmitheryRuntime;
}

function buildConfigSchema(envVars: readonly EnvironmentVariableEntry[]): ConfigSchema {
  const sorted = [...envVars].sort((a, b) => a.name.localeCompare(b.name));
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const entry of sorted) {
    const property: Record<string, unknown> = {
      description: entry.description,
      type: 'string',
    };
    if (entry.isSecret) property.format = 'password';
    properties[entry.name] = property;
    if (entry.isRequired) required.push(entry.name);
  }
  const schema: ConfigSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties,
    type: 'object',
  };
  if (required.length > 0) {
    required.sort();
    schema.required = required;
  }
  return schema;
}

function buildEnvBlock(
  envVars: readonly EnvironmentVariableEntry[],
): Record<string, string> | undefined {
  const sorted = [...envVars]
    .filter((e) => !e.isSecret)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length === 0) return undefined;
  const block: Record<string, string> = {};
  for (const entry of sorted) {
    block[entry.name] = '';
  }
  return block;
}

let cachedTemplate: HandlebarsTemplateDelegate<unknown> | null = null;
let cachedMetaValidator: InstanceType<typeof Ajv2020> | null = null;
let helpersRegistered = false;

function registerHelpers(): void {
  if (helpersRegistered) return;
  Handlebars.registerHelper('yamlBody', (value: unknown) => {
    const sorted = sortObjectKeysRecursive(value);
    const dumped = yaml
      .dump(sorted, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
        quotingType: '"',
        forceQuotes: false,
      })
      .replace(/[ \t]+$/gm, '');
    return new Handlebars.SafeString(dumped);
  });
  helpersRegistered = true;
}

async function loadTemplate(): Promise<HandlebarsTemplateDelegate<unknown>> {
  if (cachedTemplate) return cachedTemplate;
  registerHelpers();
  const templatePath = path.join(TEMPLATES_DIR, 'v1.hbs');
  const content = await fs.readFile(templatePath, 'utf8');
  cachedTemplate = Handlebars.compile(content, { noEscape: true });
  return cachedTemplate;
}

function getMetaValidator(): InstanceType<typeof Ajv2020> {
  if (cachedMetaValidator) return cachedMetaValidator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedMetaValidator = ajv;
  return ajv;
}

export async function generateSmitheryYaml(
  opts: GenerateSmitheryYamlOptions,
): Promise<GeneratedSmitheryYaml> {
  const { environmentVariables, runtime = 'typescript' } = opts;

  const configSchema = buildConfigSchema(environmentVariables);
  const envBlock = buildEnvBlock(environmentVariables);

  const ajv = getMetaValidator();
  if (!ajv.validateSchema(configSchema)) {
    throw new Error(
      `Generated configSchema failed JSON Schema 2020-12 meta-schema validation: ${ajv.errorsText(ajv.errors ?? [])}`,
    );
  }

  const root: SmitheryRoot = {
    configSchema,
    runtime,
  };
  if (envBlock) root.env = envBlock;

  const template = await loadTemplate();
  const yamlString = template({ root });

  const parsed = yaml.load(yamlString);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Generated YAML did not parse to an object.');
  }

  if (/\t/.test(yamlString)) {
    throw new Error('Generated YAML contains tab characters (NFR-R1 violation).');
  }
  if (/[ ]+\n/.test(yamlString)) {
    throw new Error('Generated YAML contains trailing whitespace on a line.');
  }

  return { yaml: yamlString, parsed: parsed as Record<string, unknown> };
}
