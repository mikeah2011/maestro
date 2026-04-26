/**
 * Pure mapper tests — no network I/O.
 * Every GitHub REST/GraphQL shape → domain type mapping is exercised here.
 */

import { describe, expect, it } from 'vitest';
import {
  mapPullRequest,
  mapDiffFiles,
  mapReview,
  mapGraphQLThread,
  mapCheckRuns,
  mapRateLimit,
  type GHPullRequest,
  type GHDiffFile,
  type GHReview,
  type GHGraphQLThread,
  type GHCheckRun,
  type GHRateLimit,
} from '../../../src/platforms/github/mappers';

// ─── mapPullRequest ───────────────────────────────────────────────────────────

describe('mapPullRequest', () => {
  function baseGH(overrides: Partial<GHPullRequest> = {}): GHPullRequest {
    return {
      node_id: 'PR_abc123',
      number: 42,
      title: 'Fix null dereference',
      body: '## Summary\n\nFixes #123',
      state: 'open',
      draft: false,
      head: { sha: 'deadbeef', ref: 'fix/null-deref' },
      base: { sha: 'cafebabe', ref: 'main' },
      html_url: 'https://github.com/owner/repo/pull/42',
      user: { login: 'michael' },
      requested_reviewers: [{ login: 'alice' }, { login: 'bob' }],
      labels: [{ name: 'bug' }],
      created_at: '2026-04-25T10:00:00Z',
      updated_at: '2026-04-25T11:00:00Z',
      ...overrides,
    };
  }

  it('maps basic fields correctly', () => {
    const pr = mapPullRequest(baseGH());
    expect(pr.id).toBe('PR_abc123');
    expect(pr.number).toBe(42);
    expect(pr.title).toBe('Fix null dereference');
    expect(pr.body).toBe('## Summary\n\nFixes #123');
    expect(pr.headSha).toBe('deadbeef');
    expect(pr.baseSha).toBe('cafebabe');
    expect(pr.baseBranch).toBe('main');
    expect(pr.headBranch).toBe('fix/null-deref');
    expect(pr.url).toBe('https://github.com/owner/repo/pull/42');
    expect(pr.author).toBe('michael');
    expect(pr.requestedReviewers).toEqual(['alice', 'bob']);
    expect(pr.labels).toEqual(['bug']);
    expect(pr.createdAt).toEqual(new Date('2026-04-25T10:00:00Z'));
    expect(pr.updatedAt).toEqual(new Date('2026-04-25T11:00:00Z'));
  });

  it('maps open PR state', () => {
    expect(mapPullRequest(baseGH({ state: 'open', draft: false })).state).toBe('open');
  });

  it('maps draft state from draft flag', () => {
    expect(mapPullRequest(baseGH({ state: 'open', draft: true })).state).toBe('draft');
  });

  it('maps closed state', () => {
    expect(mapPullRequest(baseGH({ state: 'closed', draft: false })).state).toBe('closed');
  });

  it('handles null body as empty string', () => {
    expect(mapPullRequest(baseGH({ body: null })).body).toBe('');
  });

  it('handles null user as "unknown"', () => {
    expect(mapPullRequest(baseGH({ user: null })).author).toBe('unknown');
  });
});

// ─── mapDiffFiles ─────────────────────────────────────────────────────────────

describe('mapDiffFiles', () => {
  const files: GHDiffFile[] = [
    { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, patch: '@@...' },
    { filename: 'src/b.ts', status: 'added', additions: 10, deletions: 0 },
    { filename: 'src/c.ts', previous_filename: 'src/old.ts', status: 'renamed', additions: 0, deletions: 0 },
    { filename: 'src/d.ts', status: 'removed', additions: 0, deletions: 30 },
  ];

  it('computes aggregate stats', () => {
    const diff = mapDiffFiles(files);
    expect(diff.stats.additions).toBe(15);
    expect(diff.stats.deletions).toBe(32);
    expect(diff.stats.filesChanged).toBe(4);
  });

  it('maps file statuses', () => {
    const diff = mapDiffFiles(files);
    expect(diff.files[0]!.status).toBe('modified');
    expect(diff.files[1]!.status).toBe('added');
    expect(diff.files[2]!.status).toBe('renamed');
    expect(diff.files[3]!.status).toBe('removed');
  });

  it('includes patch when present', () => {
    const diff = mapDiffFiles(files);
    expect(diff.files[0]!.patch).toBe('@@...');
    expect(diff.files[1]!.patch).toBeUndefined();
  });

  it('includes oldPath for renamed files', () => {
    const diff = mapDiffFiles(files);
    expect(diff.files[2]!.oldPath).toBe('src/old.ts');
    expect(diff.files[0]!.oldPath).toBeUndefined();
  });

  it('returns empty stats for empty file list', () => {
    const diff = mapDiffFiles([]);
    expect(diff.stats.filesChanged).toBe(0);
    expect(diff.stats.additions).toBe(0);
  });
});

