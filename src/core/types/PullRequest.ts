/**
 * Normalized Pull/Merge Request representation across all four platforms.
 */

export type PullRequestState = 'open' | 'closed' | 'merged' | 'draft';

export interface PullRequest {
  /** Platform-native ID. */
  id: string;
  /** PR number (or merge request IID for GitLab). */
  number: number;
  title: string;
  /** Full PR body / description. */
  body: string;
  state: PullRequestState;
  /** SHA of the current HEAD commit on the PR branch. */
  headSha: string;
  /** SHA of the merge-base commit on the target branch. */
  baseSha: string;
  baseBranch: string;
  headBranch: string;
  /** Web URL where humans can view the PR. */
  url: string;
  author: string;
  /** Currently requested reviewers (logins). */
  requestedReviewers: string[];
  /** Reviewers who have already reviewed (logins). */
  reviewedBy: string[];
  /** Labels currently applied. */
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PullRequestDiff {
  /** Files changed in the PR. */
  files: PullRequestDiffFile[];
  /** Raw unified diff text. */
  raw: string;
  stats: {
    additions: number;
    deletions: number;
    filesChanged: number;
  };
}

export interface PullRequestDiffFile {
  path: string;
  /** Path before rename, if file was renamed. */
  oldPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  /** Per-file unified diff. */
  patch?: string;
}
