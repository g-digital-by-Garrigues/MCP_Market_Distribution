import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { runTrackALayer1 } from '../../src/gates/run-track-a-layer-1.js';
import { errorReportSchema } from '../../src/schemas/error-report.schema.js';

const MCP_NAME = 'ead-factory';

const CONFIG = {
  pipeline_version: 1,
  mcp_schema_version: '2025-12-11',
  n8n_node_api_version: '1.0',
  mcps: {
    [MCP_NAME]: {
      reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
      npm_scope: '@g-digital',
      npm_package_name: '@g-digital/mcp-ead-factory',
      docker_image_name: 'gdigital/ead-factory',
      license: 'MIT',
      n8n_adapter_target_name: 'n8n-node-ead-factory',
      credential_help_url: 'https://eadtrust.example.com/onboarding',
      target_overrides: {},
    },
  },
};

const VALID_SERVER_JSON = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  description: 'EAD Factory MCP',
  name: 'io.github.g-digital-by-Garrigues/ead-factory',
  packages: [
    {
      environmentVariables: [
        {
          description: 'EADTrust API key.',
          isRequired: true,
          isSecret: true,
          name: 'EADTRUST_API_KEY',
        },
      ],
      identifier: '@g-digital/mcp-ead-factory',
      registryType: 'npm',
      transport: { type: 'stdio' },
      version: '1.0.0',
    },
  ],
  repository: { source: 'github', url: 'https://github.com/g-digital-by-Garrigues/ead-factory' },
  version: '1.0.0',
};

const VALID_SMITHERY_YAML = [
  '# Smithery configuration (v1)',
  'configSchema:',
  '  $schema: "https://json-schema.org/draft/2020-12/schema"',
  '  properties:',
  '    EADTRUST_API_KEY:',
  '      description: "EADTrust API key"',
  '      format: "password"',
  '      type: "string"',
  '  required:',
  '    - EADTRUST_API_KEY',
  '  type: "object"',
  'runtime: "typescript"',
  '',
].join('\n');

const MIT_LICENSE = `MIT License

Copyright (c) 2026 J&A Garrigues

Permission is hereby granted, free of charge, to any person obtaining a copy...`;

const APACHE_LICENSE = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License")...`;

const GPL_LICENSE = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007

