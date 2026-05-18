import { z } from 'zod';
import type { N8nNodeSpec } from './types.js';

// Story 5.1d: optional LLM-refine pass.
//
// The deterministic codegen path (5.1a–c) emits a syntactically valid
// n8n node but the displayName + description copy comes from a naive
// title-case of the snake_case identifier ('get_evidence' → 'Get
// Evidence', 'Fetch evidence by id.'). That works but reads stiffly.
// This pass takes the spec to a Claude model and asks it to polish the
// copy — without touching identifiers, types, or property names — and
// merges the result back.
//
// Contract:
//   - With ANTHROPIC_API_KEY set → call Anthropic Messages API once,
//     parse the structured response, merge into the spec.
//   - Without ANTHROPIC_API_KEY → skip silently, return the original
//     spec with `applied: false` so CI without the key still passes.
//   - Network failure or invalid response → log to stderr, return the
//     original spec with `applied: false`. We NEVER block adapter
//     generation on the refine pass — it's pure polish.
//
// Why fetch() directly: avoids adding @anthropic-ai/sdk as a runtime
// dep for what's essentially one POST. The schema below validates the
// model's JSON output strictly so a hallucinated extra field can't
// silently corrupt the spec.

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 4096;

// Strict shape the model MUST return. Validates with zod so a missing
// field, wrong type, or extra key fails and we fall back to the original.
const refinedOperationSchema = z
  .object({
    name: z.string(),
    displayName: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const refinedCredentialSchema = z
  .object({
    envName: z.string(),
    displayName: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();

const refinementSchema = z
  .object({
    nodeDescription: z.string().min(1),
    operations: z.array(refinedOperationSchema),
    credentials: z.array(refinedCredentialSchema),
  })
  .strict();

type Refinement = z.infer<typeof refinementSchema>;

export interface SpecChange {
  /** Field path within the spec, e.g. 'operations[get_evidence].displayName'. */
  path: string;
  before: string;
  after: string;
}

export interface RefineWithLlmOptions {
  spec: N8nNodeSpec;
  /**
   * Override the fetch implementation — primarily for tests.
   * Defaults to the global fetch (Node >= 18).
   */
  fetchImpl?: typeof fetch;
  /** Env to read ANTHROPIC_API_KEY from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Model id; defaults to claude-sonnet-4-6 (cheap + fast for copy polish). */
  model?: string;
  /** Cap response size; defaults to 4096 tokens. */
  maxTokens?: number;
  /** Logger; defaults to a silent shim. */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface RefineWithLlmResult {
  spec: N8nNodeSpec;
  applied: boolean;
  /** Concrete diffs the refine pass introduced (empty when applied=false). */
  changes: SpecChange[];
  /** Set when the pass was attempted but failed; surfaced for the release report. */
  warning?: string;
}

function buildPrompt(spec: N8nNodeSpec): string {
  const input = {
    packageName: spec.packageName,
    sourceMcpPackageName: spec.sourceMcpPackageName,
    nodeDescription: spec.description,
    operations: spec.operations.map((o) => ({
      name: o.name,
      currentDisplayName: o.displayName,
      currentDescription: o.description,
    })),
    credentials: spec.credentials.map((c) => ({
      envName: c.envName,
      currentDisplayName: c.displayName,
      currentDescription: c.description ?? '',
      isSecret: c.isSecret,
    })),
  };
  return [
    "You are polishing user-facing copy for an n8n community node that wraps an MCP server. The structure, identifiers, and types are FIXED — only displayName and description strings change.",
    '',
    'Rules:',
    "- Operation `name` and credential `envName` are immutable; copy them verbatim into your output.",
    "- displayName: 2–4 words, Title Case, what the user sees in n8n's dropdown.",
    '- Operation description: one sentence (≤ 25 words) explaining what the operation does, no implementation jargon.',
    '- Credential description: one short sentence explaining where to obtain the value.',
    '- nodeDescription: one sentence (≤ 25 words) describing what the node does as a whole.',
    '- Output STRICT JSON only, no prose, no markdown, no code fences. Match the schema EXACTLY.',
    '',
    'Output schema:',
    '{',
    '  "nodeDescription": string,',
    '  "operations": [{"name": string, "displayName": string, "description": string}, ...],',
    '  "credentials": [{"envName": string, "displayName": string, "description"?: string}, ...]',
    '}',
    '',
    'Input:',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

function extractTextFromMessagesResponse(body: unknown): string {
  const r = body as { content?: Array<{ type?: string; text?: string }> };
  if (!r.content || !Array.isArray(r.content)) return '';
  return r.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

function tryParseJsonBlock(raw: string): unknown {
  const trimmed = raw.trim();
  // Tolerate the model wrapping its JSON in a ```json fence even though
  // we asked it not to.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1]! : trimmed;
  return JSON.parse(candidate);
}

function applyRefinement(spec: N8nNodeSpec, refined: Refinement): { spec: N8nNodeSpec; changes: SpecChange[] } {
  const changes: SpecChange[] = [];

  const next: N8nNodeSpec = {
    ...spec,
    operations: spec.operations.map((o) => ({ ...o, properties: [...o.properties] })),
    credentials: spec.credentials.map((c) => ({ ...c })),
  };

  if (refined.nodeDescription !== next.description) {
    changes.push({ path: 'description', before: next.description, after: refined.nodeDescription });
    next.description = refined.nodeDescription;
  }

  const operationsByName = new Map(refined.operations.map((o) => [o.name, o]));
  for (const op of next.operations) {
    const r = operationsByName.get(op.name);
    if (!r) continue;
    if (r.displayName !== op.displayName) {
      changes.push({ path: `operations[${op.name}].displayName`, before: op.displayName, after: r.displayName });
      op.displayName = r.displayName;
    }
    if (r.description !== op.description) {
      changes.push({ path: `operations[${op.name}].description`, before: op.description, after: r.description });
      op.description = r.description;
    }
  }

  const credentialsByEnv = new Map(refined.credentials.map((c) => [c.envName, c]));
  for (const cred of next.credentials) {
    const r = credentialsByEnv.get(cred.envName);
    if (!r) continue;
    if (r.displayName !== cred.displayName) {
      changes.push({
        path: `credentials[${cred.envName}].displayName`,
        before: cred.displayName,
        after: r.displayName,
      });
      cred.displayName = r.displayName;
    }
    if (r.description !== undefined && r.description !== (cred.description ?? '')) {
      changes.push({
        path: `credentials[${cred.envName}].description`,
        before: cred.description ?? '',
        after: r.description,
      });
      cred.description = r.description;
    }
  }

  return { spec: next, changes };
}

export async function refineWithLlm(opts: RefineWithLlmOptions): Promise<RefineWithLlmResult> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? { info: () => {}, warn: (m: string) => process.stderr.write(`${m}\n`) };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    logger.info('refineWithLlm: ANTHROPIC_API_KEY not set, skipping refinement.');
    return { spec: opts.spec, applied: false, changes: [] };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  let response: Response;
  try {
    response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: buildPrompt(opts.spec) }],
      }),
    });
  } catch (err) {
    const warning = `refineWithLlm: fetch failed: ${(err as Error).message}`;
    logger.warn(warning);
    return { spec: opts.spec, applied: false, changes: [], warning };
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const warning = `refineWithLlm: Anthropic API returned ${response.status}: ${errBody.slice(0, 400)}`;
    logger.warn(warning);
    return { spec: opts.spec, applied: false, changes: [], warning };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const warning = `refineWithLlm: response was not valid JSON: ${(err as Error).message}`;
    logger.warn(warning);
    return { spec: opts.spec, applied: false, changes: [], warning };
  }

  const raw = extractTextFromMessagesResponse(body);
  if (!raw) {
    const warning = 'refineWithLlm: response contained no text content.';
    logger.warn(warning);
    return { spec: opts.spec, applied: false, changes: [], warning };
  }

  let parsed: unknown;
  try {
    parsed = tryParseJsonBlock(raw);
  } catch (err) {
    const warning = `refineWithLlm: model did not return valid JSON: ${(err as Error).message}`;
    logger.warn(warning);
    return { spec: opts.spec, applied: false, changes: [], warning };
  }

  const refined = refinementSchema.safeParse(parsed);
  if (!refined.success) {
    const detail = refined.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const warning = `refineWithLlm: model output failed schema validation: ${detail}`;
    logger.warn(warning);
    return { spec: opts.spec, applied: false, changes: [], warning };
  }

  const { spec, changes } = applyRefinement(opts.spec, refined.data);
  return { spec, applied: true, changes };
}
