import { promises as fs } from 'node:fs';
import path from 'node:path';

// Story 15.3 (Epic 15, FR60): bring generated copy in line with n8n's presentation
// rules before the linter gate ever sees it.
//
// Most of the violations that got v1.5.0 rejected are text, not logic: action labels
// in Title Case, descriptions ending in a period, "Id" where n8n writes "ID", option
// lists out of alphabetical order. ~120 of them across the three products. They
// originate in the generator's tool descriptions and display names, but they are n8n
// PRESENTATION, not MCP semantics — and a round-trip to the generator for a trailing
// period costs two days. So the pipeline owns them, next to the brand/label casing it
// already owns.
//
// Rather than hand-rolling heuristics that approximate n8n's rules, this runs n8n's
// OWN ESLint config (the exact rule set the Creator Portal reviews against) in --fix
// mode. Their autofixers are the definition of correct here; a reimplementation would
// drift from it the moment they change a rule.
//
// What --fix cannot repair (e.g. node-param-description-boolean-without-whether, which
// needs a human sentence) is deliberately left alone: the gate reports it and it gets
// fixed at its source. This module never silences a rule.

export interface NormalizeResult {
  /** Files ESLint rewrote. */
  filesFixed: string[];
  /** Violations still present after fixing (rule ids, deduped). */
  remainingRuleIds: string[];
  /** Set when normalization could not run at all. */
  skippedReason?: string;
}

/**
 * Apply the n8n scanner's own autofixes to a generated node tree, in place.
 *
 * Deliberately non-fatal: if the scanner cannot be loaded, normalization is skipped
 * and the reason is returned. This is NOT a fail-open hole — nothing is approved
 * here. The `official_linter` gate (FR59) still runs afterwards and fails closed,
 * so an un-normalized tree is caught there rather than silently shipped.
 */
export async function normalizeGeneratedNode(nodeDir: string): Promise<NormalizeResult> {
  let buildScanConfig: () => Promise<unknown>;
  let sourceFilePatterns: readonly string[];
  try {
    const mod = (await import('@n8n/scan-community-package/scanner/scanner.mjs' as string)) as {
      buildScanConfig: typeof buildScanConfig;
      SOURCE_FILE_PATTERNS: readonly string[];
    };
    buildScanConfig = mod.buildScanConfig;
    sourceFilePatterns = mod.SOURCE_FILE_PATTERNS;
  } catch (err) {
    return {
      filesFixed: [],
      remainingRuleIds: [],
      skippedReason: `@n8n/scan-community-package unavailable: ${(err as Error).message}`,
    };
  }

  const { ESLint } = (await import('eslint')) as typeof import('eslint');
  const eslint = new ESLint({
    cwd: nodeDir,
    fix: true,
    allowInlineConfig: false,
    overrideConfigFile: true,
    overrideConfig: (await buildScanConfig()) as never,
  });

  // Same file set the reviewers lint (package.json + nodes/ + credentials/).
  const results = await eslint.lintFiles([...sourceFilePatterns]);
  await ESLint.outputFixes(results);

  const filesFixed: string[] = [];
  const remaining = new Set<string>();
  for (const r of results) {
    if (r.output !== undefined) filesFixed.push(path.relative(nodeDir, r.filePath));
    for (const m of r.messages) {
      if (m.ruleId) remaining.add(m.ruleId);
    }
  }
  filesFixed.sort((a, b) => a.localeCompare(b));
  return { filesFixed, remainingRuleIds: [...remaining].sort() };
}

/**
 * n8n writes "ID", never "Id"/"id" (node-param-description-miscased-id).
 *
 * The rule ships an autofixer, but it cannot be relied on: ESLint aborts a file's
 * fix pass with "Circular fixes detected" when two of n8n's own rules disagree, and
 * whatever was not yet applied stays broken — which is exactly how three of these
 * survived --fix. Normalizing here is deterministic and idempotent.
 *
 * `\b` keeps camelCase identifiers safe: in `caseFileId` the "Id" is preceded by a
 * word character, so there is no boundary and it is left alone. Standalone prose
 * ("reuse that id") and backticked field references (`` `id` ``) do match — and the
 * latter is correct, because the n8n form labels that field "ID".
 */
export function normalizeIdCasing(text: string): string {
  return text.replace(/\b[Ii]d\b/g, 'ID');
}

/**
 * n8n requires a boolean parameter's description to start with "Whether" — an
 * autofixer cannot write that sentence, so the wording is derived here from the
 * description the generator supplied. Applied to the spec before rendering.
 */
export function whetherizeBooleanDescription(description: string | undefined): string {
  const text = (description ?? '').trim();
  if (text.length === 0) return 'Whether to enable this option';
  if (/^whether\b/i.test(text)) return text;
  // "Set to true to convert the document" → "Whether to convert the document"
  const stripped = text
    .replace(/^(set to true (to|if) |set true (to|if) |if true, |when true, |enables? |enable )/i, '')
    .trim();
  const body = stripped.length > 0 ? stripped : text;
  const lead = /^to\s/i.test(body) ? body : `to ${body.charAt(0).toLowerCase()}${body.slice(1)}`;
  return `Whether ${lead}`;
}

/** Read a JSON file, apply a transform, write it back only if it changed. */
export async function rewriteJsonIfChanged(
  filePath: string,
  transform: (data: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
  const raw = await fs.readFile(filePath, 'utf8');
  const before = JSON.parse(raw) as Record<string, unknown>;
  const after = transform(structuredClone(before));
  const next = `${JSON.stringify(after, null, 2)}\n`;
  if (next === raw) return false;
  await fs.writeFile(filePath, next, 'utf8');
  return true;
}
