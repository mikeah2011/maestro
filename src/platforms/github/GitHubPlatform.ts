/**
 * GitHub implementation of GitPlatform.
 *
 * Uses:
 *   - @octokit/rest for REST operations (PR I/O, CI checks, rate limits)
 *   - @octokit/graphql for thread operations (listReviewThreads, replyInThread,
 *     resolveReviewThread) because the REST API lacks first-class thread support
 *
 * All clients are injectable for testing — pass `clients` to the constructor
 * to avoid live HTTP calls in unit tests.
 */

import { Octokit } from '@octokit/rest';
import { graphql as graphqlFn } from '@octokit/graphql';
import simpleGit, { type SimpleGit } from 'simple-git';

import { GitPlatform } from '../interfaces/GitPlatform';
import type { GitPlatformConfig, PlatformCapabilities, RateLimitInfo } from '../interfaces/GitPlatform';
import type { BotReview, ReviewThread } from '../../core/types/Finding';
import type { CIStatus } from '../../core/types/CI';
import type { PullRequest, PullRequestDiff } from '../../core/types/PullRequest';
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
} from './mappers';

// ─── Injectable client shape (for testing) ───────────────────────────────────

export type GraphQLClient = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface GitHubClients {
  octokit: Octokit;
  graphql: GraphQLClient;
  git: SimpleGit;
}

// ─── GraphQL queries / mutations ─────────────────────────────────────────────

const LIST_REVIEW_THREADS_QUERY = `
  query ListReviewThreads($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id isResolved path line originalLine
            comments(first: 50) {
              nodes {
                id databaseId
                author { login __typename }
                body createdAt updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

const REPLY_IN_THREAD_MUTATION = `
  mutation ReplyInThread($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {
      pullRequestReviewThreadId: $threadId
      body: $body
    }) {
      comment { id body }
    }
  }
`;

const GET_REVIEW_NODE_QUERY = `
  query GetReviewNode($nodeId: ID!) {
    node(id: $nodeId) {
      ... on PullRequestReview {
        id databaseId
        author { login __typename }
        state body submittedAt
        pullRequest { number }
      }
    }
  }
`;

const GET_VIEWER_QUERY = `
  query GetViewer {
    viewer { login }
  }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveToken(config: GitPlatformConfig): string {
  if (config.token) return config.token;
  const envKey = config.tokenEnv ?? 'GITHUB_TOKEN';
  const val = process.env[envKey];
  if (!val) {
    throw new Error(
      `GitHubPlatform: token not found. Set ${envKey} env var or provide config.token.`,
    );
  }
  return val;
}

