/**
 * AI provider abstraction.
 *
 * The orchestrator uses AI providers as a generic completion API. There is no
 * "review" method here — review logic lives in the orchestrator's prompts,
 * and providers are dumb pipes for prompt → completion.
 *
 * Per-stage routing (configured in `.maestro.yaml`) chooses which provider
 * + tier handles each phase: cheap models for high-volume ops, strong models
 * for judgment ops, flagship for final outputs. The provider does not pick
 * its own model; the caller passes a model + tier.
 */

export type ModelTier = 'cheap' | 'strong' | 'flagship';

export type AIProviderType = 'claude' | 'openai' | 'google' | 'local' | 'custom';

export interface AIProviderConfig {
  /** Resolved API key (after env-var expansion). */
  apiKey?: string;
  /** API base URL (set for self-hosted Ollama, GCP regions, etc.). */
  baseUrl?: string;
  /** Map of tier → model id for this provider. */
  models?: Partial<Record<ModelTier, string>>;
  /** Default tier when caller does not specify one. */
  defaultTier?: ModelTier;
  /** HTTP timeout in ms per request. */
  timeout?: number;
  /** Number of automatic retries on transient errors. */
  retries?: number;
  /** Provider-specific extras. */
  [key: string]: unknown;
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: Record<string, unknown> };

export interface CompletionOptions {
  /** Override the model for this call (otherwise resolved from tier). */
  model?: string;
  /** Tier to resolve to a model when `model` is not set. */
  tier?: ModelTier;
  /** System / instruction prompt prepended to the user prompt. */
  systemPrompt?: string;
  /** Token budget for the output. */
  maxTokens?: number;
  /** Temperature; default 0 for deterministic orchestrator decisions. */
  temperature?: number;
  /** Desired output shape. */
  responseFormat?: ResponseFormat;
  /** Stop sequences. */
  stopSequences?: string[];
  /** Per-call timeout override. */
  timeout?: number;
  /** Optional tag for cost attribution and audit logs. */
  callerTag?: string;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens read from prompt cache, when supported. */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache, when supported. */
  cacheWriteTokens?: number;
  /** Estimated USD cost for this call, when computable. */
  estimatedCostUsd?: number;
}

export type FinishReason =
  | 'stop'
  | 'max_tokens'
  | 'content_filter'
  | 'tool_use'
  | 'error';

export interface CompletionResult {
  /** Raw text content of the completion. */
  content: string;
  /** Model that actually produced the response (after tier resolution). */
  model: string;
  /** Token usage and cost. */
  usage: CompletionUsage;
  /** Why the model stopped generating. */
  finishReason: FinishReason;
  /** Parsed JSON, present when `responseFormat` was json/json_schema. */
  parsedJson?: unknown;
  /** Provider-native response, kept for audit/replay. */
  raw?: unknown;
}

export abstract class AIProvider {
  abstract readonly type: AIProviderType;

  protected readonly config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  /** Validate config and prepare HTTP/SDK clients. Idempotent. */
  abstract initialize(): Promise<void>;

  /** Lightweight connectivity check. */
  abstract testConnection(): Promise<boolean>;

  /** Resolve a tier → model id using `config.models` and provider defaults. */
  abstract resolveModel(tier: ModelTier): string;

  /** The orchestrator's only call-out: prompt → completion. */
  abstract complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
}
