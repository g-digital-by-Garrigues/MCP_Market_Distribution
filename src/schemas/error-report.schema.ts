import { z } from 'zod';

// Single canonical error-report contract used by every gate, publisher,
// and helper that emits failures (FR34, NFR-R2). The shape lets the
// release reporter (FR41) and the slash-command dispatcher (FR38) parse
// failures from any source uniformly:
//
//   stage       — which phase of the pipeline emitted this (gate, publish, report, tag).
//   layer       — for gates only: 1=static, 2=protocol, 3=build (null elsewhere).
//   target      — for publishers only: the marketplace target name (null elsewhere).
//   check       — short identifier of the specific check that failed
//                 (e.g. "source_folder", "tools_call_probe", "smithery_deploy_verify").
//   observation — facts observed: what the gate or publisher actually saw.
//   cause       — interpretation of those facts: why we believe the run failed.
//   action      — concrete next step the engineer can take to fix and re-run.
//   source_path — optional path (relative to the pending-to-publish folder)
//                 that points at the offending file when applicable.
//   level       — "error" by default; "warning" for non-blocking notes.
export const errorReportSchema = z
  .object({
    stage: z.enum(['gate', 'publish', 'report', 'tag']),
    layer: z.number().int().positive().nullable(),
    target: z.string().min(1).nullable(),
    check: z.string().min(1, 'check must be a non-empty identifier.'),
    observation: z.string().min(1, 'observation must describe what was seen in concrete terms.'),
    cause: z.string().min(1, 'cause must interpret the observation.'),
    action: z.string().min(1, 'action must be a concrete next step the engineer can take.'),
    source_path: z.string().optional(),
    // Omitted = 'error'. Consumers treat undefined as the error level so
    // call sites don't have to repeat the default everywhere.
    level: z.enum(['error', 'warning']).optional(),
  })
  .strict();

export type ErrorReport = z.infer<typeof errorReportSchema>;
