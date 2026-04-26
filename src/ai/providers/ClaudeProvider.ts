/**
 * ClaudeProvider — concrete AIProvider using the Anthropic Messages API.
 *
 * Uses axios (already a dependency) rather than the Anthropic SDK to keep
 * the install footprint small. Retry is handled by p-retry.
 *
 * Model tier defaults:
 *   cheap    → claude-haiku-4-5-20251001
 *   strong   → claude-sonnet-4-6
 *   flagship → claude-opus-4-7
 */

import axios, { type AxiosInstance } from 'axios';
import retry from 'p-retry';
import type {
  AIProviderConfig,
  CompletionOptions,
  CompletionResult,
  FinishReason,
  ModelTier,
} from '../interfaces/AIProvider';
import { AIProvider } from '../interfaces/AIProvider';

// ─── Model catalogue ──────────────────────────────────────────────────────────

const DEFAULT_MODELS: Record<ModelTier, string> = {
  cheap: 'claude-haiku-4-5-20251001',
  strong: 'claude-sonnet-4-6',
  flagship: 'claude-opus-4-7',
};

/** Approximate USD per 1M tokens (input / output). */
const COST_PER_1M: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7': { input: 15.00, output: 75.00 },
};

// ─── Anthropic API response shape ─────────────────────────────────────────────

interface AnthropicContent {
  type: 'text' | string;
  text?: string;
}

interface AnthropicResponse {
  content: AnthropicContent[];
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const STOP_REASON_MAP: Record<string, FinishReason> = {
  end_turn: 'stop',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop',
  tool_use: 'tool_use',
};

// ─── ClaudeProvider ───────────────────────────────────────────────────────────

export class ClaudeProvider extends AIProvider {
  readonly type = 'claude' as const;
  private client: AxiosInstance | null = null;

  async initialize(): Promise<void> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('ClaudeProvider: config.apiKey is required (set ANTHROPIC_API_KEY)');
    }

    this.client = axios.create({
      baseURL: (this.config.baseUrl as string | undefined) ?? 'https://api.anthropic.com',
      timeout: (this.config.timeout as number | undefined) ?? 60_000,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.complete('ping', { maxTokens: 1, tier: 'cheap' });
      return true;
    } catch {
      return false;
    }
  }

  resolveModel(tier: ModelTier): string {
    return (this.config.models as Record<ModelTier, string> | undefined)?.[tier]
      ?? DEFAULT_MODELS[tier];
  }

  async complete(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
    if (!this.client) throw new Error('ClaudeProvider.initialize() must be called first');

    const model = options.model ?? this.resolveModel(
      options.tier ?? (this.config.defaultTier as ModelTier | undefined) ?? 'strong',
    );
    const maxTokens = options.maxTokens ?? 4096;
    const temperature = options.temperature ?? 0;
    const maxRetries = (this.config.retries as number | undefined) ?? 3;

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    };

    if (options.systemPrompt) body.system = options.systemPrompt;
    if (options.stopSequences?.length) body.stop_sequences = options.stopSequences;

    const raw = await retry<AnthropicResponse>(
      async () => {
        const res = await this.client!.post<AnthropicResponse>('/v1/messages', body);
        return res.data;
      },
      {
        retries: maxRetries,
        minTimeout: 1_000,
        maxTimeout: 30_000,
        shouldRetry: (err: unknown) => {
          if (axios.isAxiosError(err)) {
            const status = err.response?.status ?? 0;
            return status === 429 || status >= 500;
          }
          return false;
        },
      },
    );

    const content = raw.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    const costTable = COST_PER_1M[raw.model ?? model];
    const estimatedCostUsd = costTable
      ? (raw.usage.input_tokens / 1_000_000) * costTable.input
        + (raw.usage.output_tokens / 1_000_000) * costTable.output
      : undefined;

    let parsedJson: unknown;
    if (
      options.responseFormat?.type === 'json_object' ||
      options.responseFormat?.type === 'json_schema'
    ) {
      try { parsedJson = JSON.parse(content); } catch { /* leave undefined */ }
    }

    return {
      content,
      model: raw.model,
      usage: {
        inputTokens: raw.usage.input_tokens,
        outputTokens: raw.usage.output_tokens,
        cacheReadTokens: raw.usage.cache_read_input_tokens,
        cacheWriteTokens: raw.usage.cache_creation_input_tokens,
        estimatedCostUsd,
      },
      finishReason: STOP_REASON_MAP[raw.stop_reason] ?? 'stop',
      parsedJson,
      raw,
    };
  }
}
