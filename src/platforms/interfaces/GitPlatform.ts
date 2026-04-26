/**
 * Git platform abstraction — orchestrator-grade.
 *
 * Every method here is something the loop or the BotRegistry needs to call.
 * Implementations exist for `github`, `gitlab`, `gitea`, `gitee`.
 *
 * Capability flags let degraded platforms (e.g. older Gitea without thread
 * resolve) signal what's not supported; the orchestrator falls back to
 * sentinel-in-body markers when `threadResolve` is false.
 */

import type { BotReview, ReviewThread } from '../../core/types/Finding';
import type { CIStatus } from '../../core/types/CI';
import type { PullRequest, PullRequestDiff } from '../../core/types/PullRequest';

export type PlatformType = 'github' | 'gitlab' | 'gitea' | 'gitee';

export interface GitPlatformConfig {
  /** Token env var or literal token. Implementations resolve `${ENV}` patterns. */
  token?: string;
  tokenEnv?: string;
  /** API base URL (set for self-hosted instances or GitHub Enterprise). */
  baseUrl?: string;
  /** Repo owner. Auto-detected from `git remote get-url origin` when omitted. */
  owner?: string;
  /** Repo name. Auto-detected. */
  repo?: string;
}

/** What this platform supports — used by the orchestrator to choose strategies. */
export interface PlatformCapabilities {
  /** Can we mark a review thread as resolved via the API? */
  threadResolve: boolean;
  /** Can we reply *inside* a thread (vs. only top-level PR comments)? */
  inlineReplies: boolean;
  /** Does the platform expose review threads as first-class objects? */
  reviewThreads: boolean;
  /** Can we request specific users/teams as reviewers? */
  requestReviewers: boolean;
  /** Does the platform expose CI checks via API? */
  ciStatus: boolean;
  /** Are GraphQL mutations available (faster bulk operations)? */
  graphql: boolean;
}

/** Output of a rate-limit query — used by the orchestrator's backoff. */
export interface RateLimitInfo {
  /** Remaining requests in the current window. */
  remaining: number;
  /** Total budget for the window. */
  limit: number;
  /** When the window resets. */
  resetAt: Date;
  /** GraphQL "cost" left in the window, if applicable. */
  graphqlCost?: number;
}

export abstract class GitPlatform {
  abstract readonly type: PlatformType;
  abstract readonly capabilities: PlatformCapabilities;

  protected readonly config: GitPlatformConfig;

  constructor(config: GitPlatformConfig) {
    this.config = config;
  }

  /** Validate config and create platform-specific clients. Idempotent. */
  abstract initialize(): Promise<void>;

  /** Lightweight connectivity check — does the token work? */
  abstract testConnection(): Promise<boolean>;

  /** Detect owner+repo from `git remote get-url origin` if not in config. */
  abstract detectRepo(): Promise<{ owner: string; repo: string }>;

  // ─── PR I/O ────────────────────────────────────────────────────────────
  abstract getPullRequest(prNumber: number): Promise<PullRequest>;
  abstract getPullRequestDiff(prNumber: number): Promise<PullRequestDiff>;
  abstract updatePullRequestBody(prNumber: number, body: string): Promise<void>;
  abstract requestReviewers(prNumber: number, reviewers: string[]): Promise<void>;
  /** Post a top-level PR issue comment (used to trigger bots via @mention). */
  abstract createPRComment(prNumber: number, body: string): Promise<void>;

  // ─── Reviews & threads (orchestrator core) ────────────────────────────
  /**
   * List bot reviews on a PR. Optional `since` filters by submission timestamp.
   * Implementations should hydrate `threads[]` for each review.
   */
  abstract listReviews(prNumber: number, since?: Date): Promise<BotReview[]>;

  /** Fetch a single review by its platform-native ID. */
  abstract getReview(reviewId: string): Promise<BotReview>;

  /** All review threads on the PR (across all reviews). */
  abstract listReviewThreads(prNumber: number): Promise<ReviewThread[]>;

  /**
   * Post a reply *inside* the given review thread. The reply attribution is
   * the orchestrator's user token — never a bot's identity.
   */
  abstract replyInThread(threadId: string, body: string): Promise<void>;

  /**
   * Mark a thread as resolved. On platforms where this is unsupported
   * (`capabilities.threadResolve === false`), implementations may write a
   * sentinel marker into the thread instead and consider the thread closed.
   */
  abstract resolveReviewThread(threadId: string): Promise<void>;

  // ─── CI ────────────────────────────────────────────────────────────────
  abstract getCIStatus(headSha: string): Promise<CIStatus>;

  // ─── Rate limits ───────────────────────────────────────────────────────
  abstract getRateLimitInfo(): Promise<RateLimitInfo>;
}
