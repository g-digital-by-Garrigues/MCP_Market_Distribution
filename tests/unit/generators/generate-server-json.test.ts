import { describe, expect, it } from 'vitest';
import { generateServerJson } from '../../../src/generators/generate-server-json.js';
import type { EnvironmentVariableEntry } from '../../../src/generators/generate-environment-variables.js';

const CONFIG = {
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
  npm_package_name: '@g-digital/mcp-ead-factory',
  mcp_schema_version: '2025-12-11',
};

const PACKAGE_JSON = {
  description: 'EAD Factory MCP server for evidence handling.',
  repository: {
    type: 'git',
    url: 'git+https://github.com/g-digital-by-Garrigues/ead-factory.git',
  },
};

const ENV_VARS: EnvironmentVariableEntry[] = [
  {
    description: 'EADTrust API key. (See https://help.example.com for credential acquisition.)',
    isRequired: true,
    isSecret: true,
    name: 'EADTRUST_API_KEY',
  },
  {
    description: 'HTTP port the server binds to.',
    isRequired: false,
    isSecret: false,
    name: 'APP_PORT',
  },
];

const baseOpts = () => ({
  config: { ...CONFIG },
  packageJson: { ...PACKAGE_JSON },
  environmentVariables: [...ENV_VARS],
  version: '1.0.0',
});

describe('generateServerJson — happy path', () => {
  it('produces a server.json with all required AC fields correctly mapped', async () => {
    const result = await generateServerJson(baseOpts());
    expect(result.parsed.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
    expect(result.parsed.name).toBe(CONFIG.reverse_dns_name);
    expect(result.parsed.description).toBe(PACKAGE_JSON.description);
    expect(result.parsed.version).toBe('1.0.0');
    const repository = result.parsed.repository as { url: string; source: string };
    expect(repository.url).toBe('https://github.com/g-digital-by-Garrigues/ead-factory');
    expect(repository.source).toBe('github');
    const packages = result.parsed.packages as Array<Record<string, unknown>>;
    expect(packages).toHaveLength(1);
    expect(packages[0]?.identifier).toBe(CONFIG.npm_package_name);
    expect(packages[0]?.version).toBe('1.0.0');
    expect(packages[0]?.registryType).toBe('npm');
  });

  it('embeds the environmentVariables manifest verbatim in packages[0]', async () => {
    const result = await generateServerJson(baseOpts());
    const packages = result.parsed.packages as Array<Record<string, unknown>>;
    expect(packages[0]?.environmentVariables).toEqual(
      [...ENV_VARS].sort((a, b) => a.name.localeCompare(b.name)),
    );
  });

  it('accepts a string-shaped package.json#repository', async () => {
    const result = await generateServerJson({
      ...baseOpts(),
      packageJson: {
        description: PACKAGE_JSON.description,
        repository: 'https://github.com/g-digital-by-Garrigues/ead-factory.git',
      },
    });
    const repository = result.parsed.repository as { url: string };
    expect(repository.url).toBe('https://github.com/g-digital-by-Garrigues/ead-factory');
  });
});

describe('generateServerJson — NFR-R1 determinism', () => {
  it('serializes with alphabetically ordered keys at every level', async () => {
    const result = await generateServerJson(baseOpts());
    const topLevelKeys = Object.keys(result.parsed);
    expect(topLevelKeys).toEqual([...topLevelKeys].sort());
    const pkg = (result.parsed.packages as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(pkg)).toEqual([...Object.keys(pkg)].sort());
    const envEntries = pkg.environmentVariables as Array<Record<string, unknown>>;
    for (const entry of envEntries) {
      expect(Object.keys(entry)).toEqual([...Object.keys(entry)].sort());
    }
  });

  it('is byte-identical for the same input across 3 consecutive runs', async () => {
    const results = await Promise.all([
      generateServerJson(baseOpts()),
      generateServerJson(baseOpts()),
      generateServerJson(baseOpts()),
    ]);
    expect(results[0]!.json).toBe(results[1]!.json);
    expect(results[1]!.json).toBe(results[2]!.json);
  });

  it('environmentVariables array order is independent of input order', async () => {
    const reversed = [...ENV_VARS].reverse();
    const a = await generateServerJson(baseOpts());
    const b = await generateServerJson({ ...baseOpts(), environmentVariables: reversed });
    expect(a.json).toBe(b.json);
  });
});

describe('generateServerJson — schema validation', () => {
  it('throws when package.json#description is missing', async () => {
    await expect(
      generateServerJson({
        ...baseOpts(),
        packageJson: { repository: PACKAGE_JSON.repository },
      }),
    ).rejects.toThrow(/description/);
  });

  it('throws when package.json#repository is missing', async () => {
    await expect(
      generateServerJson({
        ...baseOpts(),
        packageJson: { description: PACKAGE_JSON.description },
      }),
    ).rejects.toThrow(/repository/);
  });

  it("throws schema validation when version doesn't look like semver", async () => {
    await expect(
      generateServerJson({ ...baseOpts(), version: 'not-a-version' }),
    ).rejects.toThrow(/schema validation/);
  });

  it('throws schema validation when reverse_dns_name is malformed', async () => {
    await expect(
      generateServerJson({
        ...baseOpts(),
        config: { ...CONFIG, reverse_dns_name: 'bad name with spaces' },
      }),
    ).rejects.toThrow(/schema validation/);
  });
});
