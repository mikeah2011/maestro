import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Dedup, levenshtein, normalizedSimilarity } from '../../../src/core/dedup/Dedup';
import type { Finding } from '../../../src/core/types/Finding';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _nextHash = 0;
function uniqueHash(): string {
  return `hash-${++_nextHash}`;
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    hash: uniqueHash(),
    bot: { login: 'coderabbitai', isBot: true },
    firstSeenRound: 1,
    lastSeenRound: 1,
    location: { file: 'src/utils/helper.ts', startLine: 10 },
    severity: 'medium',
    title: 'Generic finding title',
    body: 'Generic body.',
    ...overrides,
  };
}

// ─── levenshtein ─────────────────────────────────────────────────────────────

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns length of b for empty a', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('returns length of a for empty b', () => {
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('computes single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  it('computes single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  it('computes single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
  });

  it('computes known multi-edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('saturday', 'sunday')).toBe(3);
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(levenshtein(a, b)).toBe(levenshtein(b, a));
      }),
    );
  });

  it('satisfies triangle inequality', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b, c) => {
        const ab = levenshtein(a, b);
        const bc = levenshtein(b, c);
        const ac = levenshtein(a, c);
        expect(ac).toBeLessThanOrEqual(ab + bc);
      }),
    );
  });
});

// ─── normalizedSimilarity ─────────────────────────────────────────────────────

describe('normalizedSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(normalizedSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 1 for case-insensitive match', () => {
    expect(normalizedSimilarity('Hello', 'hello')).toBe(1);
  });

  it('returns 1 for two empty strings', () => {
    expect(normalizedSimilarity('', '')).toBe(1);
  });

  it('returns a value in [0, 1]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const sim = normalizedSimilarity(a, b);
        expect(sim).toBeGreaterThanOrEqual(0);
        expect(sim).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(normalizedSimilarity(a, b)).toBeCloseTo(normalizedSimilarity(b, a), 10);
      }),
    );
  });

  it('is less than 1 for clearly different strings', () => {
    expect(normalizedSimilarity('null pointer dereference', 'stripe api key leak')).toBeLessThan(0.5);
  });

  it('is high for strings with minor edits', () => {
    // One char difference in 18-19 chars → similarity ≈ 0.94
    expect(normalizedSimilarity('Missing null check', 'Missing null checks')).toBeGreaterThan(0.9);
  });
});

// ─── Dedup — tier 1 (exact hash) ─────────────────────────────────────────────

describe('Dedup — tier 1 exact hash', () => {
  it('returns all findings when no duplicates', async () => {
    const dedup = new Dedup();
    const findings = [
      makeFinding({ title: 'SQL injection in login endpoint' }),
      makeFinding({ title: 'Buffer overflow in image parser' }),
      makeFinding({ title: 'Race condition in thread pool' }),
    ];
    const result = await dedup.deduplicate(findings);
    expect(result.unique).toHaveLength(3);
    expect(result.duplicates.size).toBe(0);
    expect(result.tierStats.exact).toBe(0);
  });

  it('kills duplicate with same hash', async () => {
    const dedup = new Dedup();
    const canonical = makeFinding({ hash: 'same-hash', title: 'Null pointer' });
    const dup = makeFinding({ hash: 'same-hash', title: 'Null pointer' });
    const result = await dedup.deduplicate([canonical, dup]);
    expect(result.unique).toHaveLength(1);
    expect(result.tierStats.exact).toBe(1);
    expect(result.duplicates.get('same-hash')).toBe('same-hash');
  });

  it('first occurrence is the canonical', async () => {
    const dedup = new Dedup();
    const first = makeFinding({ hash: 'dup-hash', title: 'First' });
    const second = makeFinding({ hash: 'dup-hash', title: 'Second' });
    const result = await dedup.deduplicate([first, second]);
    expect(result.unique[0]).toBe(first);
  });

  it('handles multiple exact duplicates of the same hash', async () => {
    const dedup = new Dedup();
    const f1 = makeFinding({ hash: 'h', title: 'A' });
    const f2 = makeFinding({ hash: 'h', title: 'B' });
    const f3 = makeFinding({ hash: 'h', title: 'C' });
    const result = await dedup.deduplicate([f1, f2, f3]);
    expect(result.unique).toHaveLength(1);
    expect(result.tierStats.exact).toBe(2);
  });
});

// ─── Dedup — tier 2 (fuzzy title) ────────────────────────────────────────────

