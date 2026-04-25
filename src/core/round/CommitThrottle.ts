/**
 * Buffer of pending fixes for the current round. The orchestrator collects
 * fixes as they're produced (one per finding being addressed) and flushes
 * them as a single conventional commit at the end of the Fixing state.
 *
 * The throttle does not push the commit itself — that's the platform's job.
 * It exists to enforce the "one commit per round" invariant by construction:
 * once flushed, the throttle is dead and a fresh one must be created for
 * the next round.
 */

export interface PendingFix {
  /** Stable hash of the finding being addressed. */
  findingHash: string;
  /** One-line description for the commit body bullet. */
  description: string;
  /** Files touched while addressing this finding (optional, for richer messages). */
  files?: ReadonlyArray<string>;
}

export interface RoundCommit {
  /** The round this commit belongs to. */
  round: number;
  /** All fixes flushed in this commit, in insertion order. */
  fixes: ReadonlyArray<PendingFix>;
  /** The conventional-commit message ready to pass to git. */
  message: string;
}

export class CommitThrottleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitThrottleError';
  }
}

const HASH_PREFIX_LENGTH = 8;

export class CommitThrottle {
  private readonly _round: number;
  private pending: PendingFix[] = [];
  private _flushed = false;

  constructor(round: number) {
    if (!Number.isInteger(round) || round < 1) {
      throw new CommitThrottleError(
        `CommitThrottle: round must be a positive integer, got ${round}`,
      );
    }
    this._round = round;
  }

  get round(): number {
    return this._round;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get isFlushed(): boolean {
    return this._flushed;
  }

  add(fix: PendingFix): void {
    if (this._flushed) {
      throw new CommitThrottleError(
        `CommitThrottle: round ${this._round} already flushed; cannot add new fixes`,
      );
    }
    this.pending = [...this.pending, fix];
  }

  flush(): RoundCommit {
    if (this._flushed) {
      throw new CommitThrottleError(
        `CommitThrottle: round ${this._round} already flushed`,
      );
    }
    this._flushed = true;
    const fixes = this.pending;

    return {
      round: this._round,
      fixes,
      message: formatMessage(this._round, fixes),
    };
  }
}

function formatMessage(round: number, fixes: ReadonlyArray<PendingFix>): string {
  const header = `fix: address review feedback (round ${round})`;
  if (fixes.length === 0) {
    return header;
  }

  const body = fixes
    .map((fix) => `- ${fix.findingHash.slice(0, HASH_PREFIX_LENGTH)}: ${fix.description}`)
    .join('\n');

  return `${header}\n\n${body}`;
}
