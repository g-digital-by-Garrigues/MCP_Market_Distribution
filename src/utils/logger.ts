import process from 'node:process';

// Structured JSON logger — one event per line, JSON-shaped, so every publisher
// run is parseable post-hoc by the release reporter (FR41) and by anyone
// tailing the workflow logs. Correlates events across the run via the
// pipeline_run_id env var the workflow's setup job exports.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Canonical event names the pipeline emits. The shape is <noun>.<verb_phrase>
// in snake_case so logs can be grouped by noun (gate / target / release / etc.).
// Adding a new event is a deliberate vocabulary change — bump this list when
// you do, and the corresponding test will keep the pattern enforcement honest.
export const CANONICAL_EVENTS = [
  // Gate stack (Stories 2.2 / 2.4 / 2.5)
  'gate.layer_1_passed',
  'gate.layer_1_failed',
  'gate.layer_2_passed',
  'gate.layer_2_failed',
  'gate.layer_3_passed',
  'gate.layer_3_failed',
  // Target publishers (Epic 3)
  'target.publish_started',
  'target.publish_succeeded',
  'target.publish_failed',
  'target.publish_skipped',
  // Track B (Epic 5)
  'adapter.n8n_node_generated',
  'adapter.make_rom_generated',
  // Release lifecycle (Epic 4)
  'release.report_committed',
  'release.completed',
  'release.failed',
  // Slash-command dispatcher (Story 4.10)
  'slash_command.received',
  'slash_command.dispatched',
  'slash_command.rejected',
] as const;

export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isCanonicalEventName(name: string): name is CanonicalEvent {
  return (CANONICAL_EVENTS as readonly string[]).includes(name);
}

export interface LogPayload {
  [key: string]: unknown;
}

export interface LoggerOptions {
  /** Override the writer (defaults to process.stdout.write). */
  write?: (line: string) => void;
  /** Override the clock (defaults to Date.now). */
  now?: () => Date;
  /** Override the run-id source (defaults to process.env.PIPELINE_RUN_ID). */
  runId?: () => string | undefined;
}

interface InternalLogger {
  debug: (event: string, payload?: LogPayload) => void;
  info: (event: string, payload?: LogPayload) => void;
  warn: (event: string, payload?: LogPayload) => void;
  error: (event: string, payload?: LogPayload) => void;
}

export function createLogger(options: LoggerOptions = {}): InternalLogger {
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  const now = options.now ?? (() => new Date());
  const runIdSource = options.runId ?? (() => process.env.PIPELINE_RUN_ID);

  function emit(level: LogLevel, event: string, payload: LogPayload = {}): void {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      run_id: runIdSource() ?? null,
      level,
      event,
      ...payload,
    };
    write(JSON.stringify(record) + '\n');
  }

  return {
    debug: (event, payload) => emit('debug', event, payload),
    info: (event, payload) => emit('info', event, payload),
    warn: (event, payload) => emit('warn', event, payload),
    error: (event, payload) => emit('error', event, payload),
  };
}

export const logger = createLogger();

// `redact("npm_abc1234567890def")` -> `"***0def"`.
// `redact(undefined)` -> `"***<undefined>"`, never throws (NFR-S5).
export function redact(value: unknown): string {
  if (value === undefined) return '***<undefined>';
  if (value === null) return '***<null>';
  let s: string;
  try {
    s = typeof value === 'string' ? value : String(value);
  } catch {
    return '***<unstringifiable>';
  }
  if (s.length === 0) return '***<empty>';
  const tail = s.slice(-4);
  return `***${tail}`;
}
