/**
 * LoopOrchestrator — wires together M2+M3+M4 into the convergence loop.
 *
 * Drives a StateMachine through each round:
 *   waiting_for_ci → waiting_for_bot → racing → classifying → fixing
 *   → commit_pushed → replying → resolving → waiting_for_ci (repeat)
 *
 * All side effects (platform calls, fix execution, commits) are injectable
 * for testing. The default onFix / onCommit are no-ops (M5 placeholder;
 * real AI code-fixing lands in M6).
 */

import { StateMachine } from '../state/StateMachine';
import type { LoopState } from '../state/StateMachine';
import { RoundBudget } from '../round/RoundBudget';
import { CommitThrottle } from '../round/CommitThrottle';
import type { RoundCommit } from '../round/CommitThrottle';
import { EventEmitter } from '../events/EventEmitter';
import { ConvergenceMonitor } from '../convergence/ConvergenceMonitor';
import { computeFindingHash } from '../convergence/ConvergenceMonitor';
import { Classifier } from '../classify/Classifier';
import { Dedup } from '../dedup/Dedup';
import { SecretScanner } from '../security/SecretScanner';
import type { GitPlatform } from '../../platforms/interfaces/GitPlatform';
import type { Finding, ReviewThread, Severity } from '../types/Finding';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FixResult {
  findingHash: string;
  description: string;
  files?: string[];
}

export interface LoopRunOptions {
  prNumber: number;
  /** Hard cap on rounds. Default: 3 (matches ConvergenceMonitor default). */
  maxRounds?: number;
  /** Only accept findings from these bot logins. Empty = accept all bots. */
  botFilter?: string[];
}

export interface LoopResult {
  finalState: LoopState;
  rounds: number;
  reason: 'approved' | 'converged' | 'max_rounds' | 'stopped' | 'error';
  error?: Error;
}

export interface LoopOrchestratorOptions {
  platform: GitPlatform;
  emitter?: EventEmitter;
  classifier?: Classifier;
  dedup?: Dedup;
  convergence?: ConvergenceMonitor;
  secretScanner?: SecretScanner;
  /** Hook to fix actionable findings. Return [] to skip (M5 placeholder). */
  onFix?: (findings: Finding[], round: number) => Promise<FixResult[]>;
  /** Hook to push a commit after fixing. Return commit SHA or ''. */
  onCommit?: (commit: RoundCommit) => Promise<string>;
  /** Milliseconds between CI status polls. Default 10_000. */
  ciPollIntervalMs?: number;
  /** Milliseconds between bot review polls. Default 30_000. */
  botPollIntervalMs?: number;
  /** Max milliseconds to wait for bot reviews before declaring timeout. Default 300_000. */
  botTimeoutMs?: number;
  /** Sleep implementation — swap out in tests for immediate resolution. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Map of bot login → comment text to post in order to trigger that bot.
   * Used for bots like Codex that respond to @mention comments rather than
   * the standard GitHub requestReviewers API.
   * Example: { 'chatgpt-codex-connector': '@codex review' }
   */
  botTriggerComments?: Record<string, string>;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CI_POLL_MS = 10_000;
const DEFAULT_BOT_POLL_MS = 30_000;
const DEFAULT_BOT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ROUNDS = 3;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── LoopOrchestrator ─────────────────────────────────────────────────────────

export class LoopOrchestrator {
  private readonly platform: GitPlatform;
  private readonly emitter?: EventEmitter;
  private readonly classifier: Classifier;
  private readonly dedup: Dedup;
  private readonly convergence: ConvergenceMonitor;
  private readonly secretScanner: SecretScanner;
  private readonly onFix: (findings: Finding[], round: number) => Promise<FixResult[]>;
  private readonly onCommit: (commit: RoundCommit) => Promise<string>;
  private readonly ciPollIntervalMs: number;
  private readonly botPollIntervalMs: number;
  private readonly botTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly botTriggerComments: Record<string, string>;

  constructor(opts: LoopOrchestratorOptions) {
    this.platform = opts.platform;
    this.emitter = opts.emitter;
    this.classifier = opts.classifier ?? new Classifier();
    this.dedup = opts.dedup ?? new Dedup();
    this.convergence = opts.convergence ?? new ConvergenceMonitor();
    this.secretScanner = opts.secretScanner ?? new SecretScanner();
    this.onFix = opts.onFix ?? (async () => []);
    this.onCommit = opts.onCommit ?? (async () => '');
    this.ciPollIntervalMs = opts.ciPollIntervalMs ?? DEFAULT_CI_POLL_MS;
    this.botPollIntervalMs = opts.botPollIntervalMs ?? DEFAULT_BOT_POLL_MS;
    this.botTimeoutMs = opts.botTimeoutMs ?? DEFAULT_BOT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.botTriggerComments = opts.botTriggerComments ?? {};
  }