Copyright (C) 2007 Free Software Foundation, Inc.`;

interface FixtureOverrides {
  licenseContent?: string | null;
  serverJsonContent?: string | null;
  smitheryYamlContent?: string | null;
  removeSource?: '.env.example' | 'README.md' | 'package.json';
  configLicense?: 'MIT' | 'Apache-2.0';
}

async function seedFixture(overrides: FixtureOverrides = {}): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'layer-1-'));
  const mcpFolder = path.join(repoRoot, 'pending-to-publish', MCP_NAME);
  await fs.mkdir(mcpFolder, { recursive: true });

  const config = { ...CONFIG };
  if (overrides.configLicense) {
    config.mcps[MCP_NAME] = { ...config.mcps[MCP_NAME], license: overrides.configLicense };
  }
  await fs.writeFile(
    path.join(repoRoot, 'mcp-pipeline.yaml'),
    yaml.dump(config),
    'utf8',
  );

  // Source files (Story 1.3 validator inputs)
  const sourceFiles: Record<string, string> = {
    'package.json': JSON.stringify(
      { name: '@g-digital/mcp-ead-factory', version: '1.0.0', mcpName: CONFIG.mcps[MCP_NAME].reverse_dns_name },
      null,
      2,
    ),
    LICENSE: overrides.licenseContent === undefined ? MIT_LICENSE : (overrides.licenseContent ?? ''),
    '.env.example': '# EADTrust API key\nEADTRUST_API_KEY=\n',
    'README.md': '# EAD Factory MCP\n',
  };
  if (overrides.removeSource) delete sourceFiles[overrides.removeSource];
  if (overrides.licenseContent === null) delete sourceFiles.LICENSE;
  for (const [name, content] of Object.entries(sourceFiles)) {
    await fs.writeFile(path.join(mcpFolder, name), content, 'utf8');
  }

  // Generated artifacts
  if (overrides.serverJsonContent === undefined) {
    await fs.writeFile(
      path.join(mcpFolder, 'server.json'),
      JSON.stringify(VALID_SERVER_JSON, null, 2),
      'utf8',
    );
  } else if (overrides.serverJsonContent !== null) {
    await fs.writeFile(path.join(mcpFolder, 'server.json'), overrides.serverJsonContent, 'utf8');
  }

  if (overrides.smitheryYamlContent === undefined) {
    await fs.writeFile(path.join(mcpFolder, 'smithery.yaml'), VALID_SMITHERY_YAML, 'utf8');
  } else if (overrides.smitheryYamlContent !== null) {
    await fs.writeFile(path.join(mcpFolder, 'smithery.yaml'), overrides.smitheryYamlContent, 'utf8');
  }

  return repoRoot;
}

describe('Track A — Layer 1 static validation gate', () => {
  let repoRoot: string;
  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('happy path: passes every check and emits gate.layer_1_passed', async () => {
    repoRoot = await seedFixture();
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME, pipelineRunId: 'run-42' });
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.log.event).toBe('gate.layer_1_passed');
    expect(result.log.pipeline_run_id).toBe('run-42');
    expect(result.checks.map((c) => c.name).sort()).toEqual(
      ['license', 'server-json', 'smithery-yaml', 'source-folder'],
    );
  });

  it('accepts Apache-2.0 license content when mcp-pipeline.yaml declares Apache-2.0', async () => {
    repoRoot = await seedFixture({ licenseContent: APACHE_LICENSE, configLicense: 'Apache-2.0' });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    expect(result.passed).toBe(true);
  });

  it('failure mode 1: non-MIT/Apache license — exits non-zero with the AC-mandated action', async () => {
    repoRoot = await seedFixture({ licenseContent: GPL_LICENSE });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    expect(result.passed).toBe(false);
    expect(result.log.event).toBe('gate.layer_1_failed');
    const licenseError = result.errors.find(
      (e) => e.stage === 'gate' && e.layer === 1 && e.check === 'license',
    );
    expect(licenseError).toBeDefined();
    expect(licenseError!.action).toBe(
      'Change LICENSE to MIT or Apache-2.0; Docker MCP Catalog rejects GPL.',
    );
    expect(licenseError!.source_path).toBe('LICENSE');
    expect(errorReportSchema.safeParse(licenseError).success).toBe(true);
  });

  it('failure mode 2: source folder missing .env.example', async () => {
    repoRoot = await seedFixture({ removeSource: '.env.example' });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    expect(result.passed).toBe(false);
    const sourceError = result.errors.find((e) => e.check === 'source_folder');
    expect(sourceError).toBeDefined();
    expect(sourceError!.observation).toContain('.env.example');
    expect(sourceError!.action).toMatch(/preflight-mcp/);
  });

  it('failure mode 3: server.json fails ajv schema validation', async () => {
    const broken = { ...VALID_SERVER_JSON, version: 'not-a-semver' };
    repoRoot = await seedFixture({ serverJsonContent: JSON.stringify(broken, null, 2) });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    expect(result.passed).toBe(false);
    const serverError = result.errors.find((e) => e.check === 'server_json');
    expect(serverError).toBeDefined();
    expect(serverError!.observation).toContain('ajv schema validation');
    expect(serverError!.action).toMatch(/prep-mcp/);
  });

  it('failure mode 4: smithery.yaml is malformed YAML', async () => {
    repoRoot = await seedFixture({
      smitheryYamlContent: 'runtime: typescript\nconfigSchema: { not: closed',
    });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    expect(result.passed).toBe(false);
    const yamlError = result.errors.find((e) => e.check === 'smithery_yaml');
    expect(yamlError).toBeDefined();
    expect(yamlError!.observation).toMatch(/parse|YAML/);
  });

  it('every emitted error carries the canonical stage/layer/target shape', async () => {
    repoRoot = await seedFixture({ licenseContent: GPL_LICENSE });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    for (const err of result.errors) {
      expect(err.stage).toBe('gate');
      expect(err.layer).toBe(1);
      expect(err.target).toBeNull();
    }
  });

  it('every emitted error report validates against errorReportSchema', async () => {
    repoRoot = await seedFixture({ licenseContent: GPL_LICENSE, removeSource: '.env.example' });
    const result = await runTrackALayer1({ repoRoot, mcpName: MCP_NAME });
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const err of result.errors) {
      const parsed = errorReportSchema.safeParse(err);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    }
  });
});
