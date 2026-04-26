import { describe, expect, it } from 'vitest';
import { EventEmitter, type MaestroEvent } from '../../../src/core/events/EventEmitter';

function captureEmitter(now: Date = new Date('2026-04-25T08:00:00.000Z')): {
  emitter: EventEmitter;
  events: MaestroEvent[];
} {
  const events: MaestroEvent[] = [];
  const emitter = new EventEmitter({ sink: (event) => events.push(event) }, () => now);
  return { emitter, events };
}

describe('EventEmitter', () => {
  it('emits an event with ISO timestamp, kind, and payload', () => {
    const { emitter, events } = captureEmitter();

    emitter.emit('test.type', { foo: 'bar' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ts: '2026-04-25T08:00:00.000Z',
      type: 'test.type',
      payload: { foo: 'bar' },
    });
  });

  it('attaches context (round, state) to emitted events', () => {
    const { emitter, events } = captureEmitter();
    emitter.setContext({ round: 2, state: 'classifying' });

    emitter.emit('round.started');

    expect(events[0]).toMatchObject({
      type: 'round.started',
      round: 2,
      state: 'classifying',
    });
  });

  it('merges context across multiple setContext calls (immutable updates)', () => {
    const { emitter, events } = captureEmitter();
    emitter.setContext({ round: 1 });
    emitter.setContext({ state: 'fixing' });

    emitter.emit('test');

    expect(events[0].round).toBe(1);
    expect(events[0].state).toBe('fixing');
  });

  it('defaults payload to empty object when omitted', () => {
    const { emitter, events } = captureEmitter();

    emitter.emit('bare');

    expect(events[0].payload).toEqual({});
  });

  it('notifies subscribed handlers in registration order', () => {
    const { emitter } = captureEmitter();
    const order: number[] = [];
    emitter.subscribe(() => order.push(1));
    emitter.subscribe(() => order.push(2));

    emitter.emit('x');

    expect(order).toEqual([1, 2]);
  });

  it('returns an unsubscribe function from subscribe()', () => {
    const { emitter } = captureEmitter();
    const seen: MaestroEvent[] = [];
    const off = emitter.subscribe((e) => seen.push(e));

    emitter.emit('first');
    off();
    emitter.emit('second');

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('first');
  });

  it('returns the emitted event for fluent chaining', () => {
    const { emitter } = captureEmitter();

    const result = emitter.emit('returned', { n: 7 });

    expect(result.type).toBe('returned');
    expect(result.payload).toEqual({ n: 7 });
  });

  it('produces deterministic JSONL when serialized via the default toLine helper', async () => {
    const { toLine } = await import('../../../src/core/events/EventEmitter');
    const event: MaestroEvent = {
      ts: '2026-04-25T08:00:00.000Z',
      type: 'commit.pushed',
      round: 1,
      payload: { sha: 'abc1234' },
    };

    const line = toLine(event);

    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trimEnd()) as MaestroEvent;
    expect(parsed).toEqual(event);
  });
});
