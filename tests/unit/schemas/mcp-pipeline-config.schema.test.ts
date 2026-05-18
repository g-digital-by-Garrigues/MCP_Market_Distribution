import { describe, expect, it } from 'vitest';
import {
  mcpEntrySchema,
  mcpPipelineConfigSchema,
} from '../../../src/schemas/mcp-pipeline-config.schema.js';

// Post v1.1 refactor: mcp-pipeline.yaml entries carry ONLY `repo_url`.
// Every other per-MCP field (npm scope, license, tools, etc.) moved into
// the per-MCP `.distribution.yaml` schema — see distribution-config.schema.test.ts
// for those cases.

const validEntry = {
  repo_url: 'https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP',
};

const wrap = (entry: unknown, key = 'ead-factory') => ({
  pipeline_version: 1,
  mcp_schema_version: '2025-12-11',
  n8n_node_api_version: '1.0',
  mcps: { [key]: entry },
});

describe('mcpPipelineConfigSchema — valid fixtures', () => {
  it('parses minimal config with one MCP', () => {
    const result = mcpPipelineConfigSchema.safeParse(wrap(validEntry));
    expect(result.success).toBe(true);
  });

  it('parses a config with two MCPs', () => {
    const config = {
      pipeline_version: 1,
      mcp_schema_version: '2025-12-11',
      n8n_node_api_version: '1.0',
      mcps: {
        'ead-factory': validEntry,
        'second-mcp': { repo_url: 'https://github.com/example/Second-MCP' },
      },
    };
    const result = mcpPipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

describe('mcpPipelineConfigSchema — invalid fixtures', () => {
  it('rejects an entry missing repo_url', () => {
    const result = mcpEntrySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'repo_url')).toBe(true);
    }
  });

  it('rejects a repo_url that is not a valid URL', () => {
    const result = mcpEntrySchema.safeParse({ repo_url: 'not-a-url' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.join('.') === 'repo_url');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('HTTPS URL');
    }
  });

  it('rejects extra unknown fields in an entry (strict schema)', () => {
    const result = mcpEntrySchema.safeParse({
      repo_url: 'https://github.com/x/y',
      npm_scope: '@g-digital', // moved to .distribution.yaml
    });
    expect(result.success).toBe(false);
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
});
