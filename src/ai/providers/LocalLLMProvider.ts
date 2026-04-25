/**
 * 本地 LLM 提供商
 * 使用 Ollama 本地模型服務
 */

import { AIProvider, AIProviderConfig, ReviewResult } from '../interfaces/AIProvider';
import axios from 'axios';

export class LocalLLMProvider extends AIProvider {
  private baseUrl: string;
  private availableModels: string[] = [];

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.baseUrl && !process.env.OLLAMA_BASE_URL) {
      throw new Error('baseUrl or OLLAMA_BASE_URL is required for Local LLM provider');
    }

    if (!this.config.model && !process.env.LOCAL_LLM_MODEL) {
      throw new Error('model or LOCAL_LLM_MODEL is required for Local LLM provider');
    }
  }

  /**
   * 初始化提供商
   */
  async initialize(): Promise<void> {
    try {
      this.baseUrl = this.config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

      // 測試連接
      const isConnected = await this.testConnection();
      if (!isConnected) {
        throw new Error(`Cannot connect to local LLM at ${this.baseUrl}`);
      }

      // 獲取可用模型
      await this.loadAvailableModels();
    } catch (error) {
      throw new Error(`Failed to initialize Local LLM provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取可用模型
   */
  private async loadAvailableModels(): Promise<void> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5000,
      });

      this.availableModels = response.data.models?.map((m: any) => m.name) || [];
    } catch (error) {
      console.warn('Failed to load available models from local LLM');
      this.availableModels = ['mistral', 'neural-chat', 'llama2'];
    }
  }

  /**
   * 審查代碼
   */
  async reviewCode(diff: string, files: string[], strictMode: boolean): Promise<ReviewResult> {
    try {
      const prompt = this.buildReviewPrompt(diff, files, strictMode);
      const model = this.config.model || process.env.LOCAL_LLM_MODEL || 'mistral';

      const response = await axios.post(
        `${this.baseUrl}/api/generate`,
        {
          model,
          prompt,
          stream: false,
          temperature: this.config.temperature || 0.7,
        },
        {
          timeout: this.config.timeout || 60000,
        }
      );

      const content = response.data.response;
      return this.parseResponse(content);
    } catch (error) {
      throw new Error(`Local LLM review failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5000,
      });

      return response.status === 200;
    } catch (error) {
      console.error('Local LLM connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取提供商名稱
   */
  getName(): string {
    return 'Local LLM (Ollama)';
  }

  /**
   * 獲取可用模型
   */
  async listModels(): Promise<string[]> {
    if (this.availableModels.length === 0) {
      await this.loadAvailableModels();
    }

    return this.availableModels;
  }

  /**
   * 獲取模型詳情
   */
  async getModelInfo(modelName: string): Promise<any> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/show`,
        {
          name: modelName,
        },
        {
          timeout: 5000,
        }
      );

      return response.data;
    } catch (error) {
      console.error(`Failed to get model info for ${modelName}:`, error);
      return null;
    }
  }

  /**
   * 拉取模型
   */
  async pullModel(modelName: string): Promise<void> {
    try {
      console.log(`Pulling model ${modelName}...`);

      const response = await axios.post(
        `${this.baseUrl}/api/pull`,
        {
          name: modelName,
          stream: false,
        },
        {
          timeout: 300000, // 5 分鐘超時
        }
      );

      console.log(`Model ${modelName} pulled successfully`);
    } catch (error) {
      throw new Error(`Failed to pull model ${modelName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
