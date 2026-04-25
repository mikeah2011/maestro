import { describe, expect, it } from 'vitest';
import { EventEmitter, type MaestroEvent } from '../../../src/core/events/EventEmitter';
import {
  StateMachine,
  StateTransitionError,
  type LoopState,
} from '../../../src/core/state/StateMachine';

function captureEmitter(): { emitter: EventEmitter; events: MaestroEvent[] } {
  const events: MaestroEvent[] = [];
  const emitter = new EventEmitter({ sink: (e) => events.push(e) }, () => new Date('2026-04-25T08:00:00.000Z'));
  return { emitter, events };
}

describe('StateMachine — initial state', () => {
  it('starts in idle by default', () => {
    expect(new StateMachine().state).toBe('idle');
  });

  it('respects an injected initial state', () => {
    expect(new StateMachine({ initialState: 'waiting_for_bot' }).state).toBe('waiting_for_bot');
  });
});

describe('StateMachine — happy-path forward transitions', () => {
  it('walks the canonical write-to-merge-ready path', () => {
    const sm = new StateMachine();

    const path: LoopState[] = [
      'writing',
      'preflight',
      'pr_created',
      'waiting_for_ci',
      'waiting_for_bot',
      'racing',
      'classifying',
      'fixing',
      'commit_pushed',
      'replying',
      'resolving',
      'waiting_for_bot',
      'stopped',
    ];

    for (const target of path) {
      sm.transition(target);
      expect(sm.state).toBe(target);
    }
  });

  it('allows commit_pushed → waiting_for_ci to re-enter the CI gate', () => {
    const sm = new StateMachine({ initialState: 'commit_pushed' });
    sm.transition('waiting_for_ci');
    expect(sm.state).toBe('waiting_for_ci');
  });
});

describe('StateMachine — illegal transitions', () => {
  it('rejects illegal forward jumps', () => {
    const sm = new StateMachine();
    expect(() => sm.transition('classifying')).toThrow(StateTransitionError);
  });

  it('rejects transitions out of stopped (terminal)', () => {
    const sm = new StateMachine({ initialState: 'stopped' });
    expect(() => sm.transition('writing')).toThrow(StateTransitionError);
  });

  it('encodes from/to on the error', () => {
    const sm = new StateMachine();
    try {
      sm.transition('classifying');
      expect.fail('expected throw');
    } catch (err) {
      const e = err as StateTransitionError;
      expect(e.from).toBe('idle');
      expect(e.to).toBe('classifying');
    }
  });
});

describe('StateMachine — cross-cutting transitions', () => {
  it('allows any non-terminal state to escalate to human_intervened', () => {
    for (const start of ['writing', 'classifying', 'fixing', 'replying'] as const) {
      const sm = new StateMachine({ initialState: start });
      expect(() => sm.transition('human_intervened')).not.toThrow();
      expect(sm.state).toBe('human_intervened');
    }
  });

  it('allows any non-terminal state to escalate to token_expired', () => {
    const sm = new StateMachine({ initialState: 'racing' });
    sm.transition('token_expired');
    expect(sm.state).toBe('token_expired');
  });

  it('allows any non-terminal state to drop to rate_limited', () => {
    const sm = new StateMachine({ initialState: 'waiting_for_bot' });
    sm.transition('rate_limited');
    expect(sm.state).toBe('rate_limited');
  });

  it('allows any non-terminal state to stop', () => {
    const sm = new StateMachine({ initialState: 'classifying' });
    sm.transition('stopped');
    expect(sm.state).toBe('stopped');
  });

  it('does NOT allow terminal stopped to escalate further', () => {
    const sm = new StateMachine({ initialState: 'stopped' });
    expect(() => sm.transition('human_intervened')).toThrow(StateTransitionError);
  });
});

describe('StateMachine — error-state recovery', () => {
  it('ci_failing → fixing recovers the loop', () => {
    const sm = new StateMachine({ initialState: 'ci_failing' });
    sm.transition('fixing');
    expect(sm.state).toBe('fixing');
  });

  it('bot_timeout → waiting_for_bot retries the wait', () => {
    const sm = new StateMachine({ initialState: 'bot_timeout' });
    sm.transition('waiting_for_bot');
    expect(sm.state).toBe('waiting_for_bot');
  });

  it('human_intervened → paused → waiting_for_bot resumes', () => {
    const sm = new StateMachine({ initialState: 'human_intervened' });
    sm.transition('paused');
    sm.transition('waiting_for_bot');
    expect(sm.state).toBe('waiting_for_bot');
  });
});

describe('StateMachine — event emission', () => {
  it('emits state.transition events with from/to and any extra payload', () => {
    const { emitter, events } = captureEmitter();
    const sm = new StateMachine({ emitter });

    sm.transition('writing', { reason: 'user invoked maestro write' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'state.transition',
      payload: {
        from: 'idle',
        to: 'writing',
        reason: 'user invoked maestro write',
      },
    });
  });

  it('updates emitter context so subsequent events tag the new state', () => {
    const { emitter, events } = captureEmitter();
    const sm = new StateMachine({ emitter });

    sm.transition('writing');
    emitter.emit('arbitrary.event');

    const arbitrary = events.find((e) => e.kind === 'arbitrary.event');
    expect(arbitrary?.state).toBe('writing');
  });
});

describe('StateMachine — canTransition', () => {
  it('returns true for legal transitions and false for illegal ones', () => {
    const sm = new StateMachine();
    expect(sm.canTransition('writing')).toBe(true);
    expect(sm.canTransition('classifying')).toBe(false);
    expect(sm.canTransition('stopped')).toBe(true); // cross-cutting
  });
});
