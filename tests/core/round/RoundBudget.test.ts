import { describe, expect, it } from 'vitest';
import {
  RoundBudget,
  RoundBudgetViolation,
} from '../../../src/core/round/RoundBudget';

describe('RoundBudget — commit invariant', () => {
  it('allows exactly one commit per round', () => {
    const budget = new RoundBudget();
    expect(() => budget.recordCommit()).not.toThrow();
  });

  it('throws RoundBudgetViolation on a second commit in the same round', () => {
    const budget = new RoundBudget();
    budget.recordCommit();

    try {
      budget.recordCommit();
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RoundBudgetViolation);
      const violation = err as RoundBudgetViolation;
      expect(violation.invariant).toBe('commits_per_round');
      expect(violation.round).toBe(1);
    }
  });

  it('allows another commit after nextRound()', () => {
    const budget = new RoundBudget();
    budget.recordCommit();
    budget.nextRound();
    expect(() => budget.recordCommit()).not.toThrow();
  });
});

describe('RoundBudget — reply-per-thread invariant', () => {
  it('allows one reply per thread per round', () => {
    const budget = new RoundBudget();
    expect(() => budget.recordReply('thread-A')).not.toThrow();
    expect(() => budget.recordReply('thread-B')).not.toThrow();
  });

  it('throws on a second reply to the same thread in the same round', () => {
    const budget = new RoundBudget();
    budget.recordReply('thread-A');

    try {
      budget.recordReply('thread-A');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RoundBudgetViolation);
      expect((err as RoundBudgetViolation).invariant).toBe('replies_per_thread');
      expect((err as RoundBudgetViolation).message).toContain('thread-A');
    }
  });

  it('resets per-thread state on nextRound()', () => {
    const budget = new RoundBudget();
    budget.recordReply('thread-A');
    budget.nextRound();
    expect(() => budget.recordReply('thread-A')).not.toThrow();
  });
});

describe('RoundBudget — PR body update invariant', () => {
  it('allows exactly one PR body update per round', () => {
    const budget = new RoundBudget();
    expect(() => budget.recordPrBodyUpdate()).not.toThrow();
  });

  it('throws on a second PR body update', () => {
    const budget = new RoundBudget();
    budget.recordPrBodyUpdate();
    expect(() => budget.recordPrBodyUpdate()).toThrow(RoundBudgetViolation);
  });
});

describe('RoundBudget — classify memoization', () => {
  it('runs compute() only once per finding hash', () => {
    const budget = new RoundBudget();
    let calls = 0;
    const compute = (): string => {
      calls++;
      return 'classified';
    };

    expect(budget.classify('hash-1', compute)).toBe('classified');
    expect(budget.classify('hash-1', compute)).toBe('classified');
    expect(budget.classify('hash-1', compute)).toBe('classified');
    expect(calls).toBe(1);
  });

  it('runs compute() per distinct finding hash', () => {
    const budget = new RoundBudget();
    let calls = 0;
    budget.classify('hash-1', () => ++calls);
    budget.classify('hash-2', () => ++calls);
    expect(calls).toBe(2);
  });

  it('forgets memoized classifications after nextRound()', () => {
    const budget = new RoundBudget();
    let calls = 0;
    budget.classify('hash-1', () => ++calls);
    budget.nextRound();
    budget.classify('hash-1', () => ++calls);
    expect(calls).toBe(2);
  });
});

describe('RoundBudget — reviewer request invariant', () => {
  it('allows exactly one reviewer request per round', () => {
    const budget = new RoundBudget();
    expect(() => budget.recordReviewerRequest()).not.toThrow();
    expect(() => budget.recordReviewerRequest()).toThrow(RoundBudgetViolation);
  });
});

describe('RoundBudget — round counter and snapshot', () => {
  it('starts at round 1 by default', () => {
    expect(new RoundBudget().round).toBe(1);
  });

  it('respects an injected initial round', () => {
    expect(new RoundBudget(3).round).toBe(3);
  });

  it('increments round on nextRound()', () => {
    const budget = new RoundBudget();
    budget.nextRound();
    budget.nextRound();
    expect(budget.round).toBe(3);
  });

  it('snapshot() reports counters faithfully', () => {
    const budget = new RoundBudget();
    budget.recordCommit();
    budget.recordReply('thread-A');
    budget.recordReply('thread-B');
    budget.recordPrBodyUpdate();
    budget.classify('h1', () => null);
    budget.classify('h2', () => null);

    expect(budget.snapshot()).toEqual({
      round: 1,
      commits: 1,
      threadsReplied: 2,
      prBodyUpdates: 1,
      findingsClassified: 2,
      reviewerRequests: 0,
    });
  });
});
