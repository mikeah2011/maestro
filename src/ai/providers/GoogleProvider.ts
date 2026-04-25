/**
 * Google Gemini 提供商
 * Google Gemini API 實現
 */

import { AIProvider, AIProviderConfig, ReviewResult } from '../interfaces/AIProvider';

export class GoogleProvider extends AIProvider {
  private client: any;
  private models: string[] = [
    'gemini-2.0-flash',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ];

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.apiKey && !process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required for Google provider');
    }
  }

  /**
   * 初始化提供商
   */
  async initialize(): Promise<void> {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');

      const apiKey = this.config.apiKey || process.env.GOOGLE_API_KEY;

      this.client = new GoogleGenerativeAI(apiKey);

      // 測試連接
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize Google provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 審查代碼
   */
  async reviewCode(diff: string, files: string[], strictMode: boolean): Promise<ReviewResult> {
    try {
      const prompt = this.buildReviewPrompt(diff, files, strictMode);
      const model = this.config.model || 'gemini-2.0-flash';

      const generativeModel = this.client.getGenerativeModel({
        model,
        generationConfig: {
          maxOutputTokens: this.config.maxTokens || 2000,
          temperature: this.config.temperature || 0.7,
        },
      });

      const response = await generativeModel.generateContent(prompt);
      const content = response.response.text();

      return this.parseResponse(content);
    } catch (error) {
      throw new Error(`Google review failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      const generativeModel = this.client.getGenerativeModel({
        model: 'gemini-2.0-flash',
      });

      const response = await generativeModel.generateContent('ping');
      return response.response.text().length > 0;
    } catch (error) {
      console.error('Google connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取提供商名稱
   */
  getName(): string {
    return 'Google Gemini';
  }

  /**
   * 獲取可用模型
   */
  async listModels(): Promise<string[]> {
    return this.models;
  }
}
