/**
 * AI 提供商工廠
 * 負責創建和管理不同的 AI 提供商實例
 */

import { AIProvider, AIProviderConfig, ReviewResult } from './interfaces/AIProvider';
import { ClaudeProvider } from './providers/ClaudeProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { GoogleProvider } from './providers/GoogleProvider';
import { LocalLLMProvider } from './providers/LocalLLMProvider';
import { CustomProvider } from './providers/CustomProvider';

export type ProviderType = 'claude' | 'openai' | 'google' | 'local' | 'custom';

export interface ProviderFactory {
  type: ProviderType;
  config: AIProviderConfig;
}

export class AIProviderFactory {
  private static providers: Map<ProviderType, typeof AIProvider> = new Map([
    ['claude', ClaudeProvider as any],
    ['openai', OpenAIProvider as any],
    ['google', GoogleProvider as any],
    ['local', LocalLLMProvider as any],
    ['custom', CustomProvider as any],
  ]);

  private static instances: Map<string, AIProvider> = new Map();

  /**
   * 創建或獲取提供商實例
   */
  static async create(type: ProviderType, config: AIProviderConfig): Promise<AIProvider> {
    const key = `${type}:${JSON.stringify(config)}`;

    // 檢查緩存
    if (this.instances.has(key)) {
      return this.instances.get(key)!;
    }

    const ProviderClass = this.providers.get(type);

    if (!ProviderClass) {
      throw new Error(`Unknown AI provider: ${type}. Available: ${Array.from(this.providers.keys()).join(', ')}`);
    }

    const instance = new ProviderClass(config) as AIProvider;
    await instance.initialize();

    this.instances.set(key, instance);
    return instance;
  }

  /**
   * 註冊自定義提供商
   */
  static register(type: ProviderType, providerClass: typeof AIProvider): void {
    this.providers.set(type, providerClass as any);
  }

  /**
   * 獲取可用的提供商列表
   */
  static listProviders(): ProviderType[] {
    return Array.from(this.providers.keys());
  }

  /**
   * 獲取提供商詳細信息
   */
  static async getProviderInfo(type: ProviderType): Promise<{
    name: string;
    models: string[];
    config: Record<string, any>;
  }> {
    const ProviderClass = this.providers.get(type);

    if (!ProviderClass) {
      throw new Error(`Unknown provider: ${type}`);
    }

    // 創建臨時實例獲取信息
    const tempInstance = new ProviderClass({}) as AIProvider;

    return {
      name: tempInstance.getName(),
      models: await tempInstance.listModels(),
      config: {
        // 返回每個提供商需要的配置選項
      },
    };
  }

  /**
   * 清除所有緩存
   */
  static clearCache(): void {
    this.instances.clear();
  }

  /**
   * 清除特定提供商的緩存
   */
  static clearProviderCache(type: ProviderType): void {
    const toDelete: string[] = [];

    for (const key of this.instances.keys()) {
      if (key.startsWith(`${type}:`)) {
        toDelete.push(key);
      }
    }

    toDelete.forEach(key => this.instances.delete(key));
  }
}

/**
 * 快速創建提供商
 */
export async function createAIProvider(type: ProviderType, config?: Partial<AIProviderConfig>): Promise<AIProvider> {
  return AIProviderFactory.create(type, (config || {}) as AIProviderConfig);
}
