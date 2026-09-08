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

// Story 18.5 AC6: no product API host may appear in a pipeline fixture.
const SYNTHETIC_HOST = 'https://api.example.test';

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

  // Story 18.5 AC2 — rewritten from "renders non-secret required values as empty
  // strings (user fills in)". A bare "" is indistinguishable from an optional blank and
  // boots the server with an empty value instead of failing loudly. APP_PORT is
  // required, non-secret and has no discoverable default: the AC2 case.
  it('renders a required non-secret with no discoverable default as <SET_<NAME>_HERE>', async () => {
    const result = await generateInstallBlock(baseOpts());
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(env.APP_PORT).toBe('<SET_APP_PORT_HERE>');
    expect(env.APP_PORT).not.toBe('');
  });

  // Story 18.5 AC1 — a required non-secret the emitted source carries a default for is
  // pre-filled with the DISCOVERED value, never authored by the pipeline.
  it('pre-fills a required non-secret from emittedDefaults when one is discoverable', async () => {
    const result = await generateInstallBlock({
      ...baseOpts(),
      environmentVariables: [
        ...ENV_VARS,
        {
          description: 'API base URL.',
          isRequired: true,
          isSecret: false,
          name: 'MCP_API_BASE_URL',
        },
      ],
      emittedDefaults: { MCP_API_BASE_URL: SYNTHETIC_HOST },
    });
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(env.MCP_API_BASE_URL).toBe(SYNTHETIC_HOST);
    // …and the no-default branch is untouched in the same render.
    expect(env.APP_PORT).toBe('<SET_APP_PORT_HERE>');
  });

  // Story 18.5 AC3 / NFR-S5 — a secret can never take a discovered value, even if the
  // discovery map happens to carry its name.
  it('never lets a discovered default reach a secret variable', async () => {
    const result = await generateInstallBlock({
      ...baseOpts(),
      emittedDefaults: { EADTRUST_API_KEY: 'sk-should-never-appear' },
    });
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(env.EADTRUST_API_KEY).toBe('<PASTE_EADTRUST_API_KEY_HERE>');
    expect(result.markdown).not.toContain('sk-should-never-appear');
  });

  // Story 18.5 AC3 — an optional variable stays absent even when the map has an entry.
  it('still emits no key for an optional variable that has an entry in emittedDefaults', async () => {
    const result = await generateInstallBlock({
      ...baseOpts(),
      emittedDefaults: { FEATURE_FLAG_X: 'on' },
    });
    const servers = result.parsed.mcpServers as Record<string, Record<string, unknown>>;
    const env = servers['ead-factory']?.env as Record<string, string>;
    expect(env).not.toHaveProperty('FEATURE_FLAG_X');
    expect(Object.keys(env).sort()).toEqual(['APP_PORT', 'EADTRUST_API_KEY']);
  });
});

