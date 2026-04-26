/**
 * ClaudeProvider unit tests — all HTTP calls are intercepted by vi.mock.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ClaudeProvider } from '../../../src/ai/providers/ClaudeProvider';

// Mock axios.create so we control the HTTP layer
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      create: vi.fn(),
      isAxiosError: actual.default.isAxiosError,
    },
  };
});

function makeAnthropicResponse(overrides: Partial<{
  text: string;
  model: string;
  stop_reason: string;
  input_tokens: number;
  output_tokens: number;
}> = {}) {
  return {
    content: [{ type: 'text', text: overrides.text ?? 'hello' }],
    model: overrides.model ?? 'claude-sonnet-4-6',
    stop_reason: overrides.stop_reason ?? 'end_turn',
    usage: {
      input_tokens: overrides.input_tokens ?? 10,
      output_tokens: overrides.output_tokens ?? 5,
    },
  };
}

function makeClient(postImpl?: () => Promise<unknown>) {
  const mockPost = vi.fn(postImpl ?? (async () => ({ data: makeAnthropicResponse() })));
  const mockClient = { post: mockPost };
  vi.mocked(axios.create).mockReturnValue(mockClient as unknown as ReturnType<typeof axios.create>);
  return { mockPost, mockClient };
}

describe('ClaudeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize()', () => {
    it('throws when apiKey is missing', async () => {
      const p = new ClaudeProvider({});
      await expect(p.initialize()).rejects.toThrow('apiKey is required');
    });

    it('creates axios client with correct headers', async () => {
      makeClient();
      const p = new ClaudeProvider({ apiKey: 'test-key' });
      await p.initialize();

      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.anthropic.com',
          headers: expect.objectContaining({ 'x-api-key': 'test-key' }),
        }),
      );
    });

    it('respects custom baseUrl', async () => {
      makeClient();
      const p = new ClaudeProvider({ apiKey: 'k', baseUrl: 'https://my-proxy.example.com' });
      await p.initialize();

      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://my-proxy.example.com' }),
      );
    });
  });

  describe('resolveModel()', () => {
    it('returns default models for each tier', () => {
      const p = new ClaudeProvider({ apiKey: 'k' });
      expect(p.resolveModel('cheap')).toBe('claude-haiku-4-5-20251001');
      expect(p.resolveModel('strong')).toBe('claude-sonnet-4-6');
      expect(p.resolveModel('flagship')).toBe('claude-opus-4-7');
    });

    it('honours config.models overrides', () => {
      const p = new ClaudeProvider({
        apiKey: 'k',
        models: { cheap: 'my-cheap', strong: 'my-strong', flagship: 'my-flagship' },
      });
      expect(p.resolveModel('cheap')).toBe('my-cheap');
    });
  });

  describe('complete()', () => {
    it('throws before initialize is called', async () => {
      const p = new ClaudeProvider({ apiKey: 'k' });
      await expect(p.complete('hi')).rejects.toThrow('initialize()');
    });

    it('posts to /v1/messages and maps response correctly', async () => {
      const { mockPost } = makeClient(async () => ({
        data: makeAnthropicResponse({ text: 'world', input_tokens: 8, output_tokens: 3 }),
      }));

      const p = new ClaudeProvider({ apiKey: 'k' });
      await p.initialize();
      const result = await p.complete('hello');

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/messages',
        expect.objectContaining({ messages: [{ role: 'user', content: 'hello' }] }),
      );
      expect(result.content).toBe('world');
      expect(result.usage.inputTokens).toBe(8);
      expect(result.usage.outputTokens).toBe(3);
      expect(result.finishReason).toBe('stop');
    });

    it('includes systemPrompt in request body', async () => {
      const { mockPost } = makeClient();
      const p = new ClaudeProvider({ apiKey: 'k' });
      await p.initialize();
      await p.complete('prompt', { systemPrompt: 'You are X.' });

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/messages',
        expect.objectContaining({ system: 'You are X.' }),
      );
    });

    it('parses JSON when responseFormat is json_object', async () => {
      makeClient(async () => ({
        data: makeAnthropicResponse({ text: '{"a":1}' }),
      }));

      const p = new ClaudeProvider({ apiKey: 'k' });
      await p.initialize();
      const result = await p.complete('q', { responseFormat: { type: 'json_object' } });

      expect(result.parsedJson).toEqual({ a: 1 });
    });

    it('computes estimated cost for known models', async () => {
      makeClient(async () => ({
        data: makeAnthropicResponse({
          model: 'claude-sonnet-4-6',
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
        }),
      }));

      const p = new ClaudeProvider({ apiKey: 'k' });
      await p.initialize();
      const result = await p.complete('q');

      // sonnet-4-6: $3/M input + $15/M output = $18
      expect(result.usage.estimatedCostUsd).toBeCloseTo(18, 1);
    });

    it('selects model by tier', async () => {
      const { mockPost } = makeClient();
      const p = new ClaudeProvider({ apiKey: 'k' });
      await p.initialize();
      await p.complete('q', { tier: 'cheap' });

      expect(mockPost).toHaveBeenCalledWith(
        '/v1/messages',
        expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
      );
    });
  });
});
