/**
 * JSONL event emitter. Single source of UI truth for the orchestrator.
 *
 * Every state transition, every API write, every classify decision goes
 * through here. Sinks decide where the events land — stdout for the CLI,
 * a file for `--event-stream`, an in-process bus for the Claude Code skill.
 *
 * The emitter never throws on sink failures: a downstream consumer that
 * panics must not take the loop with it.
 */

export interface MaestroEvent {
  /** ISO-8601 timestamp produced by the emitter's clock. */
  ts: string;
  /** Event type, dot-namespaced (e.g. "state.transition", "round.start"). */
  type: string;
  /** Round number when the event fires, if context is set. */
  round?: number;
  /** Current state when the event fires, if context is set. */
  state?: string;
  /** Event-specific payload. */
  payload: Record<string, unknown>;
}

export type EventSink = (event: MaestroEvent) => void;

export type EventHandler = (event: MaestroEvent) => void;

export interface EventEmitterOptions {
  /** Where to write events. Defaults to a no-op sink — set this for production use. */
  sink?: EventSink;
}

interface EventContext {
  round?: number;
  state?: string;
}

const noopSink: EventSink = () => {};

export class EventEmitter {
  private readonly sink: EventSink;
  private readonly clock: () => Date;
  private context: EventContext = {};
  private handlers: EventHandler[] = [];

  constructor(options: EventEmitterOptions = {}, clock: () => Date = () => new Date()) {
    this.sink = options.sink ?? noopSink;
    this.clock = clock;
  }

  setContext(ctx: EventContext): void {
    this.context = { ...this.context, ...ctx };
  }

  getContext(): Readonly<EventContext> {
    return { ...this.context };
  }

  emit(type: string, payload: Record<string, unknown> = {}): MaestroEvent {
    const event: MaestroEvent = {
      ts: this.clock().toISOString(),
      type,
      ...this.context,
      payload,
    };

    try {
      this.sink(event);
    } catch {
      // Sink failures are isolated; the loop must not crash because stdout is closed.
    }

    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Same isolation policy for in-process subscribers.
      }
    }

    return event;
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers = [...this.handlers, handler];
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
}

/** Serialize an event as a single JSONL line (ends with `\n`). */
export function toLine(event: MaestroEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Sink that writes JSONL to a write-stream-like target. */
export function streamSink(stream: { write: (chunk: string) => unknown }): EventSink {
  return (event) => {
    stream.write(toLine(event));
  };
}

/** Sink that writes JSONL to process.stdout. */
export function stdoutSink(): EventSink {
  return streamSink(process.stdout);
}
