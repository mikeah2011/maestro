/**
 * ClaudeCodeProvider — AIProvider backed by the `claude --print` CLI.
 *
 * No ANTHROPIC_API_KEY required. Delegates to the locally-installed Claude
 * Code CLI binary, which carries its own session credentials. Ideal for
 * developer machines that already have Claude Code set up.
 *
 * Limitations vs ClaudeProvider:
 *   - Token usage is always reported as 0 (CLI does not expose usage).
 *   - No cost estimation.
 *   - Model is always reported as 'claude-code-cli' (unknown at runtime).
 *   - System prompts are prepended to the user prompt (no native system role).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { AIProvider } from '../interfaces/AIProvider';
import type {
  AIProviderConfig,
  AIProviderType,
  CompletionOptions,
  CompletionResult,
  ModelTier,
} from '../interfaces/AIProvider';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ClaudeCodeProviderOptions extends AIProviderConfig {
  /** Path to the claude binary. Default: 'claude' (resolved from PATH). */
  claudeBin?: string;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class ClaudeCodeProvider extends AIProvider {
  readonly type: AIProviderType = 'claude';

  private readonly claudeBin: string;
  private readonly defaultTimeoutMs: number;
  private initialized = false;

  constructor(opts: ClaudeCodeProviderOptions = {}) {
    super(opts);
    this.claudeBin = opts.claudeBin ?? 'claude';
    this.defaultTimeoutMs = (opts.timeout as number | undefined) ?? 120_000;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.exec(['--version'], 10_000);
    this.initialized = true;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.exec(['--print', 'ping'], 15_000);
      return true;
    } catch {
      return false;
    }
  }

  resolveModel(_tier: ModelTier): string {
    return this.config.models?.[_tier] ?? 'claude-code-cli';
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    if (!this.initialized) throw new Error('Call initialize() before complete()');

    const fullPrompt = options?.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;

    const timeoutMs = options?.timeout ?? this.defaultTimeoutMs;
    const raw = await this.exec(['--print', fullPrompt], timeoutMs);

    let parsedJson: unknown;
    const fmt = options?.responseFormat?.type;
    if (fmt === 'json_object' || fmt === 'json_schema') {
      parsedJson = extractJson(raw);
    }

    return {
      content: raw,
      model: 'claude-code-cli',
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: 'stop',
      parsedJson,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Spawns the claude binary, collects stdout, rejects on non-zero exit. */
  exec(args: string[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.claudeBin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }

      const out: Buffer[] = [];
      const err: Buffer[] = [];

      child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(out).toString('utf8').trim());
        } else {
          const stderr = Buffer.concat(err).toString('utf8').trim();
          reject(new Error(`claude exited ${code ?? 'null'}: ${stderr}`));
        }
      });
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the outermost JSON object from a string that may contain prose. */
function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}
