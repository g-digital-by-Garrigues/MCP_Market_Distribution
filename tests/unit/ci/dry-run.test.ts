import { describe, expect, it, vi } from 'vitest';
import {
  DRY_RUN_STATUS_HEADER,
  dryRunEnabled,
  dryRunFromEnv,
  parseDryRunFlag,
  runUnlessDryRun,
} from '../../../src/ci/dry-run.js';

describe('parseDryRunFlag', () => {
  it.each([
    ['true', true],
    ['True', true],
    ['TRUE', true],
    [' true ', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['', false],
    ['nonsense', false],
  ])('parseDryRunFlag(%p) === %p', (input, expected) => {
    expect(parseDryRunFlag(input)).toBe(expected);
  });

  it('returns false for undefined and null (no throw)', () => {
    expect(parseDryRunFlag(undefined)).toBe(false);
    expect(parseDryRunFlag(null)).toBe(false);
  });
});

describe('dryRunEnabled', () => {
  it('input takes precedence over env when both are present', () => {
    expect(dryRunEnabled({ input: 'false', env: 'true' })).toBe(false);
    expect(dryRunEnabled({ input: 'true', env: 'false' })).toBe(true);
  });

  it('falls back to env when input is empty/undefined', () => {
    expect(dryRunEnabled({ input: '', env: 'true' })).toBe(true);
    expect(dryRunEnabled({ env: 'true' })).toBe(true);
    expect(dryRunEnabled({ input: undefined, env: 'false' })).toBe(false);
  });

  it('defaults to false when neither source provides a value', () => {
    expect(dryRunEnabled({})).toBe(false);
    expect(dryRunEnabled()).toBe(false);
  });
});

describe('dryRunFromEnv', () => {
  it('reads DRY_RUN from the provided env object', () => {
    expect(dryRunFromEnv({ DRY_RUN: 'true' })).toBe(true);
    expect(dryRunFromEnv({ DRY_RUN: 'false' })).toBe(false);
    expect(dryRunFromEnv({})).toBe(false);
  });
});

describe('runUnlessDryRun', () => {
  it('invokes fn and returns its value when dry-run is OFF', async () => {
    const fn = vi.fn(async () => 'real-result');
    const result = await runUnlessDryRun(fn, 'placeholder', {
      callSite: 'npm.publish',
      source: { input: 'false' },
    });
    expect(result).toBe('real-result');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns the placeholder and skips fn when dry-run is ON', async () => {
    const fn = vi.fn(async () => 'should-not-run');
    const onSkip = vi.fn();
    const result = await runUnlessDryRun(fn, 'placeholder-url', {
      callSite: 'npm.publish',
      source: { input: 'true' },
      onSkip,
    });
    expect(result).toBe('placeholder-url');
    expect(fn).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({ call_site: 'npm.publish', reason: 'dry_run' });
  });

  it('does not throw when onSkip is omitted', async () => {
    await expect(
      runUnlessDryRun(async () => 'x', 'p', {
        callSite: 'docker.push',
        source: { input: 'true' },
      }),
    ).resolves.toBe('p');
  });
});

describe('DRY_RUN_STATUS_HEADER', () => {
  it('exports the AC-mandated header string', () => {
    expect(DRY_RUN_STATUS_HEADER).toBe('**Status: DRY RUN**');
  });
});
