import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LICENSES,
  mcpEntrySchema,
  mcpPipelineConfigSchema,
} from '../../../src/schemas/mcp-pipeline-config.schema.js';

const validEntry = {
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/evidence-manager',
  npm_scope: '@g-digital',
  npm_package_name: '@g-digital/mcp-evidence-manager',
  docker_image_name: 'gdigital/evidence-manager',
  license: 'MIT',
  n8n_adapter_target_name: 'n8n-node-evidence-manager',
  credential_help_url: 'https://eadtrust.example.com/onboarding',
  target_overrides: {},
};

const wrap = (entry: unknown, key = 'evidence-manager') => ({
  pipeline_version: 1,
  mcp_schema_version: '2025-12-11',
  n8n_node_api_version: '1.0',
  mcps: { [key]: entry },
});

describe('mcpPipelineConfigSchema — valid fixtures', () => {
  it('parses minimal config with one MCP and only required fields', () => {
    const result = mcpPipelineConfigSchema.safeParse(wrap(validEntry));
    expect(result.success).toBe(true);
  });

  it('parses a config with two MCPs', () => {
    const config = {
      pipeline_version: 1,
      mcp_schema_version: '2025-12-11',
      n8n_node_api_version: '1.0',
      mcps: {
        'evidence-manager': validEntry,
        'second-mcp': {
          ...validEntry,
          reverse_dns_name: 'io.github.g-digital-by-Garrigues/second-mcp',
          npm_package_name: '@g-digital/mcp-second-mcp',
          docker_image_name: 'gdigital/second-mcp',
          n8n_adapter_target_name: 'n8n-node-second-mcp',
        },
      },
    };
    const result = mcpPipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('parses an entry with all optional fields populated', () => {
    const entry = {
      ...validEntry,
      track_a_targets: 'default',
      track_b_targets: ['n8n', 'make-rom'],
      logo_path: 'assets/logo-400x400.png',
      bundled_skills: [
        '.claude/commands/create-internal-evidence.md',
        '.claude/commands/create-signature-request.md',
      ],
    };
    const result = mcpEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts Apache-2.0 license', () => {
    const result = mcpEntrySchema.safeParse({ ...validEntry, license: 'Apache-2.0' });
    expect(result.success).toBe(true);
  });

  it('accepts npm_scope without @ prefix when npm_package_name is scoped', () => {
    const result = mcpEntrySchema.safeParse({
      ...validEntry,
      npm_scope: 'g-digital',
      npm_package_name: '@g-digital/mcp-evidence-manager',
    });
    expect(result.success).toBe(true);
  });

  it('accepts track_a_targets as an explicit list of target names', () => {
    const result = mcpEntrySchema.safeParse({
      ...validEntry,
      track_a_targets: ['smithery', 'docker-mcp-catalog', 'cline'],
    });
    expect(result.success).toBe(true);
  });
});

describe('mcpPipelineConfigSchema — invalid fixtures', () => {
  it('rejects an entry missing a required field (license)', () => {
    const { license: _omit, ...entry } = validEntry;
    const result = mcpEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'license')).toBe(true);
    }
  });

  it("rejects a non-MIT/Apache-2 license and surfaces the canonical allowed values", () => {
    const result = mcpEntrySchema.safeParse({ ...validEntry, license: 'BSD-3-Clause' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'license');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain(ALLOWED_LICENSES.join(', '));
    }
  });

  it('rejects a malformed reverse_dns_name (missing /name segment)', () => {
    const result = mcpEntrySchema.safeParse({
      ...validEntry,
      reverse_dns_name: 'io.github.g-digital-by-Garrigues',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'reverse_dns_name')).toBe(true);
    }
  });

  it('rejects a credential_help_url that is not a valid URL', () => {
    const result = mcpEntrySchema.safeParse({
      ...validEntry,
      credential_help_url: 'not-a-url',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'credential_help_url'),
      ).toBe(true);
    }
  });

  it('rejects a non-kebab-case MCP key in the mcps record', () => {
    const config = {
      pipeline_version: 1,
      mcp_schema_version: '2025-12-11',
      n8n_node_api_version: '1.0',
      mcps: { EvidenceManager: validEntry },
    };
    const result = mcpPipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects an npm_package_name whose scope does not match npm_scope', () => {
    const result = mcpEntrySchema.safeParse({
      ...validEntry,
      npm_scope: '@g-digital',
      npm_package_name: '@other-scope/mcp-evidence-manager',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'npm_package_name');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('npm_scope');
    }
  });
});
