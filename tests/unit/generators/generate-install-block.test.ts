import { describe, expect, it } from 'vitest';
import {
  generateAllInstallBlocks,
  generateInstallBlock,
  SUPPORTED_CLIENT_IDS,
  type ClientId,
} from '../../../src/generators/generate-install-block.js';
import type { EnvironmentVariableEntry } from '../../../src/generators/generate-environment-variables.js';

const CONFIG = {
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
  npm_package_name: '@g-digital/mcp-ead-factory',
  credential_help_url: 'https://eadtrust.example.com/onboarding',
};

const ENV_VARS: EnvironmentVariableEntry[] = [
  {
    description: 'EADTrust API key.',
    isRequired: true,
    isSecret: true,
    name: 'EADTRUST_API_KEY',
  },
  {
    description: 'HTTP port.',
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

const baseOpts = (clientId: ClientId = 'claude-desktop') => ({
  config: CONFIG,
  environmentVariables: [...ENV_VARS],
  clientId,
});

describe('generateInstallBlock — output shape per client', () => {
  it('uses mcpServers as the top-level key for non-VS-Code clients', async () => {
    for (const clientId of SUPPORTED_CLIENT_IDS.filter((c) => c !== 'vscode')) {
      const result = await generateInstallBlock(baseOpts(clientId));
      expect(result.topLevelKey).toBe('mcpServers');
      expect(result.parsed).toHaveProperty('mcpServers');
      expect(result.parsed).not.toHaveProperty('servers');
    }
  });

  it('uses servers (not mcpServers) as the top-level key for VS Code', async () => {
    const result = await generateInstallBlock(baseOpts('vscode'));
    expect(result.topLevelKey).toBe('servers');
    expect(result.parsed).toHaveProperty('servers');
    expect(result.parsed).not.toHaveProperty('mcpServers');
  });

  it('keys the server entry by the canonical short name (last segment of reverse_dns_name)', async () => {
    const result = await generateInstallBlock(baseOpts());
    expect(result.shortName).toBe('ead-factory');
    const servers = result.parsed.mcpServers as Record<string, unknown>;
    expect(servers['ead-factory']).toBeDefined();
  });

  it('emits command=npx and args=[-y, <npm_package_name>]', async () => {
    const result = await generateInstallBlock(baseOpts());
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const entry = servers['ead-factory']!;
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', CONFIG.npm_package_name]);
  });
});

describe('generateInstallBlock — env block contains only required vars', () => {
  it('env block lists every required variable and excludes non-required ones', async () => {
    const result = await generateInstallBlock(baseOpts());
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(['APP_PORT', 'EADTRUST_API_KEY']);
    expect(env).not.toHaveProperty('FEATURE_FLAG_X');
  });

  it('omits the env field entirely when no required variables exist', async () => {
    const result = await generateInstallBlock({
      ...baseOpts(),
      environmentVariables: [
        {
          description: 'optional only',
          isRequired: false,
          isSecret: false,
          name: 'OPTIONAL_ONE',
        },
      ],
    });
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers['ead-factory']?.env).toBeUndefined();
  });

  it('renders secret values as <PASTE_<NAME>_HERE> placeholders, never real values', async () => {
    const result = await generateInstallBlock(baseOpts());
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(env.EADTRUST_API_KEY).toBe('<PASTE_EADTRUST_API_KEY_HERE>');
  });

  it('renders non-secret required values as empty strings (user fills in)', async () => {
    const result = await generateInstallBlock(baseOpts());
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(env.APP_PORT).toBe('');
  });
});

describe('generateInstallBlock — markdown wrapping and credential note', () => {
  it('wraps the JSON in a ```json code fence', async () => {
    const result = await generateInstallBlock(baseOpts());
    expect(result.markdown).toMatch(/^```json\n/);
    expect(result.markdown).toMatch(/```\n\n>/);
  });

  it('includes a one-line note pointing to credential_help_url', async () => {
    const result = await generateInstallBlock(baseOpts());
    expect(result.markdown).toContain(CONFIG.credential_help_url);
    expect(result.markdown).toMatch(/^>.*credential.*$/im);
  });
});

describe('generateInstallBlock — determinism (NFR-R1)', () => {
  it('is byte-identical across 3 consecutive runs per client', async () => {
    for (const clientId of SUPPORTED_CLIENT_IDS) {
      const a = await generateInstallBlock(baseOpts(clientId));
      const b = await generateInstallBlock(baseOpts(clientId));
      const c = await generateInstallBlock(baseOpts(clientId));
      expect(a.markdown).toBe(b.markdown);
      expect(b.markdown).toBe(c.markdown);
    }
  });

  it('is byte-identical regardless of environmentVariables input order', async () => {
    const a = await generateInstallBlock(baseOpts());
    const b = await generateInstallBlock({
      ...baseOpts(),
      environmentVariables: [...ENV_VARS].reverse(),
    });
    expect(a.markdown).toBe(b.markdown);
  });

  it('renders a full set of 8 client outputs via generateAllInstallBlocks', async () => {
    const all = await generateAllInstallBlocks({
      config: CONFIG,
      environmentVariables: ENV_VARS,
    });
    expect(Object.keys(all).sort()).toEqual([...SUPPORTED_CLIENT_IDS].sort());
    for (const id of SUPPORTED_CLIENT_IDS) {
      expect(all[id].markdown).toMatch(/```json/);
    }
  });
});

describe('generateInstallBlock — input validation', () => {
  it('throws when reverse_dns_name has no /name suffix', async () => {
    await expect(
      generateInstallBlock({
        ...baseOpts(),
        config: { ...CONFIG, reverse_dns_name: 'io.github.org' },
      }),
    ).rejects.toThrow(/short-name/);
  });

  it('throws on an unsupported clientId', async () => {
    await expect(
      generateInstallBlock({ ...baseOpts(), clientId: 'unknown-client' as ClientId }),
    ).rejects.toThrow(/not supported/);
  });
});
