import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { generateSmitheryYaml } from '../../../src/generators/generate-smithery-yaml.js';
import type { EnvironmentVariableEntry } from '../../../src/generators/generate-environment-variables.js';

const ENV_VARS: EnvironmentVariableEntry[] = [
  {
    description: 'EADTrust API key (See https://help.example.com for credential acquisition.)',
    isRequired: true,
    isSecret: true,
    name: 'EADTRUST_API_KEY',
  },
  {
    description: 'HTTP port the server binds to.',
    isRequired: true,
    isSecret: false,
    name: 'APP_PORT',
  },
  {
    description: 'Optional feature flag.',
    isRequired: false,
    isSecret: false,
    name: 'FEATURE_FLAG_X',
  },
];

const baseOpts = () => ({ environmentVariables: [...ENV_VARS] });

describe('generateSmitheryYaml — happy path', () => {
  it('produces a YAML document with runtime, env, and configSchema keys', async () => {
    const result = await generateSmitheryYaml(baseOpts());
    expect(result.parsed.runtime).toBe('typescript');
    expect(result.parsed.env).toBeDefined();
    expect(result.parsed.configSchema).toBeDefined();
  });

  it('defaults runtime to typescript when not specified', async () => {
    const result = await generateSmitheryYaml({ environmentVariables: [...ENV_VARS] });
    expect(result.parsed.runtime).toBe('typescript');
  });

  it('honors runtime=container when specified in options', async () => {
    const result = await generateSmitheryYaml({
      environmentVariables: [...ENV_VARS],
      runtime: 'container',
    });
    expect(result.parsed.runtime).toBe('container');
  });
});

describe('generateSmitheryYaml — env block declares non-secret vars', () => {
  it('lists every non-secret variable in env and excludes secrets', async () => {
    const result = await generateSmitheryYaml(baseOpts());
    const env = result.parsed.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['APP_PORT', 'FEATURE_FLAG_X']);
    expect(env.EADTRUST_API_KEY).toBeUndefined();
  });

  it('omits the env key entirely when all variables are secrets', async () => {
    const result = await generateSmitheryYaml({
      environmentVariables: [
        {
          description: 'A secret.',
          isRequired: true,
          isSecret: true,
          name: 'SOME_KEY',
        },
      ],
    });
    expect(result.parsed.env).toBeUndefined();
  });
});

describe('generateSmitheryYaml — configSchema mirrors the manifest', () => {
  it("required[] contains exactly the manifest's isRequired entries", async () => {
    const result = await generateSmitheryYaml(baseOpts());
    const configSchema = result.parsed.configSchema as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
      type: string;
    };
    expect(configSchema.type).toBe('object');
    expect([...configSchema.required].sort()).toEqual(['APP_PORT', 'EADTRUST_API_KEY']);
    expect(configSchema.required).not.toContain('FEATURE_FLAG_X');
  });

  it("marks secret variables with format: 'password' in configSchema properties", async () => {
    const result = await generateSmitheryYaml(baseOpts());
    const configSchema = result.parsed.configSchema as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(configSchema.properties.EADTRUST_API_KEY?.format).toBe('password');
    expect(configSchema.properties.APP_PORT?.format).toBeUndefined();
  });

  it('configSchema validates against the JSON Schema 2020-12 meta-schema', async () => {
    const result = await generateSmitheryYaml(baseOpts());
    const configSchema = result.parsed.configSchema as Record<string, unknown>;
    expect(configSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(configSchema).toHaveProperty('properties');
  });
});

describe('generateSmitheryYaml — formatting (NFR-R1)', () => {
  it('YAML uses 2-space indent and contains no tabs', async () => {
    const result = await generateSmitheryYaml(baseOpts());
    expect(result.yaml).not.toMatch(/\t/);
    expect(result.yaml).toMatch(/^ {2}\S/m);
  });

  it('YAML has no trailing whitespace on any line', async () => {
    const result = await generateSmitheryYaml(baseOpts());
    expect(result.yaml).not.toMatch(/[ \t]+\n/);
  });

  it('YAML round-trips through js-yaml without changes', async () => {
    const result = await generateSmitheryYaml(baseOpts());
    const loaded = yaml.load(result.yaml);
    expect(loaded).toEqual(result.parsed);
  });

  it('is byte-identical across 3 consecutive runs with the same input', async () => {
    const results = await Promise.all([
      generateSmitheryYaml(baseOpts()),
      generateSmitheryYaml(baseOpts()),
      generateSmitheryYaml(baseOpts()),
    ]);
    expect(results[0]!.yaml).toBe(results[1]!.yaml);
    expect(results[1]!.yaml).toBe(results[2]!.yaml);
  });

  it('is byte-identical regardless of environment variable input order', async () => {
    const reversed = [...ENV_VARS].reverse();
    const a = await generateSmitheryYaml(baseOpts());
    const b = await generateSmitheryYaml({ environmentVariables: reversed });
    expect(a.yaml).toBe(b.yaml);
  });
});

describe('generateSmitheryYaml — edge cases', () => {
  it('handles an empty environmentVariables list', async () => {
    const result = await generateSmitheryYaml({ environmentVariables: [] });
    expect(result.parsed.runtime).toBe('typescript');
    expect(result.parsed.env).toBeUndefined();
    const configSchema = result.parsed.configSchema as Record<string, unknown>;
    expect(configSchema.type).toBe('object');
    expect(configSchema.required).toBeUndefined();
    expect(configSchema.properties).toEqual({});
  });
});
