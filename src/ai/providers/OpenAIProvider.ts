/**
 * OpenAI 提供商
 * OpenAI GPT API 實現
 */

import { AIProvider, AIProviderConfig, ReviewResult } from '../interfaces/AIProvider';

export class OpenAIProvider extends AIProvider {
  private client: any;
  private models: string[] = [
    'gpt-4-turbo-preview',
    'gpt-4',
    'gpt-3.5-turbo',
  ];

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.apiKey && !process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for OpenAI provider');
    }
  }

  /**
   * 初始化提供商
   */
  async initialize(): Promise<void> {
    try {
      const { OpenAI } = await import('openai');

      const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY;

      this.client = new OpenAI({
        apiKey,
        baseURL: this.config.baseUrl,
        timeout: this.config.timeout || 30000,
        maxRetries: this.config.retries || 3,
      });

      // 測試連接
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize OpenAI provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 審查代碼
   */
  async reviewCode(diff: string, files: string[], strictMode: boolean): Promise<ReviewResult> {
    try {
      const prompt = this.buildReviewPrompt(diff, files, strictMode);
      const model = this.config.model || 'gpt-4-turbo-preview';

      const response = await this.client.chat.completions.create({
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

      const content = response.choices[0].message.content;
      return this.parseResponse(content);
    } catch (error) {
      throw new Error(`OpenAI review failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-3.5-turbo',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'ping',
          },
        ],
      });

      return response.choices.length > 0;
    } catch (error) {
      console.error('OpenAI connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取提供商名稱
   */
  getName(): string {
    return 'OpenAI (GPT)';
  }

  /**
   * 獲取可用模型
   */
  async listModels(): Promise<string[]> {
    return this.models;
  }
}