describe('Dedup — tier 2 fuzzy title', () => {
  it('kills near-duplicate titles above fuzzy threshold', async () => {
    const dedup = new Dedup({ fuzzyThreshold: 0.8 });
    const canonical = makeFinding({ title: 'Missing null check in getUser()' });
    const fuzzyDup = makeFinding({ title: 'Missing null check in getUser' }); // very similar

    const result = await dedup.deduplicate([canonical, fuzzyDup]);
    expect(result.unique).toHaveLength(1);
    expect(result.tierStats.fuzzy).toBe(1);
    expect(result.duplicates.get(fuzzyDup.hash)).toBe(canonical.hash);
  });

  it('keeps distinct titles below fuzzy threshold', async () => {
    const dedup = new Dedup({ fuzzyThreshold: 0.8 });
    const f1 = makeFinding({ title: 'SQL injection in search endpoint' });
    const f2 = makeFinding({ title: 'Missing authentication on admin route' });
    const result = await dedup.deduplicate([f1, f2]);
    expect(result.unique).toHaveLength(2);
    expect(result.tierStats.fuzzy).toBe(0);
  });

  it('respects custom fuzzyThreshold', async () => {
    const dedup = new Dedup({ fuzzyThreshold: 0.99 }); // very strict
    const f1 = makeFinding({ title: 'Missing null check' });
    const f2 = makeFinding({ title: 'Missing null checks' }); // only 1 char diff → might still be below 0.99
    const result = await dedup.deduplicate([f1, f2]);
    // "Missing null check" vs "Missing null checks" — 1 char diff in 18 → sim ≈ 0.944 → below 0.99
    expect(result.unique).toHaveLength(2);
  });
});

// ─── Dedup — tier 3 (LLM) ────────────────────────────────────────────────────

describe('Dedup — tier 3 LLM', () => {
  it('calls llmSimilar for findings that pass tiers 1 and 2', async () => {
    const llmSimilar = vi.fn().mockResolvedValue(true);
    const dedup = new Dedup({ llmSimilar, fuzzyThreshold: 0.99 });

    const f1 = makeFinding({ title: 'SQL injection in login form' });
    const f2 = makeFinding({ title: 'User input not sanitized on login page' }); // semantically similar but different text

    const result = await dedup.deduplicate([f1, f2]);

    expect(llmSimilar).toHaveBeenCalledWith(f2, f1);
    expect(result.unique).toHaveLength(1);
    expect(result.tierStats.llm).toBe(1);
  });

  it('does NOT call llmSimilar when not configured', async () => {
    const dedup = new Dedup({ fuzzyThreshold: 0.99 });
    const f1 = makeFinding({ title: 'Alpha finding' });
    const f2 = makeFinding({ title: 'Beta finding' });
    const result = await dedup.deduplicate([f1, f2]);
    expect(result.llmCallsUsed).toBe(0);
    expect(result.unique).toHaveLength(2);
  });

  it('respects maxLlmCalls cap', async () => {
    const llmSimilar = vi.fn().mockResolvedValue(false);
    const dedup = new Dedup({ llmSimilar, maxLlmCalls: 2, fuzzyThreshold: 0.99 });

    // 5 unique findings → up to 4 LLM comparisons needed, but capped at 2
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ title: `Finding number ${i + 1} with unique text` }),
    );

    const result = await dedup.deduplicate(findings);
    expect(result.llmCallsUsed).toBeLessThanOrEqual(2);
  });

  it('tracks llmCallsUsed correctly', async () => {
    const llmSimilar = vi.fn().mockResolvedValue(false); // never similar
    const dedup = new Dedup({ llmSimilar, maxLlmCalls: 10, fuzzyThreshold: 0.99 });

    const findings = [
      makeFinding({ title: 'Alpha unique' }),
      makeFinding({ title: 'Beta unique' }),
      makeFinding({ title: 'Gamma unique' }),
    ];
    const result = await dedup.deduplicate(findings);
    // 2nd finding: compare to 1st (1 call). 3rd: compare to 1st + 2nd (2 calls). Total = 3.
    expect(result.llmCallsUsed).toBe(3);
  });
});

// ─── Property tests ───────────────────────────────────────────────────────────

describe('Dedup — property: idempotence', () => {
  it('deduplicating the unique set again yields the same unique set', async () => {
    const dedup = new Dedup({ fuzzyThreshold: 0.8 });
    const findings = [
      makeFinding({ hash: 'h1', title: 'Finding A' }),
      makeFinding({ hash: 'h1', title: 'Finding A dup' }), // same hash
      makeFinding({ hash: 'h2', title: 'Finding B' }),
    ];
    const first = await dedup.deduplicate(findings);
    const second = await dedup.deduplicate(first.unique);
    expect(second.unique.map((f) => f.hash)).toEqual(first.unique.map((f) => f.hash));
    expect(second.duplicates.size).toBe(0);
  });
});

describe('Dedup — property: output ⊆ input', () => {
  it('every unique finding was in the input', async () => {
    const dedup = new Dedup();
    const findings = Array.from({ length: 5 }, () => makeFinding());
    const result = await dedup.deduplicate(findings);
    const inputHashes = new Set(findings.map((f) => f.hash));
    for (const u of result.unique) {
      expect(inputHashes.has(u.hash)).toBe(true);
    }
  });
});
