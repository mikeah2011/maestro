import { describe, expect, it, vi } from 'vitest';
import { Classifier } from '../../../src/core/classify/Classifier';
import type { Finding, FindingClassification } from '../../../src/core/types/Finding';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    hash: 'deadbeef',
    bot: { login: 'coderabbitai', isBot: true },
    firstSeenRound: 1,
    lastSeenRound: 1,
    location: { file: 'src/utils/helper.ts', startLine: 10 },
    severity: 'medium',
    title: 'Some generic finding',
    body: 'Some generic body without any keywords.',
    ...overrides,
  };
}

// ─── Critical severity fence ──────────────────────────────────────────────────

describe('Classifier — critical severity fence', () => {
  it('classifies finding with rawSeverity "critical" as bug via fence', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding({ rawSeverity: 'critical' }));
    expect(result.category).toBe('bug');
    expect(result.viaFence).toBe(true);
    expect(result.fenceRule).toBe('critical_raw_severity');
    expect(result.confidence).toBe(1);
  });

  it('is case-insensitive for rawSeverity (CRITICAL, Blocker, ERROR)', async () => {
    for (const raw of ['CRITICAL', 'Blocker', 'ERROR', 'FATAL']) {
      const c = new Classifier();
      const result = await c.classify(makeFinding({ rawSeverity: raw }));
      expect(result.category).toBe('bug');
      expect(result.viaFence).toBe(true);
    }
  });

  it('classifies finding with normalized severity "critical" as bug', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding({ severity: 'critical' }));
    expect(result.category).toBe('bug');
    expect(result.viaFence).toBe(true);
    expect(result.fenceRule).toBe('critical_severity');
  });

  it('does NOT fire critical fence for severity "high"', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding({ severity: 'high', rawSeverity: 'high' }));
    // Should fall through to unknown (no LLM configured)
    expect(result.category).toBe('unknown');
    expect(result.viaFence).toBe(false);
  });
});

// ─── Sensitive path fence ─────────────────────────────────────────────────────

describe('Classifier — sensitive path fence', () => {
  it('classifies finding in /auth/ path as bug', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding({ location: { file: 'src/auth/login.ts' } }));
    expect(result.category).toBe('bug');
    expect(result.viaFence).toBe(true);
    expect(result.fenceRule).toContain('sensitive_path');
    expect(result.confidence).toBe(0.95);
  });

  it('classifies finding in /crypto/ path as bug', async () => {
    const c = new Classifier();
    const r = await c.classify(makeFinding({ location: { file: 'lib/crypto/aes.ts' } }));
    expect(r.category).toBe('bug');
  });

  it('classifies finding in /payment/ path as bug', async () => {
    const c = new Classifier();
    const r = await c.classify(makeFinding({ location: { file: 'services/payment/stripe.ts' } }));
    expect(r.category).toBe('bug');
  });

  it('does NOT fire for a path that does not match any sensitive pattern', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding({ location: { file: 'src/utils/format.ts' } }));
    expect(result.category).toBe('unknown'); // no LLM, falls through
  });
});

// ─── Bug keyword fence ────────────────────────────────────────────────────────

describe('Classifier — bug keyword fence', () => {
  const CASES: Array<[string, string]> = [
    ['null pointer dereference detected', 'null pointer'],
    ['NullPointerException in getUser()', 'nullpointerexception'],
    ['SQL injection vulnerability', 'sql injection'],
    ['Possible XSS via innerHTML', 'xss'],
    ['off-by-one error in loop bounds', 'off-by-one'],
    ['buffer overflow in memcpy call', 'buffer overflow'],
    ['race condition between threads', 'race condition'],
    ['potential deadlock detected', 'deadlock'],
  ];

  for (const [title, expectedKw] of CASES) {
    it(`detects bug keyword "${expectedKw}"`, async () => {
      const c = new Classifier();
      const result = await c.classify(
        makeFinding({ title, body: 'See title.', severity: 'high' }),
      );
      expect(result.category).toBe('bug');
      expect(result.viaFence).toBe(true);
      expect(result.fenceRule).toBe(`bug_keyword:${expectedKw}`);
      expect(result.confidence).toBe(0.9);
    });
  }

  it('also searches the body for bug keywords', async () => {
    const c = new Classifier();
    const result = await c.classify(
      makeFinding({ title: 'Check this line', body: 'This could cause a deadlock if lock order is reversed.' }),
    );
    expect(result.category).toBe('bug');
    expect(result.fenceRule).toBe('bug_keyword:deadlock');
  });
});

