/**
 * AI 提供商基類接口
 * 所有 AI 提供商必須實現此接口
 */

export interface ReviewResult {
  passed: boolean;
  summary: string;
  issues: string[];
  suggestions: string[];
  severity: 'critical' | 'warning' | 'info';
  estimatedFixTime: number; // 分鐘
  metadata?: Record<string, any>;
}

export interface AIProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  retries?: number;
  [key: string]: any; // 其他特定提供商的配置
}

export abstract class AIProvider {
  protected config: AIProviderConfig;
  protected logger: any;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.validateConfig();
  }

  /**
   * 驗證配置
   */
  abstract validateConfig(): void;

  /**
   * 初始化提供商
   */
  abstract initialize(): Promise<void>;

  /**
   * 審查代碼
   */
  abstract reviewCode(diff: string, files: string[], strictMode: boolean): Promise<ReviewResult>;

  /**
   * 檢查連接是否有效
   */
  abstract testConnection(): Promise<boolean>;

  /**
   * 獲取提供商名稱
   */
  abstract getName(): string;

  /**
   * 獲取可用的模型列表
   */
  abstract listModels(): Promise<string[]>;

  /**
   * 構建審查提示詞
   */
  protected buildReviewPrompt(diff: string, files: string[], strictMode: boolean): string {
    const fileInfo = files.length > 0 ? `Files: ${files.join(', ')}` : 'Files: Unknown';
    const strictModifier = strictMode
      ? 'STRICT mode: Check everything including code style, performance, security, testing coverage.'
      : 'Check for: critical issues, security problems, code quality.';

    return `You are an expert code reviewer. Review the following code changes.

${strictModifier}

${fileInfo}

Code diff:
\`\`\`diff
${diff}
\`\`\`

Respond ONLY with valid JSON in this format:
{
  "passed": boolean,
  "summary": "string",
  "issues": ["issue 1", "issue 2"],
  "suggestions": ["suggestion 1"],
  "severity": "critical|warning|info",
  "estimatedFixTime": number
}`;
  }

  /**
   * 解析 AI 響應
   */
  protected parseResponse(content: string): ReviewResult {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Could not find JSON in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        passed: parsed.passed ?? false,
        summary: parsed.summary ?? 'Review complete',
        issues: parsed.issues ?? [],
        suggestions: parsed.suggestions ?? [],
        severity: parsed.severity ?? 'info',
        estimatedFixTime: parsed.estimatedFixTime ?? 5,
        metadata: parsed.metadata,
      };
    } catch (error) {
      throw new Error(`Failed to parse AI response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
