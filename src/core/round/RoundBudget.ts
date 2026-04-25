/**
 * Anti-spam runtime invariants. Per round, the orchestrator may:
 *   - push at most one commit
 *   - reply at most once per review thread
 *   - update the PR body at most once
 *   - classify each finding at most once (memoized)
 *   - request reviewers at most once
 *
 * Violations crash the process. There is no warn-and-continue mode by
 * design — tools that warn-and-continue accumulate spam over time.
 */

export type RoundBudgetInvariant =
  | 'commits_per_round'
  | 'replies_per_thread'
  | 'pr_body_updates'
  | 'reviewer_requests';

export class RoundBudgetViolation extends Error {
  constructor(
    public readonly invariant: RoundBudgetInvariant,
    public readonly round: number,
    message: string,
  ) {
    super(message);
    this.name = 'RoundBudgetViolation';
  }
}

export interface RoundBudgetSnapshot {
  round: number;
  commits: number;
  threadsReplied: number;
  prBodyUpdates: number;
  findingsClassified: number;
  reviewerRequests: number;
}

export class RoundBudget {
  private _round: number;
  private commits = 0;
  private repliesPerThread = new Map<string, number>();
  private prBodyUpdates = 0;
  private classifyCache = new Map<string, unknown>();
  private reviewerRequests = 0;

  constructor(initialRound: number = 1) {
    if (!Number.isInteger(initialRound) || initialRound < 1) {
      throw new Error(`RoundBudget: initialRound must be a positive integer, got ${initialRound}`);
    }
    this._round = initialRound;
  }

  get round(): number {
    return this._round;
  }

  recordCommit(): void {
    if (this.commits >= 1) {
      throw new RoundBudgetViolation(
        'commits_per_round',
        this._round,
        `Round ${this._round}: only one commit per round is permitted`,
      );
    }
    this.commits++;
  }

  recordReply(threadId: string): void {
    const count = this.repliesPerThread.get(threadId) ?? 0;
    if (count >= 1) {
      throw new RoundBudgetViolation(
        'replies_per_thread',
        this._round,
        `Round ${this._round}, thread ${threadId}: only one reply per thread per round is permitted`,
      );
    }
    this.repliesPerThread.set(threadId, count + 1);
  }

  recordPrBodyUpdate(): void {
    if (this.prBodyUpdates >= 1) {
      throw new RoundBudgetViolation(
        'pr_body_updates',
        this._round,
        `Round ${this._round}: only one PR body update per round is permitted`,
      );
    }
    this.prBodyUpdates++;
  }

  classify<T>(findingHash: string, compute: () => T): T {
    if (this.classifyCache.has(findingHash)) {
      return this.classifyCache.get(findingHash) as T;
    }
    const result = compute();
    this.classifyCache.set(findingHash, result);
    return result;
  }

  recordReviewerRequest(): void {
    if (this.reviewerRequests >= 1) {
      throw new RoundBudgetViolation(
        'reviewer_requests',
        this._round,
        `Round ${this._round}: only one reviewer request per round is permitted`,
      );
    }
    this.reviewerRequests++;
  }

  nextRound(): void {
    this._round++;
    this.commits = 0;
    this.repliesPerThread = new Map();
    this.prBodyUpdates = 0;
    this.classifyCache = new Map();
    this.reviewerRequests = 0;
  }

  snapshot(): RoundBudgetSnapshot {
    return {
      round: this._round,
      commits: this.commits,
      threadsReplied: this.repliesPerThread.size,
      prBodyUpdates: this.prBodyUpdates,
      findingsClassified: this.classifyCache.size,
      reviewerRequests: this.reviewerRequests,
    };
  }
}
