/**
 * Claude AI 提供商
 * Anthropic Claude API 實現
 */

import { AIProvider, AIProviderConfig, ReviewResult } from '../interfaces/AIProvider';

export class ClaudeProvider extends AIProvider {
  private client: any;
  private models: string[] = [
    'claude-opus-4-20250805',
    'claude-sonnet-4-20250514',
    'claude-haiku-3-5-20241022',
  ];

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.apiKey && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required for Claude provider');
    }
  }

  /**
   * 初始化提供商
   */
  async initialize(): Promise<void> {
    try {
      const { Anthropic } = await import('@anthropic-ai/sdk');

      const apiKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;

      this.client = new Anthropic({
        apiKey,
        baseURL: this.config.baseUrl,
        timeout: this.config.timeout || 30000,
        maxRetries: this.config.retries || 3,
      });

      // 測試連接
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize Claude provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 審查代碼
   */
  async reviewCode(diff: string, files: string[], strictMode: boolean): Promise<ReviewResult> {
    try {
      const prompt = this.buildReviewPrompt(diff, files, strictMode);
      const model = this.config.model || 'claude-opus-4-20250805';

      const response = await this.client.messages.create({
        model,
        max_tokens: this.config.maxTokens || 2000,
        temperature: this.config.temperature || 0.7,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0].type === 'text' ? response.content[0].text : '';
      return this.parseResponse(content);
    } catch (error) {
      throw new Error(`Claude review failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.messages.create({
        model: 'claude-opus-4-20250805',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'ping',
          },
        ],
      });

      return response.content.length > 0;
    } catch (error) {
      console.error('Claude connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取提供商名稱
   */
  getName(): string {
    return 'Claude (Anthropic)';
  }

  /**
   * 獲取可用模型
   */
  async listModels(): Promise<string[]> {
    return this.models;
  }
}
