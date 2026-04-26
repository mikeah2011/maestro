/**
 * FixEngine unit tests — filesystem and AI provider are fully injected.
 */

import { describe, expect, it, vi } from 'vitest';
import { FixEngine } from '../../../src/core/fix/FixEngine';
import type { FixEngineOptions } from '../../../src/core/fix/FixEngine';
import type { AIProvider, CompletionResult } from '../../../src/ai/interfaces/AIProvider';
import type { Finding } from '../../../src/core/types/Finding';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    hash: 'abc123',
    bot: { login: 'coderabbitai', isBot: true },
    firstSeenRound: 1,
    lastSeenRound: 1,
    location: { file: 'src/auth.ts', startLine: 5 },
    severity: 'critical',
    title: 'Null dereference on user.profile',
    body: 'Accessing user.profile without a null check may throw at runtime.',
    ...overrides,
  };
}

function makeCompletionResult(parsedJson: unknown): CompletionResult {
  return {
    content: JSON.stringify(parsedJson),
    model: 'claude-sonnet-4-6',
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: 'stop',
    parsedJson,
  };
}

function makeProvider(
  completeFn?: () => Promise<CompletionResult>,
): AIProvider {
  return {
    type: 'claude',
    initialize: vi.fn(),
    testConnection: vi.fn(async () => true),
    resolveModel: vi.fn(() => 'claude-sonnet-4-6'),
    complete: vi.fn(completeFn ?? (async () => makeCompletionResult({
      canFix: true,
      confidence: 0.9,
      description: 'Added null guard',
      replacements: [{ startLine: 5, endLine: 5, newContent: 'if (user) return user.profile;' }],
    }))),
  } as unknown as AIProvider;
}

function makeOpts(overrides: Partial<FixEngineOptions> = {}): FixEngineOptions {
  const fileStore: Record<string, string> = {
    '/repo/src/auth.ts': [
      'import { db } from "./db";',
      '',
      'export async function getProfile(userId: string) {',
      '  const user = await db.findUser(userId);',
      '  return user.profile;',  // line 5
      '}',
    ].join('\n'),
  };

  return {
    provider: makeProvider(),
    repoRoot: '/repo',
    readFile: vi.fn(async (path: string) => {
      const content = fileStore[path];
      if (!content) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
    writeFile: vi.fn(async () => {}),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FixEngine', () => {
  describe('fix()', () => {
    it('returns [] for empty findings list', async () => {
      const engine = new FixEngine(makeOpts());
      expect(await engine.fix([], 1)).toEqual([]);
    });

    it('skips finding with no file', async () => {
      const engine = new FixEngine(makeOpts());
      const finding = makeFinding({ location: { file: '' } });
      expect(await engine.fix([finding], 1)).toEqual([]);
    });

    it('skips finding when file cannot be read', async () => {
      const opts = makeOpts();
      vi.mocked(opts.readFile!).mockRejectedValue(new Error('ENOENT'));
      const engine = new FixEngine(opts);
      expect(await engine.fix([makeFinding()], 1)).toEqual([]);
    });

    it('calls provider.complete with file context in the prompt', async () => {
      const opts = makeOpts();
      const engine = new FixEngine(opts);
      await engine.fix([makeFinding()], 1);

      const call = vi.mocked(opts.provider.complete).mock.calls[0];
      expect(call).toBeDefined();
      const [prompt] = call!;
      expect(prompt).toContain('src/auth.ts');
      expect(prompt).toContain('Null dereference');
    });

    it('returns FixResult with description and files on success', async () => {
      const engine = new FixEngine(makeOpts());
      const results = await engine.fix([makeFinding()], 1);

      expect(results).toHaveLength(1);
      expect(results[0]?.findingHash).toBe('abc123');
      expect(results[0]?.description).toBe('Added null guard');
      expect(results[0]?.files).toEqual(['src/auth.ts']);
    });

    it('writes modified file content to disk', async () => {
      const opts = makeOpts();
      const engine = new FixEngine(opts);
      await engine.fix([makeFinding()], 1);

      expect(opts.writeFile).toHaveBeenCalledWith(
        '/repo/src/auth.ts',
        expect.stringContaining('if (user) return user.profile;'),
      );
    });

    it('returns null when canFix is false', async () => {
      const opts = makeOpts({
        provider: makeProvider(async () => makeCompletionResult({ canFix: false })),
      });
      const engine = new FixEngine(opts);
      expect(await engine.fix([makeFinding()], 1)).toEqual([]);
    });

    it('skips fix when confidence is below minConfidence', async () => {
      const opts = makeOpts({
        provider: makeProvider(async () => makeCompletionResult({
          canFix: true,
          confidence: 0.5,
          replacements: [{ startLine: 5, endLine: 5, newContent: 'fixed' }],
        })),
      });
      const engine = new FixEngine(opts);
      expect(await engine.fix([makeFinding()], 1)).toEqual([]);
    });

    it('honours custom minConfidence', async () => {
      const opts = makeOpts({
        minConfidence: 0.4,
        provider: makeProvider(async () => makeCompletionResult({
          canFix: true,
          confidence: 0.45,
          description: 'Fixed',
          replacements: [{ startLine: 5, endLine: 5, newContent: 'fixed' }],
        })),
      });
      const engine = new FixEngine(opts);
      const results = await engine.fix([makeFinding()], 1);
      expect(results).toHaveLength(1);
    });

    it('returns [] when provider throws', async () => {
      const opts = makeOpts({
        provider: makeProvider(async () => { throw new Error('rate limited'); }),
      });
      const engine = new FixEngine(opts);
      expect(await engine.fix([makeFinding()], 1)).toEqual([]);
    });

    it('applies multiple replacements in reverse line order', async () => {
      const opts = makeOpts({
        provider: makeProvider(async () => makeCompletionResult({
          canFix: true,
          confidence: 0.95,
          description: 'Two fixes',
          // intentionally out of order — engine must sort
          replacements: [
            { startLine: 3, endLine: 3, newContent: 'FIXED_LINE_3' },
            { startLine: 5, endLine: 5, newContent: 'FIXED_LINE_5' },
          ],
        })),
      });
      const engine = new FixEngine(opts);
      await engine.fix([makeFinding()], 1);

      const written = (vi.mocked(opts.writeFile!).mock.calls[0] as [string, string])[1];
      expect(written).toContain('FIXED_LINE_3');
      expect(written).toContain('FIXED_LINE_5');
    });

    it('falls back to title when description is absent', async () => {
      const opts = makeOpts({
        provider: makeProvider(async () => makeCompletionResult({
          canFix: true,
          confidence: 0.9,
          replacements: [{ startLine: 5, endLine: 5, newContent: 'fixed' }],
        })),
      });
      const engine = new FixEngine(opts);
      const [result] = await engine.fix([makeFinding()], 1);
      expect(result?.description).toContain('Null dereference');
    });

    it('processes multiple findings and returns all successful fixes', async () => {
      const findings = [
        makeFinding({ hash: 'h1', location: { file: 'src/auth.ts', startLine: 5 } }),
        makeFinding({ hash: 'h2', location: { file: 'src/auth.ts', startLine: 5 } }),
      ];

      const opts = makeOpts();
      const engine = new FixEngine(opts);
      const results = await engine.fix(findings, 1);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.findingHash)).toEqual(['h1', 'h2']);
    });
  });
});
