import { z } from 'zod';

// Registry of MCPs the pipeline knows how to publish. Each entry's only
// required field is `repo_url` — the HTTPS URL of the MCP's own public
// source repo. Everything else (npm scope, docker image name, license,
// tools list, etc.) lives in that repo's `.distribution.yaml` and is
// validated by src/schemas/distribution-config.schema.ts.
//
// Re-exports from distribution-config so callers that still need
// AllowedLicense / DEFAULT_GIT_TAG_PREFIX have a single import site.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const N8N_API_VERSION = /^\d+\.\d+$/;
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export {
  ALLOWED_LICENSES,
  DEFAULT_GIT_TAG_PREFIX,
  type AllowedLicense,
  type DistributionConfig,
} from './distribution-config.schema.js';

export const mcpEntrySchema = z
  .object({
    repo_url: z.string().url({
      message:
        'repo_url must be the full HTTPS URL of the MCP source repo (e.g., https://github.com/g-digital-by-Garrigues/EAD-Factory-MCP)',
    }),
  })
  .strict();

export const mcpPipelineConfigSchema = z
  .object({
    pipeline_version: z.number().int().positive(),
    mcp_schema_version: z.string().regex(ISO_DATE, {
      message: 'mcp_schema_version must be an ISO date (YYYY-MM-DD)',
    }),
    n8n_node_api_version: z.string().regex(N8N_API_VERSION, {
      message: "n8n_node_api_version must be '<major>.<minor>' (e.g., '1.0')",
    }),
    mcps: z.record(
      z.string().regex(KEBAB_CASE, { message: 'MCP key must be kebab-case' }),
      mcpEntrySchema,
    ),
  })
  .strict();

export type McpEntry = z.infer<typeof mcpEntrySchema>;
export type McpPipelineConfig = z.infer<typeof mcpPipelineConfigSchema>;
