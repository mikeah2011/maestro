/**
 * Pure mapping functions: GitHub REST/GraphQL API shapes → domain types.
 * Every mapper here is a pure function; no side effects, no I/O.
 */

import type { BotIdentity, BotReview, ReviewThread, ThreadComment } from '../../core/types/Finding';
import type { CICheck, CICheckState, CIStatus } from '../../core/types/CI';
import type { PullRequest, PullRequestDiff, PullRequestDiffFile } from '../../core/types/PullRequest';
import type { RateLimitInfo } from '../interfaces/GitPlatform';

// ─── GitHub REST response shapes (minimal — only what we use) ─────────────────

export interface GHPullRequest {
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  html_url: string;
  user: { login: string } | null;
  requested_reviewers: Array<{ login: string }>;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
}

export interface GHDiffFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GHReview {
  id: number;
  node_id: string;
  user: { login: string; type?: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
}

export interface GHReviewComment {
  id: number;
  node_id: string;
  pull_request_review_id: number | null;
  user: { login: string; type?: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
  in_reply_to_id?: number;
  path: string;
  line?: number;
  original_line?: number;
}

export interface GHCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  completed_at: string | null;
  output?: { summary?: string | null };
}

export interface GHRateLimit {
  resources: {
    core: { remaining: number; limit: number; reset: number };
    graphql?: { remaining: number; limit: number; reset: number };
  };
}

// ─── GraphQL response shapes ──────────────────────────────────────────────────

export interface GHGraphQLThread {
  id: string;
  isResolved: boolean;
  path?: string;
  line?: number;
  originalLine?: number;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      author: { login: string; __typename?: string } | null;
      body: string;
      createdAt: string;
      updatedAt?: string;
      isMinimized?: boolean;
    }>;
  };
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

export function mapPullRequest(gh: GHPullRequest): PullRequest {
  let state: PullRequest['state'];
  if (gh.draft) state = 'draft';
  else if (gh.state === 'closed') state = 'closed';
  else state = 'open';

  return {
    id: gh.node_id,
    number: gh.number,
    title: gh.title,
    body: gh.body ?? '',
    state,
    headSha: gh.head.sha,
    baseSha: gh.base.sha,
    baseBranch: gh.base.ref,
    headBranch: gh.head.ref,
    url: gh.html_url,
    author: gh.user?.login ?? 'unknown',
    requestedReviewers: gh.requested_reviewers.map((r) => r.login),
    reviewedBy: [],
    labels: gh.labels.map((l) => l.name),
    createdAt: new Date(gh.created_at),
    updatedAt: new Date(gh.updated_at),
  };
}

export function mapDiffFiles(files: GHDiffFile[]): PullRequestDiff {
  let additions = 0;
  let deletions = 0;
  const mappedFiles: PullRequestDiffFile[] = files.map((f) => {
    additions += f.additions;
    deletions += f.deletions;
    return {
      path: f.filename,
      ...(f.previous_filename ? { oldPath: f.previous_filename } : {}),
      status: mapFileStatus(f.status),
      additions: f.additions,
      deletions: f.deletions,
      ...(f.patch ? { patch: f.patch } : {}),
    };
  });
  return {
    files: mappedFiles,
    raw: '',
    stats: { additions, deletions, filesChanged: files.length },
  };
}

function mapFileStatus(s: string): PullRequestDiffFile['status'] {
  if (s === 'added') return 'added';
  if (s === 'removed') return 'removed';
  if (s === 'renamed') return 'renamed';
  return 'modified';
}

export function mapReview(gh: GHReview): BotReview {
  const bot: BotIdentity = {
    login: gh.user?.login ?? 'ghost',
    isBot: gh.user?.type === 'Bot',
  };
  const body = gh.body ?? undefined;
  return {
    id: gh.node_id,
    bot,
    submittedAt: new Date(gh.submitted_at ?? 0),
    state: mapReviewState(gh.state, body),
    body,
    threads: [],
  };
}

function mapReviewState(s: string, body?: string): BotReview['state'] {
  const lower = s.toLowerCase();
  if (lower === 'approved') return 'approved';
  if (lower === 'changes_requested') return 'changes_requested';
  if (lower === 'dismissed') return 'dismissed';
  // Bots like GitHub Copilot submit COMMENTED reviews when they find nothing new.
  // Treat "generated no new comments" as satisfied so the loop can stop waiting.
  if (body && /generated no new comments/i.test(body)) return 'satisfied';
  // Codex quota exhausted — treat as satisfied so we don't keep re-requesting.
  if (body && /reached your codex usage limits/i.test(body)) return 'satisfied';
  return 'commented';
}

export function mapGraphQLThread(gh: GHGraphQLThread, ourLogin: string): ReviewThread {
  const comments: ThreadComment[] = gh.comments.nodes.map((c) => ({
    id: c.id,
    author: {
      login: c.author?.login ?? 'ghost',
      isBot: c.author?.__typename === 'Bot',
    },
    body: c.body,
    createdAt: new Date(c.createdAt),
    ...(c.updatedAt ? { updatedAt: new Date(c.updatedAt) } : {}),
    isOurs: c.author?.login === ourLogin,
  }));

  return {
    id: gh.id,
    isResolved: gh.isResolved,
    ...(gh.path
      ? {
          location: {
            file: gh.path,
            ...(gh.line !== undefined ? { startLine: gh.line } : {}),
            ...(gh.originalLine !== undefined ? { endLine: gh.originalLine } : {}),
          },
        }
      : {}),
    comments,
  };
}

export function mapCheckRuns(runs: GHCheckRun[]): CIStatus {
  const checks: CICheck[] = runs.map((r) => ({
    name: r.name,
    state: mapCheckState(r.status, r.conclusion),
    ...(r.html_url ? { targetUrl: r.html_url } : {}),
    ...(r.output?.summary ? { output: r.output.summary } : {}),
    ...(r.completed_at ? { completedAt: new Date(r.completed_at) } : {}),
  }));

  const failingCount = checks.filter((c) => c.state === 'failure' || c.state === 'error').length;
  const pendingCount = checks.filter((c) => c.state === 'pending').length;

  let aggregate: CICheckState;
  if (failingCount > 0) aggregate = 'failure';
  else if (pendingCount > 0) aggregate = 'pending';
  else aggregate = 'success'; // 無 CI 檢查或全部通過 → 視為通過

  return {
    state: aggregate,
    totalCount: runs.length,
    failingCount,
    pendingCount,
    checks,
  };
}

function mapCheckState(status: string, conclusion: string | null): CICheckState {
  if (status === 'queued' || status === 'in_progress') return 'pending';
  if (conclusion === null) return 'pending';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure') return 'failure';
  if (conclusion === 'cancelled') return 'cancelled';
  if (conclusion === 'skipped') return 'skipped';
  return 'error';
}

export function mapRateLimit(gh: GHRateLimit): RateLimitInfo {
  const core = gh.resources.core;
  return {
    remaining: core.remaining,
    limit: core.limit,
    resetAt: new Date(core.reset * 1000),
    ...(gh.resources.graphql
      ? { graphqlCost: gh.resources.graphql.remaining }
      : {}),
  };
}