function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const ssh = url.trim().match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  const https = url.trim().match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?(?:\s|$)/);
  if (https) return { owner: https[1]!, repo: https[2]! };
  return null;
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class GitHubPlatform extends GitPlatform {
  readonly type = 'github' as const;
  readonly capabilities: PlatformCapabilities = {
    threadResolve: true,
    inlineReplies: true,
    reviewThreads: true,
    requestReviewers: true,
    ciStatus: true,
    graphql: true,
  };

  private _owner?: string;
  private _repo?: string;
  private _octokit?: Octokit;
  private _graphql?: GraphQLClient;
  private _git?: SimpleGit;
  private _ourLogin?: string;

  constructor(
    config: GitPlatformConfig,
    private readonly injected?: Partial<GitHubClients>,
  ) {
    super(config);
    // Set owner/repo eagerly from config so ownerRepo() can return before
    // initialize() is called, allowing the octokit guard to throw first.
    if (config.owner) this._owner = config.owner;
    if (config.repo) this._repo = config.repo;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const token = resolveToken(this.config);
    const baseUrl = this.config.baseUrl;

    this._octokit =
      this.injected?.octokit ??
      new Octokit({
        auth: token,
        ...(baseUrl ? { baseUrl } : {}),
      });

    const authedGraphql = graphqlFn.defaults({
      headers: { authorization: `token ${token}` },
      ...(baseUrl ? { baseUrl: `${baseUrl}/graphql` } : {}),
    });
    this._graphql =
      this.injected?.graphql ??
      ((query, variables) =>
        authedGraphql(query, variables) as Promise<Record<string, unknown>>);

    this._git = this.injected?.git ?? simpleGit();

    if (this.config.owner && this.config.repo) {
      this._owner = this.config.owner;
      this._repo = this.config.repo;
    }

    // Resolve our own login for isOurs tagging
    const viewerResult = await this.gql<{ viewer: { login: string } }>(GET_VIEWER_QUERY);
    this._ourLogin = viewerResult.viewer.login;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.octokit.rest.users.getAuthenticated();
      return true;
    } catch {
      return false;
    }
  }

  async detectRepo(): Promise<{ owner: string; repo: string }> {
    if (this._owner && this._repo) {
      return { owner: this._owner, repo: this._repo };
    }
    const git = this._git ?? simpleGit();
    const remoteUrl = (await git.remote(['get-url', 'origin'])) ?? '';
    const parsed = parseGitHubRemote(remoteUrl);
    if (!parsed) {
      throw new Error(
        `GitHubPlatform: cannot detect owner/repo from remote URL: "${remoteUrl}"`,
      );
    }
    this._owner = parsed.owner;
    this._repo = parsed.repo;
    return parsed;
  }

  // ─── PR I/O ─────────────────────────────────────────────────────────────

  async getPullRequest(prNumber: number): Promise<PullRequest> {
    const { owner, repo } = await this.ownerRepo();
    const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    return mapPullRequest(data as GHPullRequest);
  }

  async getPullRequestDiff(prNumber: number): Promise<PullRequestDiff> {
    const { owner, repo } = await this.ownerRepo();
    const { data } = await this.octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return mapDiffFiles(data as GHDiffFile[]);
  }

  async updatePullRequestBody(prNumber: number, body: string): Promise<void> {
    const { owner, repo } = await this.ownerRepo();
    await this.octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, body });
  }

  async requestReviewers(prNumber: number, reviewers: string[]): Promise<void> {
    const { owner, repo } = await this.ownerRepo();
    await this.octokit.rest.pulls.requestReviewers({
      owner,
      repo,
      pull_number: prNumber,
      reviewers,
    });
  }

  // ─── Reviews & threads ───────────────────────────────────────────────────

  async listReviews(prNumber: number, since?: Date): Promise<BotReview[]> {
    const { owner, repo } = await this.ownerRepo();
    const { data } = await this.octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    let reviews = (data as GHReview[]).map(mapReview);
    if (since) {
      reviews = reviews.filter((r) => r.submittedAt >= since);
    }

    // Hydrate threads
    const threads = await this.listReviewThreads(prNumber);
    const threadsByReview = new Map<string, ReviewThread[]>();
    for (const t of threads) {
      const reviewId = t.reviewId;
      if (reviewId) {
        const list = threadsByReview.get(reviewId) ?? [];
        list.push(t);
        threadsByReview.set(reviewId, list);
      }
    }
    return reviews.map((r) => ({
      ...r,
      threads: threadsByReview.get(r.id) ?? [],
    }));
  }

  async getReview(reviewId: string): Promise<BotReview> {
    type ReviewNode = {
      node: {
        id: string;
        author: { login: string; __typename?: string } | null;
        state: string;
        body: string | null;
        submittedAt: string | null;
        pullRequest: { number: number };
      };
    };
    const result = await this.gql<ReviewNode>(GET_REVIEW_NODE_QUERY, { nodeId: reviewId });
    const node = result.node;
    const ghReview: GHReview = {
      id: 0,
      node_id: node.id,
      user: node.author ? { login: node.author.login, type: node.author.__typename } : null,
      state: node.state,
      body: node.body,
      submitted_at: node.submittedAt,
    };
    return { ...mapReview(ghReview), threads: [] };
  }

  async listReviewThreads(prNumber: number): Promise<ReviewThread[]> {
    const { owner, repo } = await this.ownerRepo();
    const ourLogin = this._ourLogin ?? '';
    const threads: ReviewThread[] = [];
    let after: string | undefined;

    for (;;) {
      type ThreadsResult = {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string };
              nodes: GHGraphQLThread[];
            };
          };
        };
      };
      const result = await this.gql<ThreadsResult>(LIST_REVIEW_THREADS_QUERY, {
        owner,
        repo,
        prNumber,
        after: after ?? null,
      });
      const page = result.repository.pullRequest.reviewThreads;
      threads.push(...page.nodes.map((n) => mapGraphQLThread(n, ourLogin)));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return threads;
  }

  async replyInThread(threadId: string, body: string): Promise<void> {
    await this.gql(REPLY_IN_THREAD_MUTATION, { threadId, body });
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    await this.gql(RESOLVE_THREAD_MUTATION, { threadId });
  }

  // ─── CI ──────────────────────────────────────────────────────────────────

  async getCIStatus(headSha: string): Promise<CIStatus> {
    const { owner, repo } = await this.ownerRepo();
    const { data } = await this.octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });
    return mapCheckRuns(data.check_runs as GHCheckRun[]);
  }

  // ─── Rate limits ─────────────────────────────────────────────────────────

  async getRateLimitInfo(): Promise<RateLimitInfo> {
    const { data } = await this.octokit.rest.rateLimit.get();
    return mapRateLimit(data as unknown as GHRateLimit);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private get octokit(): Octokit {
    if (!this._octokit) {
      throw new Error('GitHubPlatform.initialize() must be called before using the platform.');
    }
    return this._octokit;
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this._graphql) {
      throw new Error('GitHubPlatform.initialize() must be called before using the platform.');
    }
    return this._graphql(query, variables) as Promise<T>;
  }

  private async ownerRepo(): Promise<{ owner: string; repo: string }> {
    if (!this._owner || !this._repo) {
      return this.detectRepo();
    }
    return { owner: this._owner, repo: this._repo };
  }
}