// ─── mapReview ────────────────────────────────────────────────────────────────

describe('mapReview', () => {
  function baseGHReview(overrides: Partial<GHReview> = {}): GHReview {
    return {
      id: 1001,
      node_id: 'PRR_abc',
      user: { login: 'coderabbitai', type: 'Bot' },
      state: 'CHANGES_REQUESTED',
      body: 'Found issues.',
      submitted_at: '2026-04-25T09:00:00Z',
      ...overrides,
    };
  }

  it('uses node_id as review id', () => {
    expect(mapReview(baseGHReview()).id).toBe('PRR_abc');
  });

  it('maps bot identity', () => {
    const r = mapReview(baseGHReview());
    expect(r.bot.login).toBe('coderabbitai');
    expect(r.bot.isBot).toBe(true);
  });

  it('maps user (non-bot) identity', () => {
    const r = mapReview(baseGHReview({ user: { login: 'alice', type: 'User' } }));
    expect(r.bot.isBot).toBe(false);
  });

  it('maps review state: CHANGES_REQUESTED', () => {
    expect(mapReview(baseGHReview({ state: 'CHANGES_REQUESTED' })).state).toBe('changes_requested');
  });

  it('maps review state: APPROVED', () => {
    expect(mapReview(baseGHReview({ state: 'APPROVED' })).state).toBe('approved');
  });

  it('maps review state: COMMENTED', () => {
    expect(mapReview(baseGHReview({ state: 'COMMENTED' })).state).toBe('commented');
  });

  it('maps review state: DISMISSED', () => {
    expect(mapReview(baseGHReview({ state: 'DISMISSED' })).state).toBe('dismissed');
  });

  it('maps unknown state to commented', () => {
    expect(mapReview(baseGHReview({ state: 'PENDING' })).state).toBe('commented');
  });

  it('maps COMMENTED + Copilot "no new comments" body to satisfied', () => {
    const body = 'Copilot reviewed 15 out of 17 changed files in this pull request and generated no new comments.';
    expect(mapReview(baseGHReview({ state: 'COMMENTED', body })).state).toBe('satisfied');
  });

  it('maps COMMENTED without "no new comments" body to commented', () => {
    const body = 'Please address the null-check issue on line 42.';
    expect(mapReview(baseGHReview({ state: 'COMMENTED', body })).state).toBe('commented');
  });

  it('initializes threads as empty array', () => {
    expect(mapReview(baseGHReview()).threads).toEqual([]);
  });

  it('handles null user as ghost', () => {
    const r = mapReview(baseGHReview({ user: null }));
    expect(r.bot.login).toBe('ghost');
  });

  it('handles null submitted_at', () => {
    const r = mapReview(baseGHReview({ submitted_at: null }));
    expect(r.submittedAt).toEqual(new Date(0));
  });

  it('handles null body', () => {
    expect(mapReview(baseGHReview({ body: null })).body).toBeUndefined();
  });
});

// ─── mapGraphQLThread ─────────────────────────────────────────────────────────

