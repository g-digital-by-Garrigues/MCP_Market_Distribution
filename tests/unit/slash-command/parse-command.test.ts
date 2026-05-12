import { describe, expect, it } from 'vitest';
import {
  formatUsageMessage,
  parseCommand,
  type RetryCommand,
} from '../../../src/slash-command/parse-command.js';

describe('parseCommand — valid grammars', () => {
  it('returns the no-flags command on "/retry-publish"', () => {
    expect(parseCommand('/retry-publish')).toEqual<RetryCommand>({
      command: 'retry-publish',
      step: null,
      track: null,
      bump: null,
    });
  });

  it('parses step= against the canonical target list', () => {
    expect(parseCommand('/retry-publish?step=cline')).toEqual<RetryCommand>({
      command: 'retry-publish',
      step: 'cline',
      track: null,
      bump: null,
    });
    expect(parseCommand('/retry-publish?step=npm')?.step).toBe('npm');
    expect(parseCommand('/retry-publish?step=docker-hub')?.step).toBe('docker-hub');
    expect(parseCommand('/retry-publish?step=mcp-publisher')?.step).toBe('mcp-publisher');
    expect(parseCommand('/retry-publish?step=docker-mcp-catalog')?.step).toBe('docker-mcp-catalog');
    expect(parseCommand('/retry-publish?step=n8n')?.step).toBe('n8n');
    expect(parseCommand('/retry-publish?step=make-rom')?.step).toBe('make-rom');
  });

  it('parses track=a / track=b', () => {
    expect(parseCommand('/retry-publish?track=a')?.track).toBe('a');
    expect(parseCommand('/retry-publish?track=b')?.track).toBe('b');
  });

  it('parses track=a&bump=patch / minor / major', () => {
    expect(parseCommand('/retry-publish?track=a&bump=patch')).toEqual<RetryCommand>({
      command: 'retry-publish',
      step: null,
      track: 'a',
      bump: 'patch',
    });
    expect(parseCommand('/retry-publish?track=b&bump=minor')?.bump).toBe('minor');
    expect(parseCommand('/retry-publish?track=a&bump=major')?.bump).toBe('major');
  });

  it('accepts comment-body shape with leading whitespace, ignores blank lines before', () => {
    expect(parseCommand('\n\n  /retry-publish?step=cline  ')?.step).toBe('cline');
  });
});

describe('parseCommand — null returns for invalid input', () => {
  it.each([
    ['missing slash prefix', 'retry-publish'],
    ['typo in command name', '/retry-publis'],
    ['unknown step ID', '/retry-publish?step=fakestore'],
    ['empty step value', '/retry-publish?step='],
    ['empty query string after ?', '/retry-publish?'],
    ['unknown flag', '/retry-publish?foo=bar'],
    ['trailing garbage after command', '/retry-publish please'],
    ['step + track combined (mutually exclusive)', '/retry-publish?step=cline&track=a'],
    ['bump without track', '/retry-publish?bump=patch'],
    ['invalid track value', '/retry-publish?track=c'],
    ['invalid bump value', '/retry-publish?track=a&bump=megabump'],
    ['duplicate key', '/retry-publish?step=cline&step=npm'],
    ['pair without =', '/retry-publish?step'],
    ['empty comment', ''],
    ['command on second line, not first non-blank', 'thanks for the report\n/retry-publish?step=cline'],
  ])('returns null: %s', (_label, input) => {
    expect(parseCommand(input)).toBeNull();
  });
});

describe('formatUsageMessage', () => {
  it('returns a non-empty markdown string mentioning the canonical commands', () => {
    const msg = formatUsageMessage();
    expect(msg).toContain('/retry-publish');
    expect(msg).toContain('step=cline');
    expect(msg).toContain('track=a');
    expect(msg).toContain('bump=');
  });
});
