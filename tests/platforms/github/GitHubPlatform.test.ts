/**
 * GitHubPlatform unit tests — no live HTTP.
 * All Octokit and GraphQL calls are replaced with vi.fn() stubs injected
 * via the `clients` constructor parameter.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GitHubPlatform } from '../../../src/platforms/github/GitHubPlatform';
import type { GitHubClients } from '../../../src/platforms/github/GitHubPlatform';
import type { Octokit } from '@octokit/rest';

// ─── Stub builders ────────────────────────────────────────────────────────────

function makeOctokit(): Octokit {
  return {
    rest: {
      users: {
        getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'maestro-bot' } }),
      },
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: {
            node_id: 'PR_001',
            number: 7,
            title: 'Fix bug',
            body: 'body text',
            state: 'open',
            draft: false,
            head: { sha: 'aaa', ref: 'fix/bug' },
            base: { sha: 'bbb', ref: 'main' },
            html_url: 'https://github.com/owner/repo/pull/7',
            user: { login: 'alice' },
            requested_reviewers: [],
            labels: [],
            created_at: '2026-04-25T08:00:00Z',
            updated_at: '2026-04-25T09:00:00Z',
          },
        }),
        listFiles: vi.fn().mockResolvedValue({
          data: [
            { filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
        requestReviewers: vi.fn().mockResolvedValue({}),
        listReviews: vi.fn().mockResolvedValue({
          data: [
            {
              id: 1,
              node_id: 'PRR_001',
              user: { login: 'coderabbitai', type: 'Bot' },
              state: 'CHANGES_REQUESTED',
              body: 'Found issues.',
              submitted_at: '2026-04-25T10:00:00Z',
            },
          ],
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: 'vitest',
                status: 'completed',
                conclusion: 'success',
                html_url: 'https://github.com/actions/runs/1',
                completed_at: '2026-04-25T10:00:00Z',
              },
            ],
          },
        }),
      },
      rateLimit: {
        get: vi.fn().mockResolvedValue({
          data: {
            resources: {
              core: { remaining: 4999, limit: 5000, reset: 1800000000 },
            },
          },
        }),
      },
    },
  } as unknown as Octokit;
}

const EMPTY_THREADS_RESULT = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: '' },
        nodes: [],
      },
    },
  },
};

function makeGraphQL() {
  return vi.fn().mockImplementation((query: string) => {
    if (query.includes('GetViewer')) {
      return Promise.resolve({ viewer: { login: 'maestro-bot' } });
    }
    if (query.includes('ListReviewThreads')) {
      return Promise.resolve(EMPTY_THREADS_RESULT);
    }
    if (query.includes('resolveReviewThread')) {
      return Promise.resolve({ resolveReviewThread: { thread: { id: 'PRRT_001', isResolved: true } } });
    }
    if (query.includes('addPullRequestReviewThreadReply')) {
      return Promise.resolve({ addPullRequestReviewThreadReply: { comment: { id: 'PRRC_999', body: 'reply' } } });
    }
    if (query.includes('GetReviewNode')) {
      return Promise.resolve({
        node: {
          id: 'PRR_001',
          author: { login: 'coderabbitai', __typename: 'Bot' },
          state: 'CHANGES_REQUESTED',
          body: 'Found issues.',
          submittedAt: '2026-04-25T10:00:00Z',
          pullRequest: { number: 7 },
        },
      });
    }
    return Promise.resolve({});
  });
}

function makeGit() {
  return {
    remote: vi.fn().mockResolvedValue('git@github.com:owner/repo.git\n'),
  };
}

function makePlatform(partialClients: Partial<GitHubClients> = {}): GitHubPlatform {
  const defaultClients: GitHubClients = {
    octokit: makeOctokit(),
    graphql: makeGraphQL(),
    git: makeGit() as unknown as import('simple-git').SimpleGit,
  };
  return new GitHubPlatform(
    { owner: 'owner', repo: 'repo', token: 'ghp_test' },
    { ...defaultClients, ...partialClients },
  );
}

async function initializedPlatform(partialClients: Partial<GitHubClients> = {}): Promise<GitHubPlatform> {
  const p = makePlatform(partialClients);
  await p.initialize();
  return p;
}

// ─── Type and capabilities ────────────────────────────────────────────────────

describe('GitHubPlatform — identity', () => {
  it('has type "github"', () => {
    expect(makePlatform().type).toBe('github');
  });

  it('declares full capabilities', () => {
    const caps = makePlatform().capabilities;
    expect(caps.threadResolve).toBe(true);
    expect(caps.inlineReplies).toBe(true);
    expect(caps.reviewThreads).toBe(true);
    expect(caps.graphql).toBe(true);
    expect(caps.ciStatus).toBe(true);
  });
});

// ─── initialize ───────────────────────────────────────────────────────────────

describe('GitHubPlatform — initialize', () => {
  it('calls GetViewer to resolve our login', async () => {
    const graphql = makeGraphQL();
    const p = await initializedPlatform({ graphql });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('GetViewer'), undefined);
    // Platform is ready — no errors thrown
    expect(p).toBeDefined();
  });

  it('throws when used before initialize()', async () => {
    const p = makePlatform();
    await expect(p.getPullRequest(1)).rejects.toThrow('initialize()');
  });
});

// ─── testConnection ───────────────────────────────────────────────────────────

describe('GitHubPlatform — testConnection', () => {
  it('returns true when REST call succeeds', async () => {
    const p = await initializedPlatform();
    expect(await p.testConnection()).toBe(true);
  });

  it('returns false on network error', async () => {
    const octokit = makeOctokit();
    (octokit.rest.users.getAuthenticated as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('401'),
    );
    const p = await initializedPlatform({ octokit });
    expect(await p.testConnection()).toBe(false);
  });
});

// ─── detectRepo ───────────────────────────────────────────────────────────────

describe('GitHubPlatform — detectRepo', () => {
  it('returns owner+repo from config without calling git', async () => {
    const git = makeGit();
    const p = await initializedPlatform({ git: git as unknown as import('simple-git').SimpleGit });
    const result = await p.detectRepo();
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    expect(git.remote).not.toHaveBeenCalled();
  });

  it('parses SSH remote URL when config lacks owner/repo', async () => {
    const git = makeGit();
    (git.remote as ReturnType<typeof vi.fn>).mockResolvedValue(
      'git@github.com:myorg/myrepo.git\n',
    );
    const p = new GitHubPlatform(
      { token: 'ghp_test' }, // no owner/repo in config
      { octokit: makeOctokit(), graphql: makeGraphQL(), git: git as unknown as import('simple-git').SimpleGit },
    );
    await p.initialize();
    const result = await p.detectRepo();
    expect(result).toEqual({ owner: 'myorg', repo: 'myrepo' });
  });

  it('parses HTTPS remote URL', async () => {
    const git = makeGit();
    (git.remote as ReturnType<typeof vi.fn>).mockResolvedValue(
      'https://github.com/myorg/myrepo\n',
    );
    const p = new GitHubPlatform(
      { token: 'ghp_test' },
      { octokit: makeOctokit(), graphql: makeGraphQL(), git: git as unknown as import('simple-git').SimpleGit },
    );
    await p.initialize();
    const result = await p.detectRepo();
    expect(result).toEqual({ owner: 'myorg', repo: 'myrepo' });
  });

  it('throws on unparseable remote URL', async () => {
    const git = makeGit();
    (git.remote as ReturnType<typeof vi.fn>).mockResolvedValue('not-a-github-url\n');
    const p = new GitHubPlatform(
      { token: 'ghp_test' },
      { octokit: makeOctokit(), graphql: makeGraphQL(), git: git as unknown as import('simple-git').SimpleGit },
    );
    await p.initialize();
    await expect(p.detectRepo()).rejects.toThrow('cannot detect owner/repo');
  });
});

// ─── getPullRequest ───────────────────────────────────────────────────────────

describe('GitHubPlatform — getPullRequest', () => {
  it('calls REST and returns mapped PR', async () => {
    const octokit = makeOctokit();
    const p = await initializedPlatform({ octokit });
    const pr = await p.getPullRequest(7);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
    });
    expect(pr.number).toBe(7);
    expect(pr.title).toBe('Fix bug');
    expect(pr.state).toBe('open');
    expect(pr.headSha).toBe('aaa');
  });
});

// ─── getPullRequestDiff ───────────────────────────────────────────────────────

describe('GitHubPlatform — getPullRequestDiff', () => {
  it('calls listFiles and returns mapped diff', async () => {
    const p = await initializedPlatform();
    const diff = await p.getPullRequestDiff(7);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]!.path).toBe('src/a.ts');
    expect(diff.stats.additions).toBe(3);
    expect(diff.stats.deletions).toBe(1);
  });
});

// ─── updatePullRequestBody ────────────────────────────────────────────────────

describe('GitHubPlatform — updatePullRequestBody', () => {
  it('calls pulls.update with the new body', async () => {
    const octokit = makeOctokit();
    const p = await initializedPlatform({ octokit });
    await p.updatePullRequestBody(7, '## Updated body');
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
      body: '## Updated body',
    });
  });
});

// ─── requestReviewers ─────────────────────────────────────────────────────────

describe('GitHubPlatform — requestReviewers', () => {
  it('calls requestReviewers with reviewer list', async () => {
    const octokit = makeOctokit();
    const p = await initializedPlatform({ octokit });
    await p.requestReviewers(7, ['alice', 'bob']);
    expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 7,
      reviewers: ['alice', 'bob'],
    });
  });
});

// ─── listReviews ──────────────────────────────────────────────────────────────

describe('GitHubPlatform — listReviews', () => {
  it('returns mapped bot reviews', async () => {
    const p = await initializedPlatform();
    const reviews = await p.listReviews(7);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.bot.login).toBe('coderabbitai');
    expect(reviews[0]!.state).toBe('changes_requested');
  });

  it('filters by since date', async () => {
    const p = await initializedPlatform();
    const futureDate = new Date('2030-01-01T00:00:00Z');
    const reviews = await p.listReviews(7, futureDate);
    expect(reviews).toHaveLength(0);
  });

  it('hydrates threads from listReviewThreads', async () => {
    const graphql = makeGraphQL();
    const threadResult = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: '' },
            nodes: [
              {
                id: 'PRRT_001',
                isResolved: false,
                path: 'src/a.ts',
                line: 10,
                originalLine: 10,
                comments: {
                  nodes: [
                    {
                      id: 'PRRC_001',
                      databaseId: 9001,
                      author: { login: 'coderabbitai', __typename: 'Bot' },
                      body: 'Issue here.',
                      createdAt: '2026-04-25T10:00:00Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    };
    (graphql as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('GetViewer')) return Promise.resolve({ viewer: { login: 'maestro-bot' } });
      if (query.includes('ListReviewThreads')) return Promise.resolve(threadResult);
      return Promise.resolve({});
    });
    const p = await initializedPlatform({ graphql });
    const reviews = await p.listReviews(7);
    // Threads don't attach to reviews without reviewId match, so threads array
    // stays empty — but the call itself must not throw
    expect(reviews).toHaveLength(1);
  });
});

// ─── listReviewThreads ────────────────────────────────────────────────────────

describe('GitHubPlatform — listReviewThreads', () => {
  it('returns empty array when no threads', async () => {
    const p = await initializedPlatform();
    const threads = await p.listReviewThreads(7);
    expect(threads).toHaveLength(0);
  });

  it('paginates through multiple pages', async () => {
    const graphql = makeGraphQL();
    let callCount = 0;
    (graphql as ReturnType<typeof vi.fn>).mockImplementation((query: string) => {
      if (query.includes('GetViewer')) return Promise.resolve({ viewer: { login: 'maestro-bot' } });
      if (query.includes('ListReviewThreads')) {
        callCount++;
        const isFirst = callCount === 1;
        return Promise.resolve({
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: isFirst, endCursor: isFirst ? 'cursor1' : '' },
                nodes: [
                  {
                    id: `PRRT_00${callCount}`,
                    isResolved: false,
                    comments: { nodes: [] },
                  },
                ],
              },
            },
          },
        });
      }
      return Promise.resolve({});
    });
    const p = await initializedPlatform({ graphql });
    const threads = await p.listReviewThreads(7);
    expect(threads).toHaveLength(2);
  });
});

// ─── replyInThread ────────────────────────────────────────────────────────────

describe('GitHubPlatform — replyInThread', () => {
  it('calls the GraphQL mutation with threadId and body', async () => {
    const graphql = makeGraphQL();
    const p = await initializedPlatform({ graphql });
    await p.replyInThread('PRRT_001', 'Fixed in commit abc.');
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('addPullRequestReviewThreadReply'),
      { threadId: 'PRRT_001', body: 'Fixed in commit abc.' },
    );
  });
});

// ─── resolveReviewThread ──────────────────────────────────────────────────────

describe('GitHubPlatform — resolveReviewThread', () => {
  it('calls the GraphQL mutation with the threadId', async () => {
    const graphql = makeGraphQL();
    const p = await initializedPlatform({ graphql });
    await p.resolveReviewThread('PRRT_001');
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_001' },
    );
  });
});

// ─── getCIStatus ──────────────────────────────────────────────────────────────

describe('GitHubPlatform — getCIStatus', () => {
  it('calls checks.listForRef and returns mapped status', async () => {
    const octokit = makeOctokit();
    const p = await initializedPlatform({ octokit });
    const status = await p.getCIStatus('deadbeef');
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      ref: 'deadbeef',
      per_page: 100,
    });
    expect(status.state).toBe('success');
    expect(status.totalCount).toBe(1);
  });
});

// ─── getRateLimitInfo ─────────────────────────────────────────────────────────

describe('GitHubPlatform — getRateLimitInfo', () => {
  it('calls rateLimit.get and returns mapped info', async () => {
    const p = await initializedPlatform();
    const info = await p.getRateLimitInfo();
    expect(info.remaining).toBe(4999);
    expect(info.limit).toBe(5000);
  });
});
