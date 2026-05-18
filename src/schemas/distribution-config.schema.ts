import { z } from 'zod';

// Schema for `.distribution.yaml` — the per-MCP publish config that lives
// at the root of each MCP's OWN public repo (e.g.
// g-digital-by-Garrigues/EAD-Factory-MCP). The pipeline clones that repo
// into pending-to-publish/<mcp_name>/ at workflow time (see
// actions/checkout-mcp-source/action.yml) and every consumer reads its
// per-MCP fields from there.
//
// This schema is the source of truth for those fields; the older
// mcp-pipeline.yaml registry now only carries `repo_url` per entry.

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REVERSE_DNS = /^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+\/[A-Za-z][A-Za-z0-9-]*$/;
const NPM_SCOPE = /^@?[a-z0-9][a-z0-9._-]*$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const DOCKER_IMAGE_NAME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const GIT_TAG_PREFIX = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_GIT_TAG_PREFIX = 'v';

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

export const distributionConfigSchema = z
  .object({
    // Bumped when the .distribution.yaml shape changes in a non-backward
    // compatible way. v1 is the initial layout (post per-MCP-repo refactor).
    distribution_schema_version: z.literal(1),
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
    // Per-MCP list of target ids the pipeline should NOT publish to.
    // Used to defer a store whose contract the pipeline doesn't yet
    // satisfy (e.g. Smithery's 2026 model requires MCPB bundles or
    // self-hosted URL — neither of which v1.0 implements). Items must
    // match canonical target ids from src/schemas/target-ids.ts.
    skip_targets: z.array(z.string().min(1)).optional(),
    logo_path: z.string().min(1).optional(),
    bundled_skills: z.array(z.string().min(1)).optional(),
    // Static tool inventory shipped to Docker MCP Catalog. Each entry needs
    // a non-empty description; the docker-mcp-catalog publisher refuses to
    // ship an empty list or any tool with a blank description (so reviewers
    // don't see a half-baked submission).
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]*$/, {
              message: 'tool name must be snake_case ASCII (e.g., generate_evidence)',
            }),
            description: z.string().min(1, {
              message: 'tool description cannot be empty',
            }),
          })
          .strict(),
      )
      .optional(),
    git_tag_prefix: z
      .string()
      .regex(GIT_TAG_PREFIX, {
        message:
          "git_tag_prefix must contain only letters, digits, '.', '_' or '-' (e.g., 'v' or 'ead-factory-v')",
      })
      .optional(),
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

export type DistributionConfig = z.infer<typeof distributionConfigSchema>;
