/**
 * ClaudeCodeProvider unit tests — child_process.spawn is fully mocked.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ClaudeCodeProvider } from '../../../src/ai/providers/ClaudeCodeProvider';

// ─── Mock child_process ────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface MockProcess {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

function makeProcess(overrides: Partial<MockProcess> = {}): MockProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  const proc: MockProcess = {
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    emit(event, ...args) {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
    ...overrides,
  };
  return proc;
}

/** Resolves with stdout text after the process emits close(0). */
function succeedWith(text: string): MockProcess {
  const proc = makeProcess();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(text));
    proc.emit('close', 0);
  }, 0);
  return proc;
}

/** Rejects: exits with non-zero code and optional stderr. */
function failWith(code: number, stderr = ''): MockProcess {
  const proc = makeProcess();
  setTimeout(() => {
    proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  }, 0);
  return proc;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ClaudeCodeProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── initialize() ────────────────────────────────────────────────────────────

  describe('initialize()', () => {
    it('calls claude --version to verify the binary exists', async () => {
      vi.mocked(spawn).mockReturnValue(succeedWith('1.0.0') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      expect(spawn).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
    });

    it('is idempotent — spawn called only once on double init', async () => {
      vi.mocked(spawn).mockReturnValue(succeedWith('1.0.0') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      await p.initialize();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('throws when claude binary is not found', async () => {
      const proc = makeProcess();
      setTimeout(() => proc.emit('error', new Error('ENOENT')), 0);
      vi.mocked(spawn).mockReturnValue(proc as never);
      const p = new ClaudeCodeProvider();
      await expect(p.initialize()).rejects.toThrow('ENOENT');
    });

    it('respects custom claudeBin option', async () => {
      vi.mocked(spawn).mockReturnValue(succeedWith('ok') as never);
      const p = new ClaudeCodeProvider({ claudeBin: '/usr/local/bin/claude' });
      await p.initialize();
      expect(spawn).toHaveBeenCalledWith('/usr/local/bin/claude', expect.any(Array), expect.any(Object));
    });
  });

  // ── testConnection() ────────────────────────────────────────────────────────

  describe('testConnection()', () => {
    it('returns true when claude responds', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('1.0.0') as never)  // initialize
        .mockReturnValueOnce(succeedWith('pong') as never);   // testConnection
      const p = new ClaudeCodeProvider();
      await p.initialize();
      expect(await p.testConnection()).toBe(true);
    });

    it('returns false when claude errors', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('1.0.0') as never)
        .mockReturnValueOnce(failWith(1, 'error') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      expect(await p.testConnection()).toBe(false);
    });
  });

  // ── resolveModel() ──────────────────────────────────────────────────────────

  describe('resolveModel()', () => {
    it('returns claude-code-cli by default', () => {
      expect(new ClaudeCodeProvider().resolveModel('strong')).toBe('claude-code-cli');
    });

    it('honours models config override', () => {
      const p = new ClaudeCodeProvider({ models: { strong: 'claude-opus-4-7' } });
      expect(p.resolveModel('strong')).toBe('claude-opus-4-7');
    });
  });

  // ── complete() ──────────────────────────────────────────────────────────────

  describe('complete()', () => {
    it('throws before initialize()', async () => {
      const p = new ClaudeCodeProvider();
      await expect(p.complete('hi')).rejects.toThrow('initialize()');
    });

    it('calls claude --print with the prompt', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('1.0.0') as never)
        .mockReturnValueOnce(succeedWith('hello world') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      await p.complete('say hello');
      expect(spawn).toHaveBeenLastCalledWith('claude', ['--print', 'say hello'], expect.any(Object));
    });

    it('prepends systemPrompt to the user prompt', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(succeedWith('answer') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      await p.complete('user ask', { systemPrompt: 'You are an assistant.' });
      const [, args] = vi.mocked(spawn).mock.calls[1]!;
      expect((args as string[])[1]).toContain('You are an assistant.');
      expect((args as string[])[1]).toContain('user ask');
    });

    it('returns content from stdout', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(succeedWith('  the answer  ') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      const result = await p.complete('q');
      expect(result.content).toBe('the answer');
    });

    it('parses JSON when responseFormat is json_object', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(succeedWith('Here is the result:\n{"canFix":true,"confidence":0.9}') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      const result = await p.complete('fix it', { responseFormat: { type: 'json_object' } });
      expect(result.parsedJson).toEqual({ canFix: true, confidence: 0.9 });
    });

    it('leaves parsedJson undefined when format is text', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(succeedWith('plain text') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      const result = await p.complete('q');
      expect(result.parsedJson).toBeUndefined();
    });

    it('reports model as claude-code-cli', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(succeedWith('answer') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      const result = await p.complete('q');
      expect(result.model).toBe('claude-code-cli');
    });

    it('reports zero token usage', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(succeedWith('answer') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      const result = await p.complete('q');
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });

    it('rejects when claude exits non-zero', async () => {
      vi.mocked(spawn)
        .mockReturnValueOnce(succeedWith('ok') as never)
        .mockReturnValueOnce(failWith(1, 'rate limited') as never);
      const p = new ClaudeCodeProvider();
      await p.initialize();
      await expect(p.complete('q')).rejects.toThrow('rate limited');
    });
  });
});
