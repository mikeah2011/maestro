/**
 * 配置系統
 * 支持 YAML、JSON、環境變數、互動式配置
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { ProviderType } from '../ai/AIProviderFactory';
import { PlatformType } from '../platforms/GitPlatformFactory';

export interface ReviewRule {
  name: string;
  enabled: boolean;
  providers?: ProviderType[];
  provider?: ProviderType;
  model?: string;
  strictMode?: boolean;
}

export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  [key: string]: any;
}

export interface PlatformConfig {
  type: PlatformType;
  baseUrl?: string;
  token?: string;
  owner?: string;
  repo?: string;
  [key: string]: any;
}

export interface AppConfig {
  // AI 配置
  ai: {
    defaultProvider: ProviderType;
    providers: Record<ProviderType, Partial<ProviderConfig>>;
  };

  // Git 平台配置
  platform: {
    type: PlatformType;
    config: PlatformConfig;
  };

  // 審查規則
  review: {
    rules: ReviewRule[];
    strictMode: boolean;
    autoFix: boolean;
    autoApprove: boolean;
  };

  // 其他配置
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'text';
  };

  [key: string]: any;
}

export class ConfigManager {
  private config: AppConfig;
  private configPaths: string[] = [
    '.gitai-review.yaml',
    '.gitai-review.yml',
    '.gitai-review.json',
    'gitai-review.config.ts',
  ];

  constructor() {
    this.config = this.getDefaultConfig();
  }

  /**
   * 加載配置
   */
  async load(configPath?: string): Promise<void> {
    try {
      const path = configPath || this.findConfigFile();

      if (!path) {
        console.warn('No config file found, using defaults');
        return;
      }

      console.log(`Loading config from ${path}`);

      const fileConfig = await this.loadConfigFile(path);
      this.merge(fileConfig);

      // 從環境變數覆蓋
      this.loadFromEnv();
    } catch (error) {
      throw new Error(`Failed to load config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 尋找配置文件
   */
  private findConfigFile(): string | null {
    for (const p of this.configPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * 加載配置文件
   */
  private async loadConfigFile(configPath: string): Promise<Partial<AppConfig>> {
    const ext = path.extname(configPath).toLowerCase();

    if (ext === '.yaml' || ext === '.yml') {
      const content = fs.readFileSync(configPath, 'utf-8');
      return yaml.load(content) as Partial<AppConfig>;
    } else if (ext === '.json') {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } else if (ext === '.ts') {
      // 動態加載 TypeScript 配置
      const config = await import(path.resolve(configPath));
      return config.default || config;
    }

    throw new Error(`Unsupported config file format: ${ext}`);
  }

  /**
   * 從環境變數加載配置
   */
  private loadFromEnv(): void {
    // AI 配置
    if (process.env.AI_PROVIDER) {
      this.config.ai.defaultProvider = process.env.AI_PROVIDER as ProviderType;
    }

    if (process.env.ANTHROPIC_API_KEY) {
      this.config.ai.providers.claude = {
        apiKey: process.env.ANTHROPIC_API_KEY,
      };
    }

    if (process.env.OPENAI_API_KEY) {
      this.config.ai.providers.openai = {
        apiKey: process.env.OPENAI_API_KEY,
      };
    }

    if (process.env.GOOGLE_API_KEY) {
      this.config.ai.providers.google = {
        apiKey: process.env.GOOGLE_API_KEY,
      };
    }

    // 平台配置
    if (process.env.GIT_PLATFORM) {
      this.config.platform.type = process.env.GIT_PLATFORM as PlatformType;
    }

    if (process.env.GITHUB_TOKEN) {
      this.config.platform.config.token = process.env.GITHUB_TOKEN;
    }

    // 審查配置
    if (process.env.STRICT_MODE === 'true') {
      this.config.review.strictMode = true;
    }

    if (process.env.LOG_LEVEL) {
      this.config.logging.level = process.env.LOG_LEVEL as any;
    }
  }

  /**
   * 合併配置
   */
  private merge(fileConfig: Partial<AppConfig>): void {
    this.config = {
      ...this.config,
      ...fileConfig,
      ai: {
        ...this.config.ai,
        ...(fileConfig.ai || {}),
        providers: {
          ...this.config.ai.providers,
          ...(fileConfig.ai?.providers || {}),
        },
      },
      platform: {
        ...this.config.platform,
        ...(fileConfig.platform || {}),
        config: {
          ...this.config.platform.config,
          ...(fileConfig.platform?.config || {}),
        },
      },
      review: {
        ...this.config.review,
        ...(fileConfig.review || {}),
      },
      logging: {
        ...this.config.logging,
        ...(fileConfig.logging || {}),
      },
    };
  }

  /**
   * 保存配置
   */
  save(format: 'yaml' | 'json' = 'yaml'): void {
    const filename = format === 'yaml' ? '.gitai-review.yaml' : '.gitai-review.json';

    let content: string;

    if (format === 'yaml') {
      content = yaml.dump(this.config, { indent: 2 });
    } else {
      content = JSON.stringify(this.config, null, 2);
    }

    fs.writeFileSync(filename, content);
    console.log(`Config saved to ${filename}`);
  }

  /**
   * 獲取配置值
   */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  /**
   * 設置配置值
   */
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.config[key] = value;
  }

  /**
   * 獲取完整配置
   */
  getConfig(): AppConfig {
    return this.config;
  }

  /**
   * 獲取默認配置
   */
  private getDefaultConfig(): AppConfig {
    return {
      ai: {
        defaultProvider: 'claude',
        providers: {
          claude: {
            type: 'claude',
            model: 'claude-opus-4-20250805',
            maxTokens: 2000,
            temperature: 0.7,
          },
          openai: {
            type: 'openai',
            model: 'gpt-4-turbo-preview',
            maxTokens: 2000,
            temperature: 0.7,
          },
          google: {
            type: 'google',
            model: 'gemini-2.0-flash',
            maxTokens: 2000,
            temperature: 0.7,
          },
          local: {
            type: 'local',
            baseUrl: 'http://localhost:11434',
            model: 'mistral',
            maxTokens: 2000,
            temperature: 0.7,
          },
          custom: {
            type: 'custom',
            endpointUrl: '',
            requestFormat: 'generic',
          },
        },
      },

      platform: {
        type: 'github',
        config: {
          type: 'github',
          baseUrl: 'https://api.github.com',
        },
      },

      review: {
        rules: [
          {
            name: 'Security Check',
            enabled: true,
            providers: ['claude'],
            strictMode: true,
          },
          {
            name: 'Code Quality',
            enabled: true,
            provider: 'claude',
            strictMode: false,
          },
        ],
        strictMode: false,
        autoFix: false,
        autoApprove: false,
      },

      logging: {
        level: 'info',
        format: 'text',
      },
    };
  }
}

/**
 * 全局配置實例
 */
export const configManager = new ConfigManager();
