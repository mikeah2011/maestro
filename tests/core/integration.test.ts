/**
 * M2 integration smoke — proves the 4 loop primitives cooperate per the
 * DESIGN.md anti-spam invariants:
 *   - One commit per round (RoundBudget × CommitThrottle)
 *   - State transitions emit events (StateMachine × EventEmitter)
 *   - Per-round counters reset on round boundary
 */

import { describe, expect, it } from 'vitest';
import {
  CommitThrottle,
  EventEmitter,
  type MaestroEvent,
  RoundBudget,
  RoundBudgetViolation,
  StateMachine,
} from '../../src/index';

describe('M2 primitives — round lifecycle integration', () => {
  it('drives a full round through the 4 primitives without violation', () => {
    const events: MaestroEvent[] = [];
    const emitter = new EventEmitter({ sink: (e) => events.push(e) });
    const sm = new StateMachine({ emitter });
    const budget = new RoundBudget();
    let throttle = new CommitThrottle(budget.round);

    // Walk: idle → writing → preflight → pr_created → waiting_for_ci → waiting_for_bot
    sm.transition('writing');
    sm.transition('preflight');
    sm.transition('pr_created');
    sm.transition('waiting_for_ci');
    sm.transition('waiting_for_bot');
    sm.transition('racing');
    sm.transition('classifying');

    // Round bookkeeping during classify+fix
    const f1 = budget.classify('hash-1', () => 'bug');
    const f2 = budget.classify('hash-2', () => 'bug');
    expect(f1).toBe('bug');
    expect(f2).toBe('bug');

    sm.transition('fixing');
    throttle.add({ findingHash: 'hash-1', description: 'fix off-by-one' });
    throttle.add({ findingHash: 'hash-2', description: 'add null check' });

    const commit = throttle.flush();
    budget.recordCommit();
    sm.transition('commit_pushed');

    expect(commit.fixes).toHaveLength(2);
    expect(commit.message).toContain('round 1');
    expect(budget.snapshot().commits).toBe(1);
    expect(events.find((e) => e.kind === 'state.transition' && e.payload.to === 'commit_pushed')).toBeDefined();
  });

  it('blocks a second commit attempt within the same round', () => {
    const budget = new RoundBudget();
    budget.recordCommit();
    expect(() => budget.recordCommit()).toThrow(RoundBudgetViolation);
  });

  it('allows the next round after rolling counters', () => {
    const budget = new RoundBudget();
    budget.recordCommit();
    budget.recordPrBodyUpdate();
    budget.recordReply('thread-A');

    budget.nextRound();

    expect(budget.round).toBe(2);
    expect(() => budget.recordCommit()).not.toThrow();
    expect(() => budget.recordPrBodyUpdate()).not.toThrow();
    expect(() => budget.recordReply('thread-A')).not.toThrow();
  });

  it('emits events tagged with the current state', () => {
    const events: MaestroEvent[] = [];
    const emitter = new EventEmitter({ sink: (e) => events.push(e) });
    const sm = new StateMachine({ emitter });

    sm.transition('writing');
    emitter.emit('audit.log', { note: 'mid-write' });
    sm.transition('preflight');
    emitter.emit('audit.log', { note: 'mid-preflight' });

    const audits = events.filter((e) => e.kind === 'audit.log');
    expect(audits).toHaveLength(2);
    expect(audits[0].state).toBe('writing');
    expect(audits[1].state).toBe('preflight');
  });
});