// ─── Taste keyword fence ──────────────────────────────────────────────────────

describe('Classifier — taste keyword fence', () => {
  it('classifies "nit:" prefix as taste', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding({ title: 'nit: rename this variable', body: '' }));
    expect(result.category).toBe('taste');
    expect(result.viaFence).toBe(true);
    expect(result.fenceRule).toBe('taste_keyword:nit:');
    expect(result.confidence).toBe(0.85);
  });

  it('classifies "cosmetic" finding as taste', async () => {
    const c = new Classifier();
    const r = await c.classify(makeFinding({ title: 'Cosmetic: move import to top', body: '' }));
    expect(r.category).toBe('taste');
  });

  it('detects taste keyword in body', async () => {
    const c = new Classifier();
    const r = await c.classify(
      makeFinding({ title: 'Naming suggestion', body: 'This is purely cosmetic but consider renaming.' }),
    );
    expect(r.category).toBe('taste');
  });
});

// ─── LLM fallback ─────────────────────────────────────────────────────────────

describe('Classifier — LLM fallback', () => {
  it('returns unknown when no fence fires and no LLM configured', async () => {
    const c = new Classifier();
    const result = await c.classify(makeFinding());
    expect(result.category).toBe('unknown');
    expect(result.viaFence).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('calls llmClassify when no fence fires', async () => {
    const llmResult: FindingClassification = {
      category: 'yagni',
      confidence: 0.7,
      viaFence: false,
      model: 'claude-haiku-4-5',
      reasoning: 'Out of scope for this PR',
    };
    const llm = vi.fn().mockResolvedValue(llmResult);
    const c = new Classifier({ llmClassify: llm });

    const finding = makeFinding();
    const result = await c.classify(finding);

    expect(llm).toHaveBeenCalledWith(finding);
    expect(result.category).toBe('yagni');
    expect(result.model).toBe('claude-haiku-4-5');
  });

  it('does NOT call LLM when fence fires', async () => {
    const llm = vi.fn();
    const c = new Classifier({ llmClassify: llm });
    await c.classify(makeFinding({ severity: 'critical' }));
    expect(llm).not.toHaveBeenCalled();
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe('Classifier — audit log', () => {
  it('calls onAudit for every classify() call', async () => {
    const audit = vi.fn();
    const c = new Classifier({ onAudit: audit });
    const finding = makeFinding({ severity: 'critical' });
    await c.classify(finding);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        findingHash: finding.hash,
        category: 'bug',
        viaFence: true,
      }),
    );
  });

  it('includes fenceRule in audit when fence fires', async () => {
    const audit = vi.fn();
    const c = new Classifier({ onAudit: audit });
    await c.classify(makeFinding({ rawSeverity: 'critical' }));
    expect(audit.mock.calls[0][0].fenceRule).toBe('critical_raw_severity');
  });

  it('includes model in audit for LLM results', async () => {
    const llmResult: FindingClassification = {
      category: 'bug',
      confidence: 0.8,
      viaFence: false,
      model: 'claude-opus-4-7',
    };
    const audit = vi.fn();
    const c = new Classifier({
      llmClassify: async () => llmResult,
      onAudit: audit,
    });
    await c.classify(makeFinding());
    expect(audit.mock.calls[0][0].model).toBe('claude-opus-4-7');
  });

  it('calls onAudit even for unknown (no LLM) results', async () => {
    const audit = vi.fn();
    const c = new Classifier({ onAudit: audit });
    await c.classify(makeFinding());
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0].category).toBe('unknown');
  });
});

// ─── runFence (unit) ──────────────────────────────────────────────────────────

describe('Classifier.runFence', () => {
  it('returns null when no fence rule fires', () => {
    const c = new Classifier();
    expect(c.runFence(makeFinding())).toBeNull();
  });

  it('prioritizes critical severity over sensitive path', () => {
    const c = new Classifier();
    const result = c.runFence(
      makeFinding({ severity: 'critical', location: { file: 'src/auth/login.ts' } }),
    );
    // critical_severity fires before sensitive_path
    expect(result!.fenceRule).toBe('critical_severity');
  });
});
