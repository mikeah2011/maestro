/**
 * The orchestrator's state machine. Transitions are explicit and validated;
 * cross-cutting transitions (escalation to human, rate-limit, token expiry,
 * stop) are allowed from any non-terminal state.
 *
 * Every accepted transition emits a `state.transition` event and rewrites
 * the emitter's context so downstream events carry the new state.
 */

import type { EventEmitter } from '../events/EventEmitter';

export type LoopState =
  | 'idle'
  | 'writing'
  | 'preflight'
  | 'pr_created'
  | 'waiting_for_ci'
  | 'waiting_for_bot'
  | 'racing'
  | 'classifying'
  | 'fixing'
  | 'commit_pushed'
  | 'replying'
  | 'resolving'
  | 'stopped'
  // Error / cross-cutting states.
  | 'ci_failing'
  | 'bot_timeout'
  | 'human_intervened'
  | 'rate_limited'
  | 'token_expired'
  | 'paused';

/** Forward transitions that the linear loop walks through. */
const FORWARD: Readonly<Record<LoopState, ReadonlyArray<LoopState>>> = {
  idle: ['writing'],
  writing: ['preflight'],
  preflight: ['pr_created'],
  pr_created: ['waiting_for_ci'],
  waiting_for_ci: ['waiting_for_bot', 'ci_failing'],
  waiting_for_bot: ['racing', 'bot_timeout'],
  racing: ['classifying'],
  classifying: ['fixing'],
  fixing: ['commit_pushed'],
  commit_pushed: ['waiting_for_ci', 'replying'],
  replying: ['resolving'],
  resolving: ['waiting_for_bot'],
  stopped: [],
  // Error states have a constrained recovery set.
  ci_failing: ['fixing'],
  bot_timeout: ['waiting_for_bot'],
  human_intervened: ['paused'],
  rate_limited: ['waiting_for_bot', 'waiting_for_ci'],
  token_expired: [],
  paused: ['waiting_for_bot', 'waiting_for_ci'],
};

/** Targets reachable from any non-terminal state. */
const CROSS_CUTTING: ReadonlySet<LoopState> = new Set<LoopState>([
  'human_intervened',
  'rate_limited',
  'token_expired',
  'stopped',
]);

/** States with no outgoing transitions. */
const TERMINAL: ReadonlySet<LoopState> = new Set<LoopState>(['stopped', 'token_expired']);

export class StateTransitionError extends Error {
  constructor(public readonly from: LoopState, public readonly to: LoopState) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'StateTransitionError';
  }
}

export interface StateMachineOptions {
  initialState?: LoopState;
  emitter?: EventEmitter;
}

export class StateMachine {
  private _state: LoopState;
  private readonly emitter?: EventEmitter;

  constructor(options: StateMachineOptions = {}) {
    this._state = options.initialState ?? 'idle';
    this.emitter = options.emitter;
    this.emitter?.setContext({ state: this._state });
  }

  get state(): LoopState {
    return this._state;
  }

  canTransition(to: LoopState): boolean {
    if (TERMINAL.has(this._state)) {
      return false;
    }
    if (CROSS_CUTTING.has(to)) {
      return true;
    }
    return (FORWARD[this._state] ?? []).includes(to);
  }

  transition(to: LoopState, payload: Record<string, unknown> = {}): void {
    if (!this.canTransition(to)) {
      throw new StateTransitionError(this._state, to);
    }
    const from = this._state;
    this._state = to;
    this.emitter?.setContext({ state: to });
    this.emitter?.emit('state.transition', { from, to, ...payload });
  }
}
