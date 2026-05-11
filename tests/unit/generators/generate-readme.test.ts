import { describe, expect, it } from 'vitest';
import {
  CLIENT_DISPLAY_NAMES,
  generateReadme,
  README_MARKER_ENV,
  README_MARKER_INSTALL,
} from '../../../src/generators/generate-readme.js';
import {
  generateAllInstallBlocks,
  SUPPORTED_CLIENT_IDS,
} from '../../../src/generators/generate-install-block.js';
import type { EnvironmentVariableEntry } from '../../../src/generators/generate-environment-variables.js';

const CONFIG = {
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/evidence-manager',
  npm_package_name: '@g-digital/mcp-evidence-manager',
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
    description: 'HTTP port the server binds to.',
    isRequired: true,
    isSecret: false,
    name: 'APP_PORT',
  },
];

const SOURCE_README = [
  '# Evidence Manager MCP',
  '',
  'Manages legal evidence artifacts.',
  '',
  '## Install',
  '',
  README_MARKER_INSTALL,
  '',
  '## Configuration',
  '',
  README_MARKER_ENV,
  '',
  '## License',
  '',
  'MIT',
  '',
].join('\n');

async function baseOpts() {
  const installBlocks = await generateAllInstallBlocks({
    config: CONFIG,
    environmentVariables: ENV_VARS,
  });
  return {
    sourceReadme: SOURCE_README,
    installBlocks,
    environmentVariables: ENV_VARS,
  };
}

describe('generateReadme — happy path', () => {
  it('replaces the INSTALL_BLOCKS marker with one section per client', async () => {
    const result = generateReadme(await baseOpts());
    for (const clientId of SUPPORTED_CLIENT_IDS) {
      expect(result.markdown).toContain(`### ${CLIENT_DISPLAY_NAMES[clientId]}`);
    }
    expect(result.markdown).not.toContain(README_MARKER_INSTALL);
  });

  it('replaces the ENV_VARS marker with a markdown table', async () => {
    const result = generateReadme(await baseOpts());
    expect(result.markdown).toContain('| Name | Required | Secret | Description |');
    expect(result.markdown).toContain('| `APP_PORT` | Yes | No |');
    expect(result.markdown).toContain('| `EADTRUST_API_KEY` | Yes | Yes |');
    expect(result.markdown).not.toContain(README_MARKER_ENV);
  });

  it('env table entries are sorted alphabetically by name', async () => {
    const result = generateReadme(await baseOpts());
    const apIdx = result.markdown.indexOf('| `APP_PORT`');
    const eaIdx = result.markdown.indexOf('| `EADTRUST_API_KEY`');
    expect(apIdx).toBeGreaterThan(-1);
    expect(eaIdx).toBeGreaterThan(-1);
    expect(apIdx).toBeLessThan(eaIdx);
  });

  it('preserves the rest of the source narrative verbatim', async () => {
    const result = generateReadme(await baseOpts());
    expect(result.markdown).toContain('# Evidence Manager MCP');
    expect(result.markdown).toContain('Manages legal evidence artifacts.');
    expect(result.markdown).toContain('## License');
    expect(result.markdown).toContain('MIT');
  });
});

describe('generateReadme — marker validation', () => {
  it('throws when the INSTALL_BLOCKS marker is missing, naming it in the message', async () => {
    const opts = await baseOpts();
    expect(() =>
      generateReadme({
        ...opts,
        sourceReadme: opts.sourceReadme.replace(README_MARKER_INSTALL, ''),
      }),
    ).toThrow(/INSTALL_BLOCKS/);
  });

  it('throws when the ENV_VARS marker is missing, naming it in the message', async () => {
    const opts = await baseOpts();
    expect(() =>
      generateReadme({
        ...opts,
        sourceReadme: opts.sourceReadme.replace(README_MARKER_ENV, ''),
      }),
    ).toThrow(/ENV_VARS/);
  });

  it('lists both markers in the error when both are missing', async () => {
    const opts = await baseOpts();
    let caught: Error | null = null;
    try {
      generateReadme({ ...opts, sourceReadme: '# Empty\n' });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toContain('INSTALL_BLOCKS');
    expect(caught?.message).toContain('ENV_VARS');
  });

  it('tolerates leading/trailing whitespace around the marker on its line', async () => {
    const opts = await baseOpts();
    const readme = opts.sourceReadme
      .replace(README_MARKER_INSTALL, `   ${README_MARKER_INSTALL}   `)
      .replace(README_MARKER_ENV, `\t${README_MARKER_ENV}\t`);
    const result = generateReadme({ ...opts, sourceReadme: readme });
    expect(result.markdown).toContain('| `APP_PORT`');
    expect(result.markdown).not.toContain(README_MARKER_INSTALL);
  });
});

describe('generateReadme — env table edge cases', () => {
  it('renders a fallback line when there are no environment variables', async () => {
    const opts = await baseOpts();
    const result = generateReadme({ ...opts, environmentVariables: [] });
    expect(result.markdown).toContain('does not require any environment variables');
  });

  it('escapes pipe characters in env var descriptions to keep the table valid', async () => {
    const opts = await baseOpts();
    const result = generateReadme({
      ...opts,
      environmentVariables: [
        {
          description: 'Format like A | B | C.',
          isRequired: true,
          isSecret: false,
          name: 'PIPE_VAR',
        },
      ],
    });
    expect(result.markdown).toContain('A \\| B \\| C');
  });
});

describe('generateReadme — determinism (NFR-R1)', () => {
  it('is byte-identical across 3 consecutive runs with the same input', async () => {
    const opts = await baseOpts();
    const a = generateReadme(opts).markdown;
    const b = generateReadme(opts).markdown;
    const c = generateReadme(opts).markdown;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('is byte-identical regardless of environmentVariables input order', async () => {
    const opts = await baseOpts();
    const a = generateReadme(opts).markdown;
    const b = generateReadme({
      ...opts,
      environmentVariables: [...ENV_VARS].reverse(),
    }).markdown;
    expect(a).toBe(b);
  });
});

describe('generateReadme — missing-clientId fail-fast', () => {
  it('throws when installBlocks is missing an entry for a supported client', async () => {
    const opts = await baseOpts();
    const partial = { ...opts.installBlocks } as Partial<typeof opts.installBlocks>;
    delete partial.zed;
    expect(() =>
      generateReadme({
        ...opts,
        installBlocks: partial as typeof opts.installBlocks,
      }),
    ).toThrow(/zed/);
  });
});
