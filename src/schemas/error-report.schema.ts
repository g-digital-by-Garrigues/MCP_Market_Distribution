import { z } from 'zod';

// Single canonical error-report contract used by every gate, publisher,
// and helper that emits failures (FR34, NFR-R2). Keep this shape stable;
// downstream consumers (release reporter, slash-command dispatcher) parse
// it directly.
export const errorReportSchema = z
  .object({
    step: z.string().min(1, 'step must be a non-empty identifier (e.g. "gate.layer_1.license").'),
    cause: z.string().min(1, 'cause must describe what went wrong in human terms.'),
    action: z.string().min(1, 'action must be a concrete next step the engineer can take.'),
    level: z.enum(['error', 'warning']).optional().default('error'),
    source_path: z.string().optional(),
  })
  .strict();

export type ErrorReport = z.infer<typeof errorReportSchema>;