  async run(options: LoopRunOptions): Promise<LoopResult> {
    const { prNumber, maxRounds = DEFAULT_MAX_ROUNDS, botFilter = [] } = options;

    const sm = new StateMachine({ initialState: 'waiting_for_ci', emitter: this.emitter });
    const budget = new RoundBudget(1);
    let round = 0;

    try {
      // ── Initial CI wait ────────────────────────────────────────────────
      const pr = await this.platform.getPullRequest(prNumber);
      const headSha = pr.headSha;

      const ciPassed = await this.waitForCI(headSha, sm);
      if (!ciPassed) {
        sm.transition('ci_failing');
        sm.transition('stopped', { reason: 'ci_failing' });
        return { finalState: 'stopped', rounds: 0, reason: 'stopped' };
      }

      // ── Main convergence loop ──────────────────────────────────────────
      for (;;) {
        round++;

        if (round > maxRounds) {
          sm.transition('stopped', { reason: 'max_rounds', round });
          return { finalState: 'stopped', rounds: maxRounds, reason: 'max_rounds' };
        }

        this.emitter?.emit('round.start', { round, prNumber });

        // ── Wait for bots ────────────────────────────────────────────────
        sm.transition('waiting_for_bot', { round });
        const reviews = await this.waitForBotReviews(prNumber, botFilter);

        if (!reviews) {
          sm.transition('bot_timeout', { round });
          // Re-request review from bots that haven't responded, then retry once
          await this.reRequestBotReviews(prNumber, botFilter, []);
          const retried = await this.waitForBotReviews(prNumber, botFilter);
          if (!retried) {
            sm.transition('stopped', { reason: 'bot_timeout' });
            return { finalState: 'stopped', rounds: round, reason: 'stopped' };
          }
          sm.transition('racing', { round });
        } else {
          sm.transition('racing', { round });
        }

        // ── Classify ─────────────────────────────────────────────────────
        sm.transition('classifying', { round });

        const threads = await this.platform.listReviewThreads(prNumber);
        const findings = this.threadsToFindings(threads, round, botFilter);

        // ── Check for approval ───────────────────────────────────────────
        // Only stop when approved AND there are no open bot threads left to resolve.
        // If threads are still open, continue the loop to classify and resolve them
        // even if a reviewer has already approved.
        const currentReviews = reviews ?? [];
        const approved = currentReviews.some((r) => r.state === 'approved' || r.state === 'satisfied');
        if (approved && findings.length === 0) {
          sm.transition('stopped', { reason: 'approved', round });
          return { finalState: 'stopped', rounds: round, reason: 'approved' };
        }

        const classified = await Promise.all(
          findings.map(async (f) => {
            const cls = await budget.classify(f.hash, () => this.classifier.classify(f));
            return { ...f, classification: cls };
          }),
        );

        const dedupResult = await this.dedup.deduplicate(classified);

        // Compute convergence on critical + high severity actionable findings
        const criticalHashes = new Set(
          dedupResult.unique
            .filter(
              (f) =>
                f.classification?.category === 'bug' &&
                (f.severity === 'critical' || f.severity === 'high'),
            )
            .map((f) => f.hash),
        );

        const convergenceResult = this.convergence.recordRound(round, criticalHashes);

        this.emitter?.emit('round.classified', {
          round,
          total: findings.length,
          unique: dedupResult.unique.length,
          criticals: criticalHashes.size,
          duplicates: dedupResult.tierStats.exact + dedupResult.tierStats.fuzzy + dedupResult.tierStats.llm,
          convergence: convergenceResult.status,
        });

        const terminatingStatus = convergenceResult.status === 'oscillating' ||
          convergenceResult.status === 'non_monotone' ||
          convergenceResult.status === 'category_violation';
        if (terminatingStatus) {
          sm.transition('stopped', { reason: 'converged', round, convergence: convergenceResult.status });
          return { finalState: 'stopped', rounds: round, reason: 'converged' };
        }

        // ── Fix ──────────────────────────────────────────────────────────
        sm.transition('fixing', { round });

        const actionable = dedupResult.unique.filter((f) => f.classification?.category === 'bug');
        const fixes = actionable.length > 0 ? await this.onFix(actionable, round) : [];

        // ── Commit ───────────────────────────────────────────────────────
        sm.transition('commit_pushed', { round });

        if (fixes.length > 0) {
          const throttle = new CommitThrottle(round);
          for (const fix of fixes) {
            throttle.add({ findingHash: fix.findingHash, description: fix.description, files: fix.files });
          }
          const roundCommit = throttle.flush();
          budget.recordCommit();
          await this.onCommit(roundCommit);
          this.emitter?.emit('round.committed', { round, fixCount: fixes.length, message: roundCommit.message });
        }

        // ── Reply in threads ─────────────────────────────────────────────
        if (this.platform.capabilities.inlineReplies) {
          sm.transition('replying', { round });

          for (const finding of dedupResult.unique) {
            if (!finding.threadId) continue;
            const reply = this.buildReplyBody(finding, fixes);
            if (!reply) continue;
            const sanitized = this.secretScanner.scan(reply).redacted;
            await this.platform.replyInThread(finding.threadId, sanitized);
            budget.recordReply(finding.threadId);
            this.emitter?.emit('thread.replied', { threadId: finding.threadId, category: finding.classification?.category });
          }
        } else {
          sm.transition('replying', { round });
        }

        // ── Resolve threads ───────────────────────────────────────────────
        // Every finding that received a reply is also resolved — we always
        // reply first (有求必應) and then close the thread on behalf of the author.
        sm.transition('resolving', { round });

        if (this.platform.capabilities.threadResolve) {
          for (const finding of dedupResult.unique) {
            if (!finding.threadId) continue;
            await this.platform.resolveReviewThread(finding.threadId);
            this.emitter?.emit('thread.resolved', { threadId: finding.threadId });
          }
        }

        // ── Re-request review from bots that haven't approved ────────────
        // Fetch fresh reviews to check current thread state after resolving.
        // If any threads are still open, skip re-request to avoid noise.
        const freshReviews = await this.platform.listReviews(prNumber);
        const hasOpenThreads = freshReviews.some((r) =>
          (r.threads ?? []).some((t) => !t.isResolved),
        );
        if (!hasOpenThreads) {
          await this.reRequestBotReviews(prNumber, botFilter, freshReviews);
        } else {
          this.emitter?.emit('rerequest.skipped', {
            prNumber,
            reason: 'open_threads',
          });
        }

        // ── Next round ───────────────────────────────────────────────────
        budget.nextRound();

        const updatedPr = await this.platform.getPullRequest(prNumber);
        sm.transition('waiting_for_ci', { round: round + 1 });
        const nextCiPassed = await this.waitForCI(updatedPr.headSha, sm);
        if (!nextCiPassed) {
          sm.transition('ci_failing', { round: round + 1 });
          sm.transition('stopped', { reason: 'ci_failing' });
          return { finalState: 'stopped', rounds: round, reason: 'stopped' };
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitter?.emit('loop.error', { error: error.message, round });
      try {
        sm.transition('stopped', { reason: 'error', error: error.message });
      } catch {
        // ignore transition error if already in stopped
      }
      return { finalState: 'stopped', rounds: round, reason: 'error', error };
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async waitForCI(headSha: string, sm: StateMachine): Promise<boolean> {
    const deadline = Date.now() + 30 * 60_000; // 30-min CI timeout

    for (;;) {
      const ci = await this.platform.getCIStatus(headSha);

      if (ci.state === 'success') return true;
      if (ci.state === 'failure' || ci.state === 'error') return false;

      if (Date.now() > deadline) return false;

      this.emitter?.emit('ci.polling', { headSha, pending: ci.pendingCount, failing: ci.failingCount });
      await this.sleep(this.ciPollIntervalMs);
    }
  }

  /**
   * Re-request review from bots that have reviewed but not approved, or from
   * all watched bots when none have reviewed yet (bot_timeout path).
   *
   * @param existingReviews - reviews already received this round (empty = timeout path)
   */
  private async reRequestBotReviews(
    prNumber: number,
    botFilter: string[],
    existingReviews: import('../types/Finding').BotReview[],
  ): Promise<void> {
    if (!this.platform.capabilities.requestReviewers) return;

    let botsToRequest: string[];

    if (existingReviews.length === 0) {
      // Timeout path: no reviews at all — re-request from explicitly watched bots
      botsToRequest = [...new Set(botFilter)];
    } else {
      // Post-round path: re-request from bots that reviewed but didn't approve or satisfy
      botsToRequest = [
        ...new Set(
          existingReviews
            .filter((r) => r.state !== 'approved' && r.state !== 'satisfied')
            .map((r) => r.bot.login),
        ),
      ];
    }

    if (botsToRequest.length === 0) return;

    // Bots with trigger comments (e.g. Codex): post @mention comment.
    // GitHub API returns logins with "[bot]" suffix; config keys may omit it.
    // Resolve the trigger text by trying the full login then the stripped form.
    const getTrigger = (login: string): string | undefined =>
      this.botTriggerComments[login] ??
      this.botTriggerComments[login.replace(/\[bot\]$/, '')];

    const commentBots = botsToRequest.filter((b) => getTrigger(b));
    const apiBots = botsToRequest.filter((b) => !getTrigger(b));

    for (const bot of commentBots) {
      try {
        await this.platform.createPRComment(prNumber, getTrigger(bot)!);
        this.emitter?.emit('reviewers.requested', { bots: [bot], prNumber, via: 'comment' });
      } catch {
        // Non-fatal
      }
    }

    if (apiBots.length > 0 && this.platform.capabilities.requestReviewers) {
      try {
        await this.platform.requestReviewers(prNumber, apiBots);
        this.emitter?.emit('reviewers.requested', { bots: apiBots, prNumber, via: 'api' });
      } catch {
        // Non-fatal
      }
    }
  }

  private async waitForBotReviews(
    prNumber: number,
    botFilter: string[],
  ): Promise<NonNullable<Awaited<ReturnType<GitPlatform['listReviews']>>> | null> {
    const deadline = Date.now() + this.botTimeoutMs;

    for (;;) {
      const reviews = await this.platform.listReviews(prNumber);
      const botReviews = reviews.filter((r) => {
        if (!r.bot.isBot) return false;
        if (botFilter.length > 0 && !botFilter.includes(r.bot.login)) return false;
        return true;
      });

      if (botReviews.length > 0) return botReviews;
      if (Date.now() > deadline) return null;

      this.emitter?.emit('bots.polling', { prNumber });
      await this.sleep(this.botPollIntervalMs);
    }
  }

  threadsToFindings(threads: ReviewThread[], round: number, botFilter: string[]): Finding[] {
    const findings: Finding[] = [];

    for (const thread of threads) {
      if (thread.isResolved) continue;
      if (thread.comments.length === 0) continue;

      const firstComment = thread.comments[0];
      if (!firstComment) continue;
      if (firstComment.isOurs) continue;
      if (!firstComment.author.isBot) continue;

      if (botFilter.length > 0 && !botFilter.includes(firstComment.author.login)) continue;

      const body = firstComment.body;
      const file = thread.location?.file ?? '';
      const startLine = thread.location?.startLine;
      const hash = computeFindingHash(file, startLine, 'unknown', body);

      findings.push({
        hash,
        bot: firstComment.author,
        firstSeenRound: round,
        lastSeenRound: round,
        location: thread.location ?? { file: '' },
        severity: extractSeverity(body),
        title: extractTitle(body),
        body,
        threadId: thread.id,
      });
    }

    return findings;
  }

  private buildReplyBody(finding: Finding, fixes: FixResult[]): string | null {
    const category = finding.classification?.category;
    if (!category || category === 'unknown' || category === 'duplicate') return null;

    switch (category) {
      case 'bug': {
        const fix = fixes.find((f) => f.findingHash === finding.hash);
        if (fix) return `已在本輪修復：${fix.description}`;
        return null;
      }
      case 'wrong': {
        const reasoning = finding.classification?.reasoning;
        return reasoning
          ? `感謝指出，但評估後認為此問題不適用於目前實作：${reasoning}`
          : '感謝指出，但評估後認為此問題不適用於目前實作。';
      }
      case 'taste':
        return '已記錄，這屬於風格偏好，將遵循團隊慣例處理。';
      case 'yagni':
        return '問題有效，但超出本次 PR 範圍，已記錄為後續追蹤項目。';
      default:
        return null;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSeverity(body: string): Severity {
  const lower = body.toLowerCase();
  if (lower.includes('critical') || lower.includes('blocker')) return 'critical';
  if (lower.includes('high') || lower.includes('error') || lower.includes('bug')) return 'high';
  if (lower.includes('warning') || lower.includes('warn')) return 'medium';
  if (lower.includes('info') || lower.includes('note') || lower.includes('suggestion')) return 'info';
  return 'medium';
}

function extractTitle(body: string): string {
  const firstLine = body.split('\n')[0] ?? body;
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}
