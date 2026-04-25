/**
 * Git 平台工廠
 * 負責創建和管理不同的 Git 平台實例
 */

import { GitPlatform, GitPlatformConfig } from './interfaces/GitPlatform';
import { GitHubPlatform } from './providers/GitHubPlatform';
import { GitLabPlatform } from './providers/GitLabPlatform';
import { GiteaPlatform } from './providers/GiteaPlatform';
import { GiteePlatform } from './providers/GiteePlatform';

export type PlatformType = 'github' | 'gitlab' | 'gitea' | 'gitee';

export interface PlatformFactory {
  type: PlatformType;
  config: GitPlatformConfig;
}

export class GitPlatformFactory {
  private static platforms: Map<PlatformType, typeof GitPlatform> = new Map([
    ['github', GitHubPlatform as any],
    ['gitlab', GitLabPlatform as any],
    ['gitea', GiteaPlatform as any],
    ['gitee', GiteePlatform as any],
  ]);

  private static instances: Map<string, GitPlatform> = new Map();

  /**
   * 創建或獲取平台實例
   */
  static async create(type: PlatformType, config: GitPlatformConfig): Promise<GitPlatform> {
    const key = `${type}:${config.baseUrl || 'default'}:${config.owner}:${config.repo}`;

    // 檢查緩存
    if (this.instances.has(key)) {
      return this.instances.get(key)!;
    }

    const PlatformClass = this.platforms.get(type);

    if (!PlatformClass) {
      throw new Error(`Unknown Git platform: ${type}. Available: ${Array.from(this.platforms.keys()).join(', ')}`);
    }

    const instance = new PlatformClass(config) as GitPlatform;
    await instance.initialize();

    this.instances.set(key, instance);
    return instance;
  }

  /**
   * 從 Git 遠程推斷平台類型
   */
  static async detectPlatformType(gitRemoteUrl: string): Promise<PlatformType> {
    if (gitRemoteUrl.includes('github.com')) {
      return 'github';
    } else if (gitRemoteUrl.includes('gitlab.com')) {
      return 'gitlab';
    } else if (gitRemoteUrl.includes('gitee.com')) {
      return 'gitee';
    } else if (gitRemoteUrl.includes('gitea')) {
      return 'gitea';
    } else {
      throw new Error(`Cannot detect platform type from remote URL: ${gitRemoteUrl}`);
    }
  }

  /**
   * 註冊自定義平台
   */
  static register(type: PlatformType, platformClass: typeof GitPlatform): void {
    this.platforms.set(type, platformClass as any);
  }

  /**
   * 獲取可用平台列表
   */
  static listPlatforms(): PlatformType[] {
    return Array.from(this.platforms.keys());
  }

  /**
   * 獲取平台詳細信息
   */
  static async getPlatformInfo(type: PlatformType): Promise<{
    name: string;
    baseUrl?: string;
    requiredConfig: string[];
  }> {
    const PlatformClass = this.platforms.get(type);

    if (!PlatformClass) {
      throw new Error(`Unknown platform: ${type}`);
    }

    // 創建臨時實例獲取信息
    const tempInstance = new PlatformClass({}) as GitPlatform;

    return {
      name: tempInstance.getName(),
      baseUrl: type === 'github' ? 'https://github.com' : undefined,
      requiredConfig: ['token', 'owner', 'repo'],
    };
  }

  /**
   * 清除所有緩存
   */
  static clearCache(): void {
    this.instances.clear();
  }

  /**
   * 清除特定平台的緩存
   */
  static clearPlatformCache(type: PlatformType): void {
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
 * 快速創建平台實例
 */
export async function createGitPlatform(type: PlatformType, config?: Partial<GitPlatformConfig>): Promise<GitPlatform> {
  return GitPlatformFactory.create(type, (config || {}) as GitPlatformConfig);
}
