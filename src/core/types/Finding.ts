/**
 * Core types for the orchestrator's view of bot review findings.
 *
 * A `Finding` is a single issue raised by one bot in one review round.
 * The Classifier turns raw bot comments into `Finding` records, the
 * Dedup module collapses duplicates across bots, the ConvergenceMonitor
 * tracks finding sets across rounds, the ThreadManager replies in the
 * thread that originated the finding.
 */

/** Severity ladder, normalized across all bots. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Classification of a finding's actionability. */
export type FindingCategory =
  | 'bug' // real bug; fix this round
  | 'yagni' // legitimate concern but out of scope; defer
  | 'wrong' // bot is wrong; push back with reasoning
  | 'taste' // bikeshedding / style preference; ignore
  | 'duplicate' // already reported in this round; collapse
  | 'unknown'; // classifier could not decide deterministically

/** A pointer to where in the codebase the finding lives. */
export interface FindingLocation {
  file: string;
  /** 1-based start line (inclusive). */
  startLine?: number;
  /** 1-based end line (inclusive). Same as startLine when single line. */
  endLine?: number;
  /** Hash of the surrounding 10-line content; stable under line shifts. */
  contentHash?: string;
}

/** Identity of the bot that surfaced this finding. */
export interface BotIdentity {
  /** Login as it appears in the platform (e.g. "coderabbitai"). */
  login: string;
  /** Display name when distinct from login. */
  displayName?: string;
  /** Whether the platform classifies this account as a bot/app. */
  isBot: boolean;
  /** Provider tag from the BotRegistry. */
  registryKey?: string;
}

/** A single finding from a bot, before/after classification. */
export interface Finding {
  /** Stable hash: sha1(file + line_bucket + normalized_category + content_hash). */
  hash: string;
  /** Originating bot. */
  bot: BotIdentity;
  /** Round number this finding was first observed in. */
  firstSeenRound: number;
  /** Round number of the latest observation. */
  lastSeenRound: number;
  /** Where in the code the finding points. */
  location: FindingLocation;
  /** Bot-assigned severity, if any. */
  rawSeverity?: string;
  /** Severity normalized to our ladder. */
  severity: Severity;
  /** Short, human-readable title. */
  title: string;
  /** Full body text from the bot, sanitized of suggestion-block markers. */
  body: string;
  /** Classification result and metadata. */
  classification?: FindingClassification;
  /** Platform-native review-thread ID for replying / resolving. */
  threadId?: string;
  /** Platform-native review ID for traceability. */
  reviewId?: string;
  /** Original platform comment ID. */
  commentId?: string;
}

/** Output of the Classifier for a single finding. */
export interface FindingClassification {
  category: FindingCategory;
  confidence: number; // 0..1
  /** Whether the deterministic fence short-circuited the LLM. */
  viaFence: boolean;
  /** Which fence rule fired, if viaFence is true. */
  fenceRule?: string;
  /** LLM model used, if not via fence. */
  model?: string;
  /** Reasoning surfaced to the audit log. */
  reasoning?: string;
}

/** A bot review (one bot's pass over the PR), as the orchestrator sees it. */
export interface BotReview {
  /** Platform-native review ID (e.g. GitHub PRR_*). */
  id: string;
  /** Bot that submitted the review. */
  bot: BotIdentity;
  /** When the review was submitted. */
  submittedAt: Date;
  /** Top-level review state from the platform. */
  state: 'commented' | 'changes_requested' | 'approved' | 'dismissed' | 'satisfied';
  /** Top-level summary body, if any. */
  body?: string;
  /** Threads that belong to this review. */
  threads: ReviewThread[];
}

/** A review thread (a comment + its inline replies + resolved status). */
export interface ReviewThread {
  /** Platform-native thread ID. On GitHub: PRRT_*. */
  id: string;
  /** ID of the review this thread originated from, if known. */
  reviewId?: string;
  /** Whether the thread is marked resolved. */
  isResolved: boolean;
  /** Path / line where the thread is anchored, if inline. */
  location?: FindingLocation;
  /** All comments in the thread, oldest first. */
  comments: ThreadComment[];
}

/** A single comment within a review thread. */
export interface ThreadComment {
  id: string;
  author: BotIdentity;
  body: string;
  createdAt: Date;
  updatedAt?: Date;
  /** True if this comment is from the orchestrator (us). */
  isOurs: boolean;
}
