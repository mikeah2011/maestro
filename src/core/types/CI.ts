/**
 * CI status types — minimal common shape across GitHub Checks, GitLab Pipelines,
 * Gitea Actions, Gitee CI. The orchestrator only needs to know:
 *   - is anything still pending?
 *   - is anything failing?
 *   - where can the user see the failure?
 */

export type CICheckState = 'pending' | 'success' | 'failure' | 'error' | 'cancelled' | 'skipped';

export interface CICheck {
  /** Human-readable name (e.g. "tests / vitest"). */
  name: string;
  state: CICheckState;
  /** URL to the check's run page on the platform. */
  targetUrl?: string;
  /** Short summary, when surfaced by the platform. */
  output?: string;
  /** Conclusion timestamp, when finished. */
  completedAt?: Date;
}

export interface CIStatus {
  /** Aggregate state across all checks. */
  state: CICheckState;
  /** Total number of checks. */
  totalCount: number;
  /** Number of checks currently failing or errored. */
  failingCount: number;
  /** Number of checks still running. */
  pendingCount: number;
  /** Detailed list (only failures and pending, by default). */
  checks: CICheck[];
}
