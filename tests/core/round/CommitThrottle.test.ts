import { describe, expect, it } from 'vitest';
import { CommitThrottle, CommitThrottleError } from '../../../src/core/round/CommitThrottle';

describe('CommitThrottle — accumulation', () => {
  it('starts empty with the configured round number', () => {
    const throttle = new CommitThrottle(2);
    expect(throttle.pendingCount).toBe(0);
    expect(throttle.round).toBe(2);
  });

  it('accumulates pending fixes', () => {
    const throttle = new CommitThrottle(1);
    throttle.add({ findingHash: 'aaaaaaaa1234', description: 'fix null deref' });
    throttle.add({ findingHash: 'bbbbbbbb5678', description: 'add missing index' });

    expect(throttle.pendingCount).toBe(2);
  });
});

describe('CommitThrottle — flush', () => {
  it('produces a structured conventional-commit message', () => {
    const throttle = new CommitThrottle(2);
    throttle.add({ findingHash: 'aaaaaaaa1234', description: 'fix null deref in auth.ts' });
    throttle.add({ findingHash: 'bbbbbbbb5678', description: 'add missing index on users.email' });

    const result = throttle.flush();

    expect(result.round).toBe(2);
    expect(result.fixes).toHaveLength(2);
    expect(result.message).toContain('round 2');
    expect(result.message.split('\n')[0]).toMatch(/^fix:/);
    expect(result.message).toContain('aaaaaaaa');
    expect(result.message).toContain('fix null deref in auth.ts');
    expect(result.message).toContain('bbbbbbbb');
  });

  it('produces a header-only message when no fixes were added', () => {
    const throttle = new CommitThrottle(1);
    const result = throttle.flush();
    expect(result.fixes).toHaveLength(0);
    expect(result.message).toBe('fix: address review feedback (round 1)');
  });

  it('throws when flushed twice', () => {
    const throttle = new CommitThrottle(1);
    throttle.flush();

    expect(() => throttle.flush()).toThrow(CommitThrottleError);
  });

  it('throws when adding after flush', () => {
    const throttle = new CommitThrottle(1);
    throttle.flush();

    expect(() =>
      throttle.add({ findingHash: 'cafe', description: 'too late' }),
    ).toThrow(CommitThrottleError);
  });

  it('exposes flushed state for callers', () => {
    const throttle = new CommitThrottle(1);
    expect(throttle.isFlushed).toBe(false);
    throttle.flush();
    expect(throttle.isFlushed).toBe(true);
  });
});

describe('CommitThrottle — message format', () => {
  it('truncates the hash prefix to 8 characters in the bullet list', () => {
    const throttle = new CommitThrottle(1);
    throttle.add({ findingHash: 'abcdef0123456789', description: 'something' });
    const result = throttle.flush();

    const bullet = result.message.split('\n').find((l) => l.startsWith('-'));
    expect(bullet).toBe('- abcdef01: something');
  });

  it('lists fixes in insertion order', () => {
    const throttle = new CommitThrottle(1);
    throttle.add({ findingHash: '11111111aa', description: 'first' });
    throttle.add({ findingHash: '22222222bb', description: 'second' });
    throttle.add({ findingHash: '33333333cc', description: 'third' });

    const result = throttle.flush();
    const bullets = result.message.split('\n').filter((l) => l.startsWith('-'));

    expect(bullets).toEqual([
      '- 11111111: first',
      '- 22222222: second',
      '- 33333333: third',
    ]);
  });
});
