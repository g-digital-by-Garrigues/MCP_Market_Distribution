import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LICENSES,
  distributionConfigSchema,
} from '../../../src/schemas/distribution-config.schema.js';

// Per-MCP publish config moved to .distribution.yaml in v1.1. This file
// tests the field-level validation that used to live in
// mcp-pipeline-config.schema.test.ts (license whitelist, reverse-DNS
// format, credential URL, scope/package alignment, etc.).

const validConfig = {
  distribution_schema_version: 1 as const,
  reverse_dns_name: 'io.github.g-digital-by-Garrigues/ead-factory',
  npm_scope: '@g-digital',
  npm_package_name: '@g-digital/mcp-ead-factory',
  docker_image_name: 'gdigital/ead-factory',
  license: 'MIT' as const,
  n8n_adapter_target_name: 'n8n-nodes-ead-factory',
  credential_help_url: 'https://eadtrust.example.com/onboarding',
  target_overrides: {},
};

describe('distributionConfigSchema — valid fixtures', () => {
  it('parses minimal config with only required fields', () => {
    const result = distributionConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it('parses a config with all optional fields populated', () => {
    const config = {
      ...validConfig,
      track_a_targets: 'default',
      track_b_targets: ['n8n', 'make-rom'],
      logo_path: 'assets/logo-400x400.png',
      bundled_skills: [
        '.claude/commands/create-internal-evidence.md',
        '.claude/commands/create-signature-request.md',
      ],
      tools: [
        { name: 'generate_evidence', description: 'Generates evidence.' },
      ],
      skip_targets: ['smithery'],
    };
    const result = distributionConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('accepts Apache-2.0 license', () => {
    const result = distributionConfigSchema.safeParse({ ...validConfig, license: 'Apache-2.0' });
    expect(result.success).toBe(true);
  });

  it('accepts npm_scope without @ prefix when npm_package_name is scoped', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      npm_scope: 'g-digital',
      npm_package_name: '@g-digital/mcp-ead-factory',
    });
    expect(result.success).toBe(true);
  });

  it('accepts track_a_targets as an explicit list of target names', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      track_a_targets: ['smithery', 'docker-mcp-catalog', 'cline'],
    });
    expect(result.success).toBe(true);
  });
});

describe('distributionConfigSchema — invalid fixtures', () => {
  it('rejects a config missing a required field (license)', () => {
    const { license: _omit, ...config } = validConfig;
    const result = distributionConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'license')).toBe(true);
    }
  });

  it('rejects a non-MIT/Apache-2 license and surfaces the canonical allowed values', () => {
    const result = distributionConfigSchema.safeParse({ ...validConfig, license: 'BSD-3-Clause' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'license');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain(ALLOWED_LICENSES.join(', '));
    }
  });

  it('rejects a malformed reverse_dns_name (missing /name segment)', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      reverse_dns_name: 'io.github.g-digital-by-Garrigues',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'reverse_dns_name')).toBe(true);
    }
  });

  it('rejects a credential_help_url that is not a valid URL', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      credential_help_url: 'not-a-url',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.join('.') === 'credential_help_url'),
      ).toBe(true);
    }
  });

  it('rejects an npm_package_name whose scope does not match npm_scope', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      npm_scope: '@g-digital',
      npm_package_name: '@other-scope/mcp-ead-factory',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'npm_package_name');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('npm_scope');
    }
  });

  it('rejects an unknown distribution_schema_version', () => {
    const result = distributionConfigSchema.safeParse({ ...validConfig, distribution_schema_version: 2 });
    expect(result.success).toBe(false);
  });

  // Story 11.3 (Epic 11): n8n connector display-name + description overrides.
  it('accepts valid n8n_connector_display_name and n8n_connector_description', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      n8n_connector_display_name: 'EAD Factory',
      n8n_connector_description:
        'EAD Factory connector for n8n — Digital Trust services from EAD Trust. 9 operations.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.n8n_connector_display_name).toBe('EAD Factory');
      expect(result.data.n8n_connector_description).toContain('EAD Factory connector for n8n');
    }
  });

  it('accepts config without n8n_connector_display_name and n8n_connector_description (both optional)', () => {
    const result = distributionConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.n8n_connector_display_name).toBeUndefined();
      expect(result.data.n8n_connector_description).toBeUndefined();
    }
  });

  it('rejects n8n_connector_display_name as empty string', () => {
    const result = distributionConfigSchema.safeParse({
      ...validConfig,
      n8n_connector_display_name: '',
    });
    expect(result.success).toBe(false);
  });
});