describe('mapGraphQLThread', () => {
  const OUR_LOGIN = 'maestro-bot';

  function baseThread(overrides: Partial<GHGraphQLThread> = {}): GHGraphQLThread {
    return {
      id: 'PRRT_001',
      isResolved: false,
      path: 'src/auth/login.ts',
      line: 42,
      originalLine: 40,
      comments: {
        nodes: [
          {
            id: 'PRRC_001',
            databaseId: 9001,
            author: { login: 'coderabbitai', __typename: 'Bot' },
            body: 'This is unsafe.',
            createdAt: '2026-04-25T08:00:00Z',
            updatedAt: '2026-04-25T08:01:00Z',
          },
          {
            id: 'PRRC_002',
            databaseId: 9002,
            author: { login: OUR_LOGIN, __typename: 'User' },
            body: 'Fixed in the next commit.',
            createdAt: '2026-04-25T09:00:00Z',
          },
        ],
      },
      ...overrides,
    };
  }

  it('maps thread id and resolved status', () => {
    const t = mapGraphQLThread(baseThread(), OUR_LOGIN);
    expect(t.id).toBe('PRRT_001');
    expect(t.isResolved).toBe(false);
  });

  it('maps file location', () => {
    const t = mapGraphQLThread(baseThread(), OUR_LOGIN);
    expect(t.location?.file).toBe('src/auth/login.ts');
    expect(t.location?.startLine).toBe(42);
    expect(t.location?.endLine).toBe(40);
  });

  it('maps comments in order', () => {
    const t = mapGraphQLThread(baseThread(), OUR_LOGIN);
    expect(t.comments).toHaveLength(2);
    expect(t.comments[0]!.body).toBe('This is unsafe.');
    expect(t.comments[1]!.body).toBe('Fixed in the next commit.');
  });

  it('marks our comments with isOurs=true', () => {
    const t = mapGraphQLThread(baseThread(), OUR_LOGIN);
    expect(t.comments[0]!.isOurs).toBe(false);
    expect(t.comments[1]!.isOurs).toBe(true);
  });

  it('handles thread without path (top-level comment)', () => {
    const t = mapGraphQLThread(baseThread({ path: undefined, line: undefined }), OUR_LOGIN);
    expect(t.location).toBeUndefined();
  });

  it('handles resolved thread', () => {
    const t = mapGraphQLThread(baseThread({ isResolved: true }), OUR_LOGIN);
    expect(t.isResolved).toBe(true);
  });
});

// ─── mapCheckRuns ─────────────────────────────────────────────────────────────

describe('mapCheckRuns', () => {
  function check(overrides: Partial<GHCheckRun> = {}): GHCheckRun {
    return {
      name: 'tests / vitest',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/actions/runs/1',
      completed_at: '2026-04-25T10:00:00Z',
      ...overrides,
    };
  }

  it('returns success when all checks pass', () => {
    const s = mapCheckRuns([check(), check({ name: 'typecheck', conclusion: 'success' })]);
    expect(s.state).toBe('success');
    expect(s.failingCount).toBe(0);
    expect(s.pendingCount).toBe(0);
    expect(s.totalCount).toBe(2);
  });

  it('returns failure when any check fails', () => {
    const s = mapCheckRuns([check(), check({ name: 'e2e', conclusion: 'failure' })]);
    expect(s.state).toBe('failure');
    expect(s.failingCount).toBe(1);
  });

  it('returns pending when any check is in_progress', () => {
    const s = mapCheckRuns([check(), check({ name: 'long', status: 'in_progress', conclusion: null })]);
    expect(s.state).toBe('pending');
    expect(s.pendingCount).toBe(1);
  });

  it('maps cancelled and skipped conclusions', () => {
    const s = mapCheckRuns([
      check({ conclusion: 'cancelled' }),
      check({ conclusion: 'skipped' }),
    ]);
    const states = s.checks.map((c) => c.state);
    expect(states).toContain('cancelled');
    expect(states).toContain('skipped');
  });

  it('returns success for empty check list (no CI = no blocker)', () => {
    expect(mapCheckRuns([]).state).toBe('success');
    expect(mapCheckRuns([]).totalCount).toBe(0);
  });

  it('includes targetUrl and completedAt', () => {
    const s = mapCheckRuns([check()]);
    expect(s.checks[0]!.targetUrl).toBe('https://github.com/actions/runs/1');
    expect(s.checks[0]!.completedAt).toEqual(new Date('2026-04-25T10:00:00Z'));
  });
});

// ─── mapRateLimit ─────────────────────────────────────────────────────────────

describe('mapRateLimit', () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;

  const ghData: GHRateLimit = {
    resources: {
      core: { remaining: 4500, limit: 5000, reset },
      graphql: { remaining: 200, limit: 500, reset },
    },
  };

  it('maps remaining and limit from core', () => {
    const r = mapRateLimit(ghData);
    expect(r.remaining).toBe(4500);
    expect(r.limit).toBe(5000);
  });

  it('maps resetAt from epoch seconds', () => {
    const r = mapRateLimit(ghData);
    expect(r.resetAt).toEqual(new Date(reset * 1000));
  });

  it('maps graphqlCost from graphql resource', () => {
    const r = mapRateLimit(ghData);
    expect(r.graphqlCost).toBe(200);
  });

  it('handles missing graphql resource', () => {
    const r = mapRateLimit({ resources: { core: { remaining: 100, limit: 5000, reset } } });
    expect(r.graphqlCost).toBeUndefined();
  });
});
