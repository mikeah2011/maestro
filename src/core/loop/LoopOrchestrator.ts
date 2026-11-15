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
import type { Finding, FindingClassification, ReviewThread, Severity } from '../types/Finding';
import type { PullRequest, PullRequestDiff } from '../types/PullRequest';

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
  /** Classify and report findings only — skip fix, commit, reply, resolve, and re-request. */
  dryRun?: boolean;
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
  /**
   * Optional interactive decision hook — called after classification each round.
   * Return a map of findingHash → action. Omitted hashes fall back to the
   * AI-recommended default: bug→fix, wrong→reject, others→defer.
   * Not called in dry-run mode.
   */
  onDecide?: (
    findings: Array<Finding & { classification: FindingClassification }>,
    round: number,
  ) => Promise<Map<string, 'fix' | 'defer' | 'reject'>>;
  /** Milliseconds between CI status polls. Default 10_000. */
  ciPollIntervalMs?: number;
  /** Milliseconds between bot review polls. Default 30_000. */
  botPollIntervalMs?: number;
  /** Max milliseconds to wait for bot reviews before declaring timeout. Default 300_000. */
  botTimeoutMs?: number;
  /** Milliseconds to wait between rounds to give bots time to re-review. Default 300_000 (5 min). */
  roundIntervalMs?: number;
  /** Sleep implementation — swap out in tests for immediate resolution. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called when the PR is approved with no open findings.
   * Receives the current PR and its diff; return the new body string to update,
   * or null/undefined to skip the update.
   */
  onPRApproved?: (pr: PullRequest, diff: PullRequestDiff) => Promise<string | null>;
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
const DEFAULT_ROUND_INTERVAL_MS = 300_000; // 5 min — give bots time to re-review
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
  private readonly roundIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly botTriggerComments: Record<string, string>;
  private readonly onDecide?: (
    findings: Array<Finding & { classification: FindingClassification }>,
    round: number,
  ) => Promise<Map<string, 'fix' | 'defer' | 'reject'>>;
  private readonly onPRApproved?: (pr: PullRequest, diff: PullRequestDiff) => Promise<string | null>;

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
    this.roundIntervalMs = opts.roundIntervalMs ?? DEFAULT_ROUND_INTERVAL_MS;
    this.sleep = opts.sleep ?? defaultSleep;
    this.botTriggerComments = opts.botTriggerComments ?? {};
    this.onDecide = opts.onDecide;
    this.onPRApproved = opts.onPRApproved;
  }

  async run(options: LoopRunOptions): Promise<LoopResult> {
    const { prNumber, maxRounds = DEFAULT_MAX_ROUNDS, botFilter = [], dryRun = false } = options;

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

      // ── Pre-populate saturated bots from existing PR comments ─────────
      // Bots that have already posted terminal messages (usage limits, etc.)
      // should not be re-requested even in the first round.
      const requestedBots = new Set<string>();
      try {
        const prComments = await this.platform.listPRComments(prNumber);
        const TERMINAL_PATTERNS = [
          /reached your codex usage limits/i,
          /usage limit/i,
          /quota exceeded/i,
        ];
        for (const c of prComments) {
          if (c.isBot && TERMINAL_PATTERNS.some((p) => p.test(c.body))) {
            requestedBots.add(c.login);
          }
        }
      } catch { /* non-fatal — proceed without pre-population */ }

      // Pre-populate bots already satisfied/approved from prior runs or existing reviews.
      const approvedBots = new Set<string>();
      try {
        const existingReviews = await this.platform.listReviews(prNumber);
        for (const r of existingReviews) {
          if (r.bot.isBot && (r.state === 'satisfied' || r.state === 'approved')) {
            approvedBots.add(r.bot.login);
          }
        }
      } catch { /* non-fatal */ }

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
        let finalReviews = await this.waitForBotReviews(prNumber, botFilter);

        if (!finalReviews) {
          sm.transition('bot_timeout', { round });
          await this.reRequestBotReviews(prNumber, botFilter, []);
          finalReviews = await this.waitForBotReviews(prNumber, botFilter);
          if (!finalReviews) {
            sm.transition('stopped', { reason: 'bot_timeout' });
            return { finalState: 'stopped', rounds: round, reason: 'stopped' };
          }
        }
        sm.transition('racing', { round });

        // Track permanently satisfied/approved bots; emit status for visibility
        for (const r of finalReviews) {
          if (r.bot.isBot && (r.state === 'satisfied' || r.state === 'approved')) {
            if (!approvedBots.has(r.bot.login)) {
              approvedBots.add(r.bot.login);
              this.emitter?.emit('bot.satisfied', { bot: r.bot.login, round, state: r.state });
            }
          }
        }
        this.emitter?.emit('round.bot_status', {
          round,
          bots: finalReviews.map((r) => ({
            login: r.bot.login,
            state: r.state,
            satisfied: approvedBots.has(r.bot.login),
          })),
        });

        // ── Classify ─────────────────────────────────────────────────────
        sm.transition('classifying', { round });

        const threads = await this.platform.listReviewThreads(prNumber);
        const findings = this.threadsToFindings(threads, round, botFilter);

        // ── Check for approval ───────────────────────────────────────────
        // Only stop when approved AND there are no open bot threads left to resolve.
        // If threads are still open, continue the loop to classify and resolve them
        // even if a reviewer has already approved.
        const approved = finalReviews.some((r) => r.state === 'approved' || r.state === 'satisfied');
        if (approved && findings.length === 0) {
          // Update PR body when approved — give AI a chance to write a proper description.
          if (!dryRun && this.onPRApproved) {
            try {
              const diff = await this.platform.getPullRequestDiff(prNumber);
              const newBody = await this.onPRApproved(pr, diff);
              if (newBody) {
                await this.platform.updatePullRequestBody(prNumber, newBody);
                this.emitter?.emit('pr.body_updated', { prNumber, length: newBody.length });
              }
            } catch { /* non-fatal — approval takes precedence */ }
          }
          sm.transition('stopped', { reason: 'approved', round });
          return { finalState: 'stopped', rounds: round, reason: 'approved' };
        }

        const classified = await Promise.all(
          findings.map(async (f) => {
            const cls = await budget.classify(f.hash, () => this.classifier.classify(f));
            this.emitter?.emit('classify.result', {
              round,
              category: cls.category,
              severity: f.severity,
              confidence: cls.confidence,
              file: f.location.file ?? 'unknown',
              line: f.location.startLine,
            });
            return { ...f, classification: cls };
          }),
        );

        // Build per-finding decisions: default from classification, then let caller override.
        const decisions = new Map<string, 'fix' | 'defer' | 'reject'>();
        for (const f of classified) {
          const cat = f.classification?.category;
          // unknown = cannot classify → attempt to fix; taste/yagni = defer; wrong = reject
          const defaultAction: 'fix' | 'defer' | 'reject' =
            cat === 'taste' || cat === 'yagni'
              ? 'defer'
              : cat === 'wrong'
                ? 'reject'
                : 'fix'; // bug + unknown both get fix by default
          decisions.set(f.hash, defaultAction);
        }
        if (!dryRun && this.onDecide && classified.length > 0) {
          try {
            const userDecisions = await this.onDecide(
              classified as Array<Finding & { classification: FindingClassification }>,
              round,
            );
            for (const [hash, action] of userDecisions) decisions.set(hash, action);
          } catch { /* non-fatal — fall back to defaults */ }
        }
        this.emitter?.emit('round.decisions', {
          round,
          total: classified.length,
          fix: [...decisions.values()].filter((d) => d === 'fix').length,
          defer: [...decisions.values()].filter((d) => d === 'defer').length,
          reject: [...decisions.values()].filter((d) => d === 'reject').length,
        });

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

        const actionable = dedupResult.unique.filter((f) => decisions.get(f.hash) === 'fix');

        if (!dryRun && actionable.length === 0) {
          const categories = dedupResult.unique.reduce<Record<string, number>>((acc, f) => {
            const cat = f.classification?.category ?? 'unknown';
            acc[cat] = (acc[cat] ?? 0) + 1;
            return acc;
          }, {});
          this.emitter?.emit('fix.skipped', {
            round,
            reason: 'no_fix_decisions',
            categories,
            deferred: dedupResult.unique.filter((f) => decisions.get(f.hash) === 'defer').length,
          });
        }

        const fixes = !dryRun && actionable.length > 0 ? await this.onFix(actionable, round) : [];

        for (const fix of fixes) {
          this.emitter?.emit('fix.applied', { round, description: fix.description, files: fix.files });
        }

        // ── Commit ───────────────────────────────────────────────────────
        sm.transition('commit_pushed', { round });

        let commitSha = '';
        if (!dryRun && fixes.length > 0) {
          const throttle = new CommitThrottle(round);
          for (const fix of fixes) {
            throttle.add({ findingHash: fix.findingHash, description: fix.description, files: fix.files });
          }
          const roundCommit = throttle.flush();
          budget.recordCommit();
          commitSha = await this.onCommit(roundCommit);
          this.emitter?.emit('round.committed', { round, fixCount: fixes.length, message: roundCommit.message });
        }

        // ── Reply in threads ─────────────────────────────────────────────
        sm.transition('replying', { round });

        let repliedCount = 0;
        if (!dryRun && this.platform.capabilities.inlineReplies) {
          for (const finding of dedupResult.unique) {
            if (!finding.threadId) continue;
            const decision = decisions.get(finding.hash) ?? 'defer';
            const reply = this.buildReplyBody(finding, fixes, decision, commitSha);
            if (!reply) continue;
            const sanitized = this.secretScanner.scan(reply).redacted;
            await this.platform.replyInThread(finding.threadId, sanitized);
            repliedCount++;
            budget.recordReply(finding.threadId);
            this.emitter?.emit('thread.replied', { threadId: finding.threadId, category: finding.classification?.category });
            // React to the bot's original comment to show acknowledgement
            if (this.platform.capabilities.emojiReactions && finding.commentId) {
              try {
                const reaction = decision === 'fix' ? 'ROCKET' : 'EYES';
                await this.platform.reactToReviewComment(finding.commentId, reaction);
              } catch { /* non-fatal */ }
            }
          }

          // Reply to deduplicated findings — point them to the canonical thread
          for (const [dupHash, canonicalHash] of dedupResult.duplicates) {
            const dupFinding = classified.find((f) => f.hash === dupHash);
            if (!dupFinding?.threadId) continue;
            const canonical = dedupResult.unique.find((f) => f.hash === canonicalHash);
            const canonicalTitle = canonical?.title ? canonical.title.slice(0, 80) : '';
            const dupReply = canonicalTitle
              ? `已確認，此問題與「${canonicalTitle}」相同，已在對應討論串統一處理。`
              : '已確認，此問題已在同批次其他討論串中統一處理。';
            const sanitizedDup = this.secretScanner.scan(dupReply).redacted;
            try {
              await this.platform.replyInThread(dupFinding.threadId, sanitizedDup);
              repliedCount++;
              budget.recordReply(dupFinding.threadId);
              this.emitter?.emit('thread.replied', { threadId: dupFinding.threadId, category: 'duplicate' });
              if (this.platform.capabilities.emojiReactions && dupFinding.commentId) {
                await this.platform.reactToReviewComment(dupFinding.commentId, 'EYES').catch(() => {});
              }
            } catch { /* non-fatal */ }
          }
        }

        // ── Resolve threads ───────────────────────────────────────────────
        sm.transition('resolving', { round });

        if (!dryRun && this.platform.capabilities.threadResolve) {
          for (const finding of dedupResult.unique) {
            if (!finding.threadId) continue;
            await this.platform.resolveReviewThread(finding.threadId);
            this.emitter?.emit('thread.resolved', { threadId: finding.threadId });
          }
        }

        // ── Re-request review — only once per bot per loop run ──────────
        // Condition: replied to at least one thread AND all threads resolved AND bot not yet requested this run
        if (!dryRun && repliedCount > 0) {
          const freshReviews = await this.platform.listReviews(prNumber);
          const hasOpenThreads = freshReviews.some((r) =>
            (r.threads ?? []).some((t) => !t.isResolved),
          );
          if (!hasOpenThreads) {
            // Filter to bots not yet re-requested this loop run
            const eligibleReviews = freshReviews.filter(
              (r) =>
                r.state !== 'approved' &&
                r.state !== 'satisfied' &&
                !requestedBots.has(r.bot.login) &&
                !approvedBots.has(r.bot.login),
            );
            if (eligibleReviews.length > 0) {
              await this.reRequestBotReviews(prNumber, botFilter, eligibleReviews);
              for (const r of eligibleReviews) requestedBots.add(r.bot.login);
            }
          } else {
            this.emitter?.emit('rerequest.skipped', { prNumber, reason: 'open_threads' });
          }
        }

        // ── Next round ───────────────────────────────────────────────────
        budget.nextRound();

        // Wait between rounds to give bots time to re-review before polling again.
        if (!dryRun && round < maxRounds) {
          this.emitter?.emit('round.waiting', { round, intervalMs: this.roundIntervalMs });
          await this.sleep(this.roundIntervalMs);
        }

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
        commentId: firstComment.id,
      });
    }

    return findings;
  }

  private buildReplyBody(
    finding: Finding,
    fixes: FixResult[],
    decision: 'fix' | 'defer' | 'reject',
    commitSha?: string,
  ): string | null {
    if (finding.classification?.category === 'duplicate') return null;

    const title = finding.title?.trim() ? `「${finding.title.slice(0, 100)}」` : '此問題';
    const locPart = finding.location.file
      ? ` (\`${finding.location.file}${finding.location.startLine ? `:${finding.location.startLine}` : ''}\`)`
      : '';

    if (decision === 'reject') {
      const reasoning = finding.classification?.reasoning;
      return reasoning
        ? `感謝指出 ${title}${locPart}，評估後決定不採納：${reasoning}`
        : `感謝指出 ${title}${locPart}，評估後認為目前實作符合預期，不做修改。`;
    }

    if (decision === 'defer') {
      const cat = finding.classification?.category;
      if (cat === 'taste') {
        return `${title}${locPart} 屬於風格偏好，已記錄，將遵循團隊慣例統一處理。`;
      }
      if (cat === 'yagni') {
        return `${title}${locPart} 問題有效，但超出本次 PR 範圍，已記錄為後續追蹤項目。`;
      }
      if (cat === 'wrong') {
        const reasoning = finding.classification?.reasoning;
        return reasoning
          ? `感謝指出 ${title}${locPart}，評估後認為此問題不適用於目前實作：${reasoning}`
          : `感謝指出 ${title}${locPart}，評估後認為此問題不適用於目前實作。`;
      }
      return `${title}${locPart} 已記錄為後續追蹤項目，本次 PR 範圍內暫不處理。`;
    }

    // decision === 'fix'
    const fix = fixes.find((f) => f.findingHash === finding.hash);
    if (fix) {
      const shaNote = commitSha ? ` (${commitSha.slice(0, 7)})` : '';
      const filesNote = fix.files?.length ? `，涉及：${fix.files.join(', ')}` : '';
      return `✅ ${title}${locPart} 已在本輪修復${shaNote}：${fix.description}${filesNote}`;
    }
    return `已確認 ${title}${locPart}，已排入本輪修復佇列；若 AI 本輪未能自動修復，將在下一輪繼續處理。`;
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
