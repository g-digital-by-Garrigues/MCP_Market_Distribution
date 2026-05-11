import { describe, expect, it } from 'vitest';
import {
  CANONICAL_EVENTS,
  EVENT_NAME_PATTERN,
  createLogger,
  isCanonicalEventName,
  redact,
} from '../../../src/utils/logger.js';

interface CapturedLine {
  ts: string;
  run_id: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

function captureLogger(runId = 'run-7') {
  const lines: CapturedLine[] = [];
  const logger = createLogger({
    write: (line) => {
      lines.push(JSON.parse(line.replace(/\n$/, '')) as CapturedLine);
    },
    now: () => new Date('2026-05-11T18:00:00.000Z'),
    runId: () => runId,
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('logger.info emits exactly the AC-mandated JSON shape', () => {
    const { logger, lines } = captureLogger();
    logger.info('target.publish_started', { target: 'npm', version: 'v1.0.0' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: '2026-05-11T18:00:00.000Z',
      run_id: 'run-7',
      level: 'info',
      event: 'target.publish_started',
      target: 'npm',
      version: 'v1.0.0',
    });
  });

  it('every log level appears in the level field', () => {
    const { logger, lines } = captureLogger();
    logger.debug('release.completed');
    logger.info('release.completed');
    logger.warn('release.completed');
    logger.error('release.completed');
    expect(lines.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('emits run_id=null when PIPELINE_RUN_ID is not set', () => {
    const lines: CapturedLine[] = [];
    const logger = createLogger({
      write: (line) => {
        lines.push(JSON.parse(line.replace(/\n$/, '')) as CapturedLine);
      },
      now: () => new Date('2026-05-11T18:00:00.000Z'),
      runId: () => undefined,
    });
    logger.info('release.completed');
    expect(lines[0]?.run_id).toBeNull();
  });

  it('emits one JSON object per line (no embedded newlines in the body)', () => {
    const raws: string[] = [];
    const logger = createLogger({
      write: (line) => {
        raws.push(line);
      },
      now: () => new Date('2026-05-11T18:00:00.000Z'),
      runId: () => 'run-7',
    });
    logger.info('release.completed', { message: 'multi\nline\nvalue' });
    expect(raws).toHaveLength(1);
    expect(raws[0]!.endsWith('\n')).toBe(true);
    expect(raws[0]!.match(/\n/g)?.length).toBe(1);
  });
});

describe('redact', () => {
  it('AC example: redact("npm_abc1234567890def") returns "***0def"', () => {
    expect(redact('npm_abc1234567890def')).toBe('***0def');
  });

  it('redact(undefined) returns "***<undefined>" (never throws)', () => {
    expect(redact(undefined)).toBe('***<undefined>');
  });

  it('redact(null) returns "***<null>"', () => {
    expect(redact(null)).toBe('***<null>');
  });

  it('redact(empty string) returns "***<empty>"', () => {
    expect(redact('')).toBe('***<empty>');
  });

  it('redact handles numbers, booleans, and short strings without throwing', () => {
    expect(redact(1234567)).toBe('***4567');
    expect(redact(true)).toBe('***true');
    expect(redact('ab')).toBe('***ab');
  });
});

describe('canonical event names', () => {
  it('every canonical event matches <noun>.<verb> snake_case pattern', () => {
    for (const name of CANONICAL_EVENTS) {
      expect(name, name).toMatch(EVENT_NAME_PATTERN);
    }
  });

  it('isCanonicalEventName returns true for declared events and false otherwise', () => {
    expect(isCanonicalEventName('target.publish_started')).toBe(true);
    expect(isCanonicalEventName('made.up.event')).toBe(false);
    expect(isCanonicalEventName('Target.Publish_Started')).toBe(false);
  });

  it('rejects events not following <noun>.<verb> snake_case via the pattern', () => {
    const invalid = [
      'gate-layer-passed', // hyphen, no dot
      'Target.Publish', // upper-case
      'target.publishStarted', // camelCase
      '_target.start', // leading underscore
      'target.', // empty verb
      '.start', // empty noun
    ];
    for (const candidate of invalid) {
      expect(candidate, candidate).not.toMatch(EVENT_NAME_PATTERN);
    }
  });
});