// Story 18.5 AC5 — the eight templates are byte-identical and share one buildEnvBlock
// call, but the coverage is asserted rather than argued: no bare empty string may reach
// any client, VS Code's `servers` shape included.
describe('generateInstallBlock — no bare empty string reaches any client (AC5)', () => {
  it('emits no bare empty string in any of the eight client blocks', async () => {
    const all = await generateAllInstallBlocks({
      config: CONFIG,
      environmentVariables: [
        ...ENV_VARS,
        {
          description: 'API base URL.',
          isRequired: true,
          isSecret: false,
          name: 'MCP_API_BASE_URL',
        },
      ],
      emittedDefaults: { MCP_API_BASE_URL: SYNTHETIC_HOST },
    });
    for (const id of SUPPORTED_CLIENT_IDS) {
      expect(all[id].markdown, `client ${id} must not emit a bare empty string`).not.toMatch(
        /":\s*""/,
      );
    }
  });

  it('renders no bare empty string even with no emittedDefaults at all', async () => {
    const all = await generateAllInstallBlocks({
      config: CONFIG,
      environmentVariables: ENV_VARS,
    });
    for (const id of SUPPORTED_CLIENT_IDS) {
      expect(all[id].markdown, `client ${id} must not emit a bare empty string`).not.toMatch(
        /":\s*""/,
      );
    }
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

  // Story 18.5: NFR-R1 covers the new input too — a discovered default must not make
  // the render order-sensitive.
  it('is byte-identical regardless of input order when emittedDefaults are supplied', async () => {
    const withBaseUrl: EnvironmentVariableEntry[] = [
      ...ENV_VARS,
      {
        description: 'API base URL.',
        isRequired: true,
        isSecret: false,
        name: 'MCP_API_BASE_URL',
      },
    ];
    const emittedDefaults = { MCP_API_BASE_URL: SYNTHETIC_HOST };
    const a = await generateInstallBlock({
      ...baseOpts(),
      environmentVariables: withBaseUrl,
      emittedDefaults,
    });
    const b = await generateInstallBlock({
      ...baseOpts(),
      environmentVariables: [...withBaseUrl].reverse(),
      emittedDefaults,
    });
    expect(a.markdown).toBe(b.markdown);
    expect(a.markdown).toContain(SYNTHETIC_HOST);
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

describe('MCP_API_BASE_URL discovery is mandatory when the contract marks it required', () => {
  // The narrow guard, and why it is narrow. `isRequired` alone cannot separate
  // "there is a canonical value and discovery lost it" from "there is no canonical
  // value and a placeholder is correct": EAD Factory declares MCP_SVC_TOKEN_URL and
  // MCP_SVC_CLIENT_ID required with no bakeable value. MCP_API_BASE_URL is the one
  // where a placeholder is KNOWN wrong when required — the server refuses to start
  // without it, so the snippet cannot boot. Raised with generation on #255; the
  // durable fix is for the contract to declare which variables have a canonical value.
  const baseUrlRequired: EnvironmentVariableEntry[] = [
    {
      description: 'Upstream API root.',
      isRequired: true,
      isSecret: false,
      name: 'MCP_API_BASE_URL',
    },
  ];

  it('renders the discovered value when the scrape finds one', async () => {
    const result = await generateInstallBlock({
      config: CONFIG,
      environmentVariables: baseUrlRequired,
      clientId: 'claude-desktop',
      emittedDefaults: { MCP_API_BASE_URL: SYNTHETIC_HOST },
    });
    const rendered = JSON.stringify(result.parsed);
    expect(rendered).toContain(SYNTHETIC_HOST);
    expect(rendered).not.toContain('<SET_MCP_API_BASE_URL_HERE>');
  });

  it('FAILS instead of shipping a placeholder when the scrape finds nothing', async () => {
    // The regression this exists to catch: generation renames or restructures
    // src/tools/session_login.ts, the regex stops matching, and eight install
    // blocks per product silently degrade to a snippet that cannot boot.
    await expect(
      generateInstallBlock({
        config: CONFIG,
        environmentVariables: baseUrlRequired,
        clientId: 'claude-desktop',
        emittedDefaults: {},
      }),
    ).rejects.toThrow(/MCP_API_BASE_URL is declared isRequired: true but no value could be discovered/);
  });

  it('leaves EAD Factory alone: required, valueless, non-secret vars keep their marker', async () => {
    // MCP_SVC_TOKEN_URL and MCP_SVC_CLIENT_ID are required and non-secret and have
    // no canonical value by design — per deployment, not per product. A blanket
    // fail-closed rule would break EAD Factory's install blocks entirely.
    const eadFactoryShape: EnvironmentVariableEntry[] = [
      { description: 'Token endpoint.', isRequired: true, isSecret: false, name: 'MCP_SVC_TOKEN_URL' },
      { description: 'Client id.', isRequired: true, isSecret: false, name: 'MCP_SVC_CLIENT_ID' },
      { description: 'Gateway root.', isRequired: false, isSecret: false, name: 'MCP_API_BASE_URL' },
    ];
    const result = await generateInstallBlock({
      config: CONFIG,
      environmentVariables: eadFactoryShape,
      clientId: 'claude-desktop',
      emittedDefaults: {},
    });
    const rendered = JSON.stringify(result.parsed);
    expect(rendered).toContain('<SET_MCP_SVC_TOKEN_URL_HERE>');
    expect(rendered).toContain('<SET_MCP_SVC_CLIENT_ID_HERE>');
    // Optional vars are not emitted at all, so the guard never sees this one.
    expect(rendered).not.toContain('MCP_API_BASE_URL');
  });
});
