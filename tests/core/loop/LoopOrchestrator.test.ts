/**
 * LoopOrchestrator tests — full state machine loop with injected mocks.
 *
 * All platform calls and timing are mocked so tests run synchronously.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LoopOrchestrator } from '../../../src/core/loop/LoopOrchestrator';
import type { LoopOrchestratorOptions } from '../../../src/core/loop/LoopOrchestrator';
import { EventEmitter, toLine } from '../../../src/core/events/EventEmitter';
import { ConvergenceMonitor } from '../../../src/core/convergence/ConvergenceMonitor';
import { Classifier } from '../../../src/core/classify/Classifier';
import { Dedup } from '../../../src/core/dedup/Dedup';
import type { GitPlatform, PlatformCapabilities, RateLimitInfo } from '../../../src/platforms/interfaces/GitPlatform';
import type { PullRequest, PullRequestDiff } from '../../../src/core/types/PullRequest';
import type { BotReview, ReviewThread } from '../../../src/core/types/Finding';
import type { CIStatus } from '../../../src/core/types/CI';

// ─── Mock platform ────────────────────────────────────────────────────────────

function makePR(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'PR_001',
    number: 42,
    title: 'Add null check',
    body: 'Fixes #100',
    state: 'open',
    headSha: 'deadbeef',
    baseSha: 'cafebabe',
    baseBranch: 'main',
    headBranch: 'fix/null-check',
    url: 'https://github.com/owner/repo/pull/42',
    author: 'dev',
    requestedReviewers: [],
    reviewedBy: [],
    labels: [],
    createdAt: new Date('2026-04-25T00:00:00Z'),
    updatedAt: new Date('2026-04-25T01:00:00Z'),
    ...overrides,
  };
}

function makeCIStatus(state: CIStatus['state'] = 'success'): CIStatus {
  return { state, totalCount: 1, failingCount: 0, pendingCount: 0, checks: [] };
}

function makeBotReview(overrides: Partial<BotReview> = {}): BotReview {
  return {
    id: 'PRR_001',
    bot: { login: 'coderabbitai', isBot: true },
    submittedAt: new Date('2026-04-25T01:00:00Z'),
    state: 'changes_requested',
    threads: [],
    ...overrides,
  };
}

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'PRRT_001',
    isResolved: false,
    location: { file: 'src/auth.ts', startLine: 42 },
    comments: [
      {
        id: 'PRRC_001',
        author: { login: 'coderabbitai', isBot: true },
        body: 'This could cause a null pointer error.',
        createdAt: new Date('2026-04-25T01:00:00Z'),
        isOurs: false,
      },
    ],
    ...overrides,
  };
}

function makeMockPlatform(overrides: Partial<{
  ciStates: CIStatus['state'][];
  reviewRounds: BotReview[][];
  threadRounds: ReviewThread[][];
}> = {}): GitPlatform & {
  repliedThreads: string[];
  resolvedThreads: string[];
  requestedReviewers: string[][];
  prComments: string[];
} {
  const ciStates = overrides.ciStates ?? ['success'];
  const reviewRounds = overrides.reviewRounds ?? [[makeBotReview()]];
  const threadRounds = overrides.threadRounds ?? [[makeThread()]];

  let ciCallCount = 0;
  let reviewCallCount = 0;
  let threadCallCount = 0;
  const repliedThreads: string[] = [];
  const resolvedThreads: string[] = [];
  const requestedReviewers: string[][] = [];
  const prComments: string[] = [];

  const capabilities: PlatformCapabilities = {
    threadResolve: true,
    inlineReplies: true,
    reviewThreads: true,
    requestReviewers: true,
    ciStatus: true,
    graphql: true,
  };

  return {
    type: 'github',
    capabilities,
    repliedThreads,
    resolvedThreads,
    requestedReviewers,
    prComments,
    async initialize() {},
    async testConnection() { return true; },
    async detectRepo() { return { owner: 'owner', repo: 'repo' }; },
    async getPullRequest() { return makePR(); },
    async getPullRequestDiff(): Promise<PullRequestDiff> {
      return { files: [], raw: '', stats: { additions: 0, deletions: 0, filesChanged: 0 } };
    },
    async updatePullRequestBody() {},

    async getCIStatus(): Promise<CIStatus> {
      const idx = Math.min(ciCallCount++, ciStates.length - 1);
      return makeCIStatus(ciStates[idx] ?? 'success');
    },
    async listReviews(): Promise<BotReview[]> {
      const idx = Math.min(reviewCallCount++, reviewRounds.length - 1);
      return reviewRounds[idx] ?? [];
    },
    async getReview() { return makeBotReview(); },
    async listReviewThreads(): Promise<ReviewThread[]> {
      const idx = Math.min(threadCallCount++, threadRounds.length - 1);
      return threadRounds[idx] ?? [];
    },
    async requestReviewers(_prNumber, reviewers) { requestedReviewers.push(reviewers); },
    async createPRComment(_prNumber, body) { prComments.push(body); },
    async replyInThread(threadId) { repliedThreads.push(threadId); },
    async resolveReviewThread(threadId) { resolvedThreads.push(threadId); },
    async getRateLimitInfo(): Promise<RateLimitInfo> {
      return { remaining: 4500, limit: 5000, resetAt: new Date(Date.now() + 3600_000) };
    },
  } as unknown as GitPlatform & {
      repliedThreads: string[];
      resolvedThreads: string[];
      requestedReviewers: string[][];
      prComments: string[];
    };
}

function makeOrchestratorOpts(
  platform: GitPlatform,
  extra: Partial<LoopOrchestratorOptions> = {},
): LoopOrchestratorOptions {
  return {
    platform,
    sleep: async () => {},      // instant — no actual delays in tests
    ciPollIntervalMs: 0,
    botPollIntervalMs: 0,
    botTimeoutMs: 100,           // short timeout for bot-timeout tests
    ...extra,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LoopOrchestrator', () => {
  describe('stop conditions', () => {
    it('stops with reason approved when a bot is satisfied (no new comments)', async () => {
      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview({ state: 'satisfied' })]],
        threadRounds: [[]],
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform));
      const result = await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(result.reason).toBe('approved');
      expect(result.rounds).toBe(1);
    });

    it('does not re-request a satisfied bot', async () => {
      const thread = makeThread();
      const platform = makeMockPlatform({
        ciStates: ['success'],
        // Round 1: Copilot satisfied + another bot changes_requested
        // Round 2: other bot approves
        reviewRounds: [
          [
            makeBotReview({ id: 'PRR_copilot', bot: { login: 'copilot-pull-request-reviewer', isBot: true }, state: 'satisfied' }),
            makeBotReview({ id: 'PRR_other', bot: { login: 'coderabbitai', isBot: true }, state: 'changes_requested' }),
          ],
          [makeBotReview({ state: 'approved' })],
        ],
        threadRounds: [[thread], []],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'taste' as const, confidence: 0.9, viaFence: false }),
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { classifier, botTimeoutMs: 60_000 }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      // requestReviewers should never include the satisfied Copilot bot
      const allRequested = platform.requestedReviewers.flat();
      expect(allRequested).not.toContain('copilot-pull-request-reviewer');
    });

    it('stops with reason approved when a bot approves', async () => {
      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview({ state: 'approved' })]],
        threadRounds: [[]],
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform));
      const result = await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(result.reason).toBe('approved');
      expect(result.rounds).toBe(1);
      expect(result.finalState).toBe('stopped');
    });

    it('stops with reason max_rounds after reaching the cap', async () => {
      const platform = makeMockPlatform({
        ciStates: ['success'],
        // Return changes_requested every round so we never approve
        reviewRounds: [
          [makeBotReview()],
          [makeBotReview()],
          [makeBotReview()],
          [makeBotReview()],
        ],
        threadRounds: [[], [], [], []],
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { botTimeoutMs: 60_000 }));
      const result = await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(result.reason).toBe('max_rounds');
      expect(result.rounds).toBe(3);
    });

    it('stops with reason converged when criticals stabilize', async () => {
      // Round 1: 2 criticals; Round 2: same 2 criticals → Jaccard = 1.0 → converged
      const thread1 = makeThread({ id: 'PRRT_001', comments: [{ id: 'C1', author: { login: 'coderabbitai', isBot: true }, body: 'Critical bug: null dereference in error handler', createdAt: new Date(), isOurs: false }] });
      const thread2 = makeThread({ id: 'PRRT_002', location: { file: 'src/db.ts', startLine: 10 }, comments: [{ id: 'C2', author: { login: 'coderabbitai', isBot: true }, body: 'Critical bug: SQL injection vulnerability in query builder', createdAt: new Date(), isOurs: false }] });

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview()], [makeBotReview()]],
        threadRounds: [[thread1, thread2], [thread1, thread2]],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({
          category: 'bug' as const,
          confidence: 0.95,
          viaFence: false,
          reasoning: 'Critical bug identified',
        }),
      });

      const convergence = new ConvergenceMonitor({ maxRounds: 3 });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { classifier, convergence, botTimeoutMs: 60_000 }));
      const result = await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(result.reason).toBe('converged');
      expect(result.rounds).toBeGreaterThanOrEqual(2);
    });

    it('stops with reason error on platform exception', async () => {
      const platform = makeMockPlatform();
      (platform as unknown as Record<string, unknown>).getPullRequest = async () => {
        throw new Error('GitHub API rate limit exceeded');
      };

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform));
      const result = await orc.run({ prNumber: 42 });

      expect(result.reason).toBe('error');
      expect(result.error?.message).toContain('rate limit');
    });

    it('stops when CI fails on initial check', async () => {
      const platform = makeMockPlatform({ ciStates: ['failure'] });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform));
      const result = await orc.run({ prNumber: 42 });

      expect(result.reason).toBe('stopped');
      expect(result.rounds).toBe(0);
    });
  });

  describe('thread → finding conversion', () => {
    it('skips resolved threads', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));
      const resolved = makeThread({ isResolved: true });
      const findings = orc.threadsToFindings([resolved], 1, []);
      expect(findings).toHaveLength(0);
    });

    it('skips threads where first comment is ours', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));
      const ours = makeThread({
        comments: [{ id: 'C1', author: { login: 'maestro-bot', isBot: true }, body: 'Fixed.', createdAt: new Date(), isOurs: true }],
      });
      const findings = orc.threadsToFindings([ours], 1, []);
      expect(findings).toHaveLength(0);
    });

    it('skips threads from non-bot authors', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));
      const human = makeThread({
        comments: [{ id: 'C1', author: { login: 'alice', isBot: false }, body: 'Human comment.', createdAt: new Date(), isOurs: false }],
      });
      const findings = orc.threadsToFindings([human], 1, []);
      expect(findings).toHaveLength(0);
    });

    it('applies botFilter when specified', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));
      const thread = makeThread();
      const findings = orc.threadsToFindings([thread], 1, ['ellipsis-dev']);
      expect(findings).toHaveLength(0);
    });

    it('extracts severity from body keywords', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));

      const critical = makeThread({ comments: [{ id: 'C1', author: { login: 'bot', isBot: true }, body: 'Critical security vulnerability.', createdAt: new Date(), isOurs: false }] });
      const info = makeThread({ id: 'PRRT_002', comments: [{ id: 'C2', author: { login: 'bot', isBot: true }, body: 'Suggestion: consider extracting this helper.', createdAt: new Date(), isOurs: false }] });

      const [f1] = orc.threadsToFindings([critical], 1, []);
      const [f2] = orc.threadsToFindings([info], 1, []);

      expect(f1?.severity).toBe('critical');
      expect(f2?.severity).toBe('info');
    });

    it('truncates long titles to 100 chars', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));
      const longBody = 'A'.repeat(200);
      const thread = makeThread({ comments: [{ id: 'C1', author: { login: 'bot', isBot: true }, body: longBody, createdAt: new Date(), isOurs: false }] });
      const [finding] = orc.threadsToFindings([thread], 1, []);
      expect(finding?.title.length).toBeLessThanOrEqual(100);
    });

    it('produces stable hashes for the same thread across rounds', () => {
      const orc = new LoopOrchestrator(makeOrchestratorOpts(makeMockPlatform()));
      const thread = makeThread();
      const [f1] = orc.threadsToFindings([thread], 1, []);
      const [f2] = orc.threadsToFindings([thread], 2, []);
      expect(f1?.hash).toBe(f2?.hash);
    });
  });

  describe('platform interactions', () => {
    it('replies in open threads for classified findings', async () => {
      const thread = makeThread();
      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview({ state: 'approved' })], [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread]],
      });

      // Approved on round 1 but open thread → classify → reply (even unknown findings get a reply now) → resolve → stop
      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      // Open thread should receive a reply regardless of classification category
      expect(platform.repliedThreads).toHaveLength(1);
    });

    it('resolves threads for bug findings when a fix was committed', async () => {
      const thread = makeThread();
      const platform = makeMockPlatform({
        ciStates: ['success'],
        // Round 1: changes_requested → classify as bug → fix → commit; Round 2: approved
        reviewRounds: [[makeBotReview()], [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread], []],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'bug' as const, confidence: 0.9, viaFence: false }),
      });

      // onFix receives findings; return FixResults with matching hashes so threads get resolved
      const onFix = async (findings: import('../../../src/core/types/Finding').Finding[]) =>
        findings.map((f) => ({ findingHash: f.hash, description: 'patched' }));

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { classifier, onFix, botTimeoutMs: 60_000 }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(platform.resolvedThreads).toContain('PRRT_001');
    });

    it('resolves threads for taste findings after replying (有求必應)', async () => {
      const thread = makeThread();
      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview()], [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread], []],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'taste' as const, confidence: 0.9, viaFence: false }),
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { classifier, botTimeoutMs: 60_000 }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      // Taste findings get a reply AND are resolved — we reply first, then close on behalf of the author
      expect(platform.resolvedThreads).toContain('PRRT_001');
    });

    it('calls onFix with actionable bug findings', async () => {
      const thread = makeThread();
      const fixes: Parameters<NonNullable<LoopOrchestratorOptions['onFix']>>[0][] = [];

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview()], [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread], []],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'bug' as const, confidence: 0.95, viaFence: false }),
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, {
        classifier,
        botTimeoutMs: 60_000,
        onFix: async (findings) => {
          fixes.push(findings);
          return findings.map((f) => ({ findingHash: f.hash, description: 'Fixed.' }));
        },
      }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(fixes.length).toBeGreaterThan(0);
      expect(fixes[0]).toHaveLength(1);
    });

    it('deduplicates bots when the same bot has multiple reviews', async () => {
      const thread = makeThread();
      // Simulate a bot that left two separate reviews (GitHub can return both)
      const duplicateReviews = [
        makeBotReview({ id: 'PRR_001', bot: { login: 'coderabbitai', isBot: true }, state: 'changes_requested' }),
        makeBotReview({ id: 'PRR_002', bot: { login: 'coderabbitai', isBot: true }, state: 'changes_requested' }),
      ];

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [duplicateReviews, [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread], []],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'taste' as const, confidence: 0.9, viaFence: false }),
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { classifier, botTimeoutMs: 60_000 }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      // requestReviewers should be called at most once per round with no duplicates
      for (const call of platform.requestedReviewers) {
        expect(call).toEqual([...new Set(call)]);
      }
    });

    it('calls onCommit when fixes are produced', async () => {
      const thread = makeThread();
      const commits: unknown[] = [];

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview()], [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread], []],
      });

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'bug' as const, confidence: 0.95, viaFence: false }),
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, {
        classifier,
        botTimeoutMs: 60_000,
        onFix: async (findings) =>
          findings.map((f) => ({ findingHash: f.hash, description: 'Fixed null check' })),
        onCommit: async (commit) => { commits.push(commit); return 'abc1234'; },
      }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(commits.length).toBeGreaterThan(0);
    });
  });

  describe('event emission', () => {
    it('emits round.start and round.classified events', async () => {
      const events: string[] = [];
      const emitter = new EventEmitter();
      emitter.subscribe((event) => { events.push(event.type); });

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview({ state: 'approved' })]],
        threadRounds: [[]],
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { emitter }));
      await orc.run({ prNumber: 42, maxRounds: 3 });

      expect(events).toContain('round.start');
      expect(events).toContain('state.transition');
    });

    it('emits loop.error on exception', async () => {
      const events: unknown[] = [];
      const emitter = new EventEmitter();
      emitter.subscribe((e) => { events.push(e); });

      const platform = makeMockPlatform();
      (platform as unknown as Record<string, unknown>).getPullRequest = async () => {
        throw new Error('Network error');
      };

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { emitter }));
      await orc.run({ prNumber: 42 });

      const errorEvent = events.find((e) => (e as { type: string }).type === 'loop.error');
      expect(errorEvent).toBeDefined();
    });

    it('JSONL event format is parseable', async () => {
      const lines: string[] = [];
      const emitter = new EventEmitter();
      emitter.subscribe((e) => { lines.push(toLine(e)); });

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview({ state: 'approved' })]],
        threadRounds: [[]],
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, { emitter }));
      await orc.run({ prNumber: 42 });

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('dry-run behavior', () => {
    it('stops without calling onFix when approved and no open threads remain', async () => {
      let fixCalled = false;

      const platform = makeMockPlatform({
        ciStates: ['success'],
        reviewRounds: [[makeBotReview({ state: 'approved' })]],
        threadRounds: [[]], // no open threads — clean stop
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, {
        onFix: async () => { fixCalled = true; return []; },
      }));
      const result = await orc.run({ prNumber: 42 });

      expect(result.reason).toBe('approved');
      expect(fixCalled).toBe(false);
    });

    it('continues classifying when approved but open bot threads remain', async () => {
      const thread = makeThread();

      const classifier = new Classifier({
        llmClassify: async () => ({ category: 'taste' as const, confidence: 0.9, viaFence: false }),
      });

      const platform = makeMockPlatform({
        ciStates: ['success'],
        // Round 1: approved but has open thread → classify+resolve
        // Round 2: approved, no threads → stop
        reviewRounds: [[makeBotReview({ state: 'approved' })], [makeBotReview({ state: 'approved' })]],
        threadRounds: [[thread], []],
      });

      const orc = new LoopOrchestrator(makeOrchestratorOpts(platform, {
        classifier,
        botTimeoutMs: 60_000,
      }));
      const result = await orc.run({ prNumber: 42, maxRounds: 3 });

      // Loop must continue past the first round despite being approved (open thread present)
      expect(result.reason).toBe('approved');
      expect(result.rounds).toBeGreaterThanOrEqual(2);
      // Thread is resolved after replying, even for taste findings (有求必應)
      expect(platform.resolvedThreads).toContain('PRRT_001');
    });
  });
});
