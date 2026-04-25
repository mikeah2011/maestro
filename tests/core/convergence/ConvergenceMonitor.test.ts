import { describe, expect, it } from 'vitest';
import {
  ConvergenceMonitor,
  computeContentHash,
  computeFindingHash,
  lineBucket,
} from '../../../src/core/convergence/ConvergenceMonitor';

// ─── lineBucket ───────────────────────────────────────────────────────────────

describe('lineBucket', () => {
  it('maps lines 1-5 to bucket 0', () => {
    expect(lineBucket(1)).toBe(0);
    expect(lineBucket(3)).toBe(0);
    expect(lineBucket(5)).toBe(0);
  });

  it('maps lines 6-10 to bucket 1', () => {
    expect(lineBucket(6)).toBe(1);
    expect(lineBucket(10)).toBe(1);
  });

  it('is stable under minor line shifts within the same bucket', () => {
    expect(lineBucket(1)).toBe(lineBucket(2));
    expect(lineBucket(11)).toBe(lineBucket(14));
  });

  it('differs across buckets', () => {
    expect(lineBucket(5)).not.toBe(lineBucket(6));
    expect(lineBucket(10)).not.toBe(lineBucket(11));
  });
});

// ─── computeContentHash ───────────────────────────────────────────────────────

describe('computeContentHash', () => {
  it('is deterministic for the same content', () => {
    const content = 'const x = null;\nreturn x.value;';
    expect(computeContentHash(content)).toBe(computeContentHash(content));
  });

  it('differs for different content', () => {
    expect(computeContentHash('foo')).not.toBe(computeContentHash('bar'));
  });

  it('returns a 40-char hex string (sha1)', () => {
    expect(computeContentHash('test')).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ─── computeFindingHash ──────────────────────────────────────────────────────

describe('computeFindingHash', () => {
  const base = {
    file: 'src/auth/login.ts',
    startLine: 42,
    normalizedCategory: 'bug',
    surroundingContent: 'const user = getUser();\nif (user.role === admin) {',
  };

  it('is deterministic', () => {
    expect(computeFindingHash(base.file, base.startLine, base.normalizedCategory, base.surroundingContent)).toBe(
      computeFindingHash(base.file, base.startLine, base.normalizedCategory, base.surroundingContent),
    );
  });

  it('returns a 40-char hex sha1', () => {
    expect(computeFindingHash(base.file, base.startLine, base.normalizedCategory, base.surroundingContent)).toMatch(
      /^[0-9a-f]{40}$/,
    );
  });

  it('is stable under line shift within the same bucket (lines 1-5)', () => {
    const h1 = computeFindingHash(base.file, 1, base.normalizedCategory, base.surroundingContent);
    const h2 = computeFindingHash(base.file, 3, base.normalizedCategory, base.surroundingContent);
    const h5 = computeFindingHash(base.file, 5, base.normalizedCategory, base.surroundingContent);
    expect(h1).toBe(h2);
    expect(h2).toBe(h5);
  });

  it('differs across buckets', () => {
    const h5 = computeFindingHash(base.file, 5, base.normalizedCategory, base.surroundingContent);
    const h6 = computeFindingHash(base.file, 6, base.normalizedCategory, base.surroundingContent);
    expect(h5).not.toBe(h6);
  });

  it('normalizes category case', () => {
    const hLower = computeFindingHash(base.file, base.startLine, 'bug', base.surroundingContent);
    const hUpper = computeFindingHash(base.file, base.startLine, 'BUG', base.surroundingContent);
    expect(hLower).toBe(hUpper);
  });

  it('differs when file differs', () => {
    const h1 = computeFindingHash('src/a.ts', base.startLine, base.normalizedCategory, base.surroundingContent);
    const h2 = computeFindingHash('src/b.ts', base.startLine, base.normalizedCategory, base.surroundingContent);
    expect(h1).not.toBe(h2);
  });

  it('handles undefined startLine', () => {
    const hash = computeFindingHash(base.file, undefined, base.normalizedCategory, base.surroundingContent);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    // Differs from a defined line
    expect(hash).not.toBe(computeFindingHash(base.file, 1, base.normalizedCategory, base.surroundingContent));
  });
});

// ─── ConvergenceMonitor.recordRound ──────────────────────────────────────────

describe('ConvergenceMonitor — recordRound', () => {
  it('returns clean when no critical findings', () => {
    const m = new ConvergenceMonitor();
    const result = m.recordRound(1, new Set());
    expect(result.status).toBe('clean');
    expect(result.criticalCount).toBe(0);
  });

  it('returns converging for the first round with criticals', () => {
    const m = new ConvergenceMonitor();
    const result = m.recordRound(1, new Set(['h1', 'h2', 'h3']));
    expect(result.status).toBe('converging');
    expect(result.criticalCount).toBe(3);
    expect(result.jaccard).toBeUndefined();
  });

  it('returns converging and jaccard when criticals decrease', () => {
    const m = new ConvergenceMonitor();
    m.recordRound(1, new Set(['h1', 'h2', 'h3']));
    const result = m.recordRound(2, new Set(['h1']));
    expect(result.status).toBe('converging');
    expect(result.criticalCount).toBe(1);
    expect(result.previousCriticalCount).toBe(3);
    expect(result.jaccard).toBeCloseTo(1 / 3, 5); // intersection=1, union=3
  });

  it('detects oscillation when Jaccard > 0.7', () => {
    const m = new ConvergenceMonitor();
    m.recordRound(1, new Set(['h1', 'h2', 'h3']));
    // Same 3 hashes = Jaccard 1.0
    const result = m.recordRound(2, new Set(['h1', 'h2', 'h3']));
    expect(result.status).toBe('oscillating');
    expect(result.jaccard).toBeCloseTo(1.0, 5);
  });

  it('oscillation threshold is 0.7 (just above passes, just below does not)', () => {
    // 8 common + 1 different → Jaccard = 8/9 ≈ 0.889 → oscillating
    const round1 = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x']);
    const round2 = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'y']);

    const mOscillate = new ConvergenceMonitor();
    mOscillate.recordRound(1, round1);
    expect(mOscillate.recordRound(2, round2).status).toBe('oscillating');

    // 3 common out of 7 total → Jaccard ≈ 0.43 → converging
    const r1 = new Set(['a', 'b', 'c', 'd']);
    const r2 = new Set(['a', 'b', 'c', 'e', 'f', 'g']);

    const mConverge = new ConvergenceMonitor();
    mConverge.recordRound(1, r1);
    expect(mConverge.recordRound(2, r2).status).toBe('non_monotone'); // criticals grew
  });

  it('detects non-monotone when critical count increases', () => {
    const m = new ConvergenceMonitor();
    m.recordRound(1, new Set(['h1']));
    const result = m.recordRound(2, new Set(['h1', 'h2']));
    expect(result.status).toBe('non_monotone');
    expect(result.previousCriticalCount).toBe(1);
    expect(result.criticalCount).toBe(2);
  });

  it('returns round_cap after round MAX (3)', () => {
    const m = new ConvergenceMonitor();
    m.recordRound(1, new Set(['h1']));
    m.recordRound(2, new Set(['h1']));
    m.recordRound(3, new Set(['h1']));
    const result = m.recordRound(4, new Set(['h1']));
    expect(result.status).toBe('round_cap');
  });

  it('tracks roundCount correctly', () => {
    const m = new ConvergenceMonitor();
    expect(m.roundCount).toBe(0);
    m.recordRound(1, new Set(['h1']));
    expect(m.roundCount).toBe(1);
    m.recordRound(2, new Set(['h1']));
    expect(m.roundCount).toBe(2);
  });
});

// ─── ConvergenceMonitor.recordCategories ─────────────────────────────────────

describe('ConvergenceMonitor — recordCategories', () => {
  it('returns null for round 1', () => {
    const m = new ConvergenceMonitor();
    expect(m.recordCategories(1, new Set(['bug']))).toBeNull();
  });

  it('returns null for round 2', () => {
    const m = new ConvergenceMonitor();
    m.recordCategories(1, new Set(['bug']));
    expect(m.recordCategories(2, new Set(['bug', 'taste']))).toBeNull();
  });

  it('returns null when no new categories appear in round 3', () => {
    const m = new ConvergenceMonitor();
    m.recordCategories(1, new Set(['bug']));
    m.recordCategories(2, new Set(['taste']));
    expect(m.recordCategories(3, new Set(['bug', 'taste']))).toBeNull();
  });

  it('returns category_violation when a new category appears after round 2', () => {
    const m = new ConvergenceMonitor();
    m.recordCategories(1, new Set(['bug']));
    m.recordCategories(2, new Set(['bug']));
    const result = m.recordCategories(3, new Set(['bug', 'yagni']));
    expect(result).not.toBeNull();
    expect(result!.status).toBe('category_violation');
    expect(result!.newCategories).toContain('yagni');
  });

  it('reports multiple new categories', () => {
    const m = new ConvergenceMonitor();
    m.recordCategories(1, new Set(['bug']));
    m.recordCategories(2, new Set(['bug']));
    const result = m.recordCategories(3, new Set(['bug', 'yagni', 'wrong']));
    expect(result!.newCategories).toHaveLength(2);
  });
});

// ─── Jaccard edge cases ───────────────────────────────────────────────────────

describe('ConvergenceMonitor — Jaccard edge cases', () => {
  it('identical sets → Jaccard = 1.0 → oscillating', () => {
    const m = new ConvergenceMonitor();
    m.recordRound(1, new Set(['a']));
    const r = m.recordRound(2, new Set(['a']));
    expect(r.status).toBe('oscillating');
    expect(r.jaccard).toBe(1);
  });

  it('disjoint sets → Jaccard = 0 → converging (criticals decreased)', () => {
    const m = new ConvergenceMonitor();
    m.recordRound(1, new Set(['a', 'b']));
    // Different hashes but fewer: |criticals| dropped → converging
    const r = m.recordRound(2, new Set(['c']));
    expect(r.status).toBe('converging');
    expect(r.jaccard).toBe(0);
  });
});
