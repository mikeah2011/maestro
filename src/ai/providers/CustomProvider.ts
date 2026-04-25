/**
 * 自定義 API 提供商
 * 用於任何自定義或第三方 LLM API
 */

import { AIProvider, AIProviderConfig, ReviewResult } from '../interfaces/AIProvider';
import axios from 'axios';

export interface CustomAPIConfig extends AIProviderConfig {
  endpointUrl: string; // API 端點
  requestFormat?: 'openai' | 'anthropic' | 'generic'; // 請求格式
  responseParser?: (response: any) => string; // 自定義響應解析器
}

export class CustomProvider extends AIProvider {
  private config: CustomAPIConfig;

  constructor(config: AIProviderConfig) {
    super(config);
    this.config = config as CustomAPIConfig;
  }

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.endpointUrl) {
      throw new Error('endpointUrl is required for Custom provider');
    }

    if (!this.config.apiKey && !process.env.CUSTOM_API_KEY) {
      throw new Error('apiKey or CUSTOM_API_KEY is required for Custom provider');
    }
  }

  /**
   * 初始化提供商
   */
  async initialize(): Promise<void> {
    try {
      // 測試連接
      const isConnected = await this.testConnection();
      if (!isConnected) {
        throw new Error(`Cannot connect to custom API at ${this.config.endpointUrl}`);
      }
    } catch (error) {
      throw new Error(`Failed to initialize Custom provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 審查代碼
   */
  async reviewCode(diff: string, files: string[], strictMode: boolean): Promise<ReviewResult> {
    try {
      const prompt = this.buildReviewPrompt(diff, files, strictMode);
      const format = this.config.requestFormat || 'generic';

      let payload: any;

      // 根據格式構建請求
      switch (format) {
        case 'openai':
          payload = {
            model: this.config.model || 'gpt-4',
            messages: [{ role: 'user', content: prompt }],
            temperature: this.config.temperature || 0.7,
            max_tokens: this.config.maxTokens || 2000,
          };
          break;

        case 'anthropic':
          payload = {
            model: this.config.model || 'claude-opus-4-20250805',
            max_tokens: this.config.maxTokens || 2000,
            messages: [{ role: 'user', content: prompt }],
          };
          break;

        default:
          payload = {
            prompt,
            model: this.config.model,
            temperature: this.config.temperature || 0.7,
            max_tokens: this.config.maxTokens || 2000,
          };
      }

      const response = await axios.post(this.config.endpointUrl, payload, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey || process.env.CUSTOM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: this.config.timeout || 30000,
      });

      // 使用自定義解析器或默認解析
      let content: string;

      if (this.config.responseParser) {
        content = this.config.responseParser(response.data);
      } else {
        // 嘗試通用解析
        content =
          response.data.choices?.[0]?.message?.content ||
          response.data.choices?.[0]?.text ||
          response.data.content?.[0]?.text ||
          response.data.result ||
          response.data.text ||
          '';
      }

      return this.parseResponse(content);
    } catch (error) {
      throw new Error(`Custom API review failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.post(
        this.config.endpointUrl,
        { test: true },
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey || process.env.CUSTOM_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        }
      );

      return response.status === 200 || response.status === 201;
    } catch (error) {
      console.error('Custom API connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取提供商名稱
   */
  getName(): string {
    return 'Custom API';
  }

  /**
   * 獲取可用模型
   */
  async listModels(): Promise<string[]> {
    // 自定義 API 可能不支持此功能
    return [this.config.model || 'custom-model'];
  }
}
