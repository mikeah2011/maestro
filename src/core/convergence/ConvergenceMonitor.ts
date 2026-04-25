/**
 * ConvergenceMonitor — mathematical termination guarantees for the review loop.
 *
 * Three invariants enforced:
 *   1. Monotone non-increasing: |criticals(n+1)| ≤ |criticals(n)|
 *   2. Jaccard(criticals_n, criticals_{n-1}) ≤ 0.7 — no oscillation
 *   3. No new finding category after round 2
 *
 * Hard cap: 3 rounds maximum. Any invariant violation returns a status
 * that the caller MUST act on (escalate / stop / notify).
 */

import { createHash } from 'crypto';

export type ConvergenceStatus =
  | 'converging'         // normal — continue iterating
  | 'clean'              // no critical findings — loop complete
  | 'oscillating'        // Jaccard > 0.7 — escalate to human
  | 'non_monotone'       // |criticals| increased — invariant violated
  | 'category_violation' // new category appeared after round 2
  | 'round_cap';         // hit the 3-round hard cap

export interface ConvergenceResult {
  status: ConvergenceStatus;
  round: number;
  criticalCount: number;
  previousCriticalCount?: number;
  /** Jaccard similarity with the previous round's critical set. */
  jaccard?: number;
  /** Categories that appeared for the first time after round 2. */
  newCategories?: ReadonlyArray<string>;
  message: string;
}

const MAX_ROUNDS = 3;
const OSCILLATION_THRESHOLD = 0.7;

export class ConvergenceMonitor {
  private readonly criticalHistory: Array<ReadonlySet<string>> = [];
  private readonly categoryHistory: Array<ReadonlySet<string>> = [];

  /**
   * Record a round's set of critical-finding hashes and return a convergence
   * decision. Call once per round, in order.
   */
  recordRound(round: number, criticalHashes: ReadonlySet<string>): ConvergenceResult {
    const criticalCount = criticalHashes.size;
    const prev = this.criticalHistory.at(-1);

    if (criticalCount === 0) {
      this.criticalHistory.push(criticalHashes);
      return {
        status: 'clean',
        round,
        criticalCount,
        message: 'No critical findings — loop complete.',
      };
    }

    if (round > MAX_ROUNDS) {
      this.criticalHistory.push(criticalHashes);
      return {
        status: 'round_cap',
        round,
        criticalCount,
        message: `Round cap of ${MAX_ROUNDS} reached — escalating to human.`,
      };
    }

    if (prev !== undefined) {
      const previousCriticalCount = prev.size;

      if (criticalCount > previousCriticalCount) {
        this.criticalHistory.push(criticalHashes);
        return {
          status: 'non_monotone',
          round,
          criticalCount,
          previousCriticalCount,
          message: `Critical count grew from ${previousCriticalCount} to ${criticalCount} — monotone invariant violated.`,
        };
      }

      const j = jaccardSimilarity(prev, criticalHashes);
      this.criticalHistory.push(criticalHashes);

      if (j > OSCILLATION_THRESHOLD) {
        return {
          status: 'oscillating',
          round,
          criticalCount,
          previousCriticalCount,
          jaccard: j,
          message: `Jaccard ${j.toFixed(3)} > ${OSCILLATION_THRESHOLD} — oscillation detected, escalating.`,
        };
      }

      return {
        status: 'converging',
        round,
        criticalCount,
        previousCriticalCount,
        jaccard: j,
        message: `Round ${round}: ${criticalCount} critical findings (Jaccard ${j.toFixed(3)}).`,
      };
    }

    this.criticalHistory.push(criticalHashes);
    return {
      status: 'converging',
      round,
      criticalCount,
      message: `Round ${round}: ${criticalCount} critical findings.`,
    };
  }

  /**
   * Record the set of finding categories seen in a round. Returns a
   * ConvergenceResult if a new category appears after round 2, otherwise null.
   */
  recordCategories(round: number, categories: ReadonlySet<string>): ConvergenceResult | null {
    this.categoryHistory.push(new Set(categories));

    if (round <= 2) return null;

    const baseline = new Set<string>();
    for (let i = 0; i < Math.min(2, this.categoryHistory.length - 1); i++) {
      const cats = this.categoryHistory[i];
      if (cats) {
        for (const cat of cats) {
          baseline.add(cat);
        }
      }
    }

    const newCategories = [...categories].filter((c) => !baseline.has(c));
    if (newCategories.length === 0) return null;

    return {
      status: 'category_violation',
      round,
      criticalCount: 0,
      newCategories,
      message: `New categories after round 2: ${newCategories.join(', ')} — invariant violated.`,
    };
  }

  /** Number of rounds recorded so far. */
  get roundCount(): number {
    return this.criticalHistory.length;
  }
}

// ─── Finding hash utilities ───────────────────────────────────────────────────

/**
 * Hash a surrounding code block for stable identity under paraphrase.
 * Use the 10 lines around a finding.
 */
export function computeContentHash(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/**
 * Convert a 1-based source line into a bucket of size 5.
 * Lines 1-5 → 0, 6-10 → 1, …
 * Stable under minor line shifts caused by rebases or small edits.
 */
export function lineBucket(line: number): number {
  return Math.floor((Math.max(1, line) - 1) / 5);
}

/**
 * Compute a stable finding hash.
 * sha1(file + NUL + line_bucket + NUL + normalized_category + NUL + content_hash)
 *
 * Stable under:
 *   - Paraphrase (uses content hash of surrounding code, not the comment text)
 *   - Line shift from rebase (uses line bucket not exact line)
 */
export function computeFindingHash(
  file: string,
  startLine: number | undefined,
  normalizedCategory: string,
  surroundingContent: string,
): string {
  const bucket = startLine !== undefined ? lineBucket(startLine) : -1;
  const contentHash = computeContentHash(surroundingContent);
  return createHash('sha1')
    .update(
      `${file}\x00${bucket}\x00${normalizedCategory.toLowerCase().trim()}\x00${contentHash}`,
    )
    .digest('hex');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
