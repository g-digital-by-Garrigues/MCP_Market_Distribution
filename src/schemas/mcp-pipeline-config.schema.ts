import { z } from 'zod';

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REVERSE_DNS = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+\/[A-Za-z][A-Za-z0-9-]*$/;
const NPM_SCOPE = /^@?[a-z0-9][a-z0-9._-]*$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const DOCKER_IMAGE_NAME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const N8N_API_VERSION = /^\d+\.\d+$/;

export const ALLOWED_LICENSES = ['MIT', 'Apache-2.0'] as const;
export type AllowedLicense = (typeof ALLOWED_LICENSES)[number];

const licenseSchema = z.enum(ALLOWED_LICENSES, {
  errorMap: () => ({
    message: `license must be one of: ${ALLOWED_LICENSES.join(', ')} (per FR14 Layer 1)`,
  }),
});

const trackATargetsSchema = z.union([
  z.literal('default'),
  z.array(z.string().regex(KEBAB_CASE)).min(1),
]);

const trackBTargetsSchema = z.array(z.string().regex(KEBAB_CASE));

const targetOverridesSchema = z.record(z.string(), z.unknown());

export const mcpEntrySchema = z
  .object({
    reverse_dns_name: z.string().regex(REVERSE_DNS, {
      message:
        "reverse_dns_name must match '<domain.tld>/<name>' (e.g., io.github.org/my-mcp)",
    }),
    npm_scope: z.string().regex(NPM_SCOPE, {
      message: "npm_scope must be a valid npm scope (e.g., '@g-digital' or 'g-digital')",
    }),
    npm_package_name: z.string().regex(NPM_PACKAGE_NAME, {
      message:
        "npm_package_name must be a valid npm package name (e.g., '@scope/name' or 'name')",
    }),
    docker_image_name: z.string().regex(DOCKER_IMAGE_NAME, {
      message: "docker_image_name must match '<org>/<image>' (e.g., gdigital/my-mcp)",
    }),
    license: licenseSchema,
    n8n_adapter_target_name: z.string().regex(KEBAB_CASE, {
      message: 'n8n_adapter_target_name must be a kebab-case string',
    }),
    credential_help_url: z.string().url({
      message: 'credential_help_url must be a valid URL',
    }),
    target_overrides: targetOverridesSchema,
    track_a_targets: trackATargetsSchema.optional(),
    track_b_targets: trackBTargetsSchema.optional(),
    logo_path: z.string().min(1).optional(),
    bundled_skills: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.npm_package_name.startsWith('@')) {
      const normalizedScope = data.npm_scope.startsWith('@')
        ? data.npm_scope
        : `@${data.npm_scope}`;
      if (!data.npm_package_name.startsWith(`${normalizedScope}/`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['npm_package_name'],
          message: `npm_package_name must start with '${normalizedScope}/' to match npm_scope`,
        });
      }
    }
  });

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
