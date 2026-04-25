/**
 * Git 平台基類接口
 * 所有 Git 平台必須實現此接口
 */

export interface PRReviewComment {
  id: string;
  author: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PRInfo {
  id: string;
  number: number;
  title: string;
  description: string;
  state: 'open' | 'closed' | 'merged';
  branch: string;
  baseBranch: string;
  author: string;
  createdAt: Date;
  updatedAt: Date;
  url: string;
}

export interface GitDiff {
  files: string[];
  diff: string;
  stats: {
    additions: number;
    deletions: number;
    filesChanged: number;
  };
}

export interface GitPlatformConfig {
  baseUrl?: string;
  token?: string;
  owner?: string;
  repo?: string;
  [key: string]: any;
}

export abstract class GitPlatform {
  protected config: GitPlatformConfig;

  constructor(config: GitPlatformConfig) {
    this.config = config;
    this.validateConfig();
  }

  /**
   * 驗證配置
   */
  abstract validateConfig(): void;

  /**
   * 初始化平台
   */
  abstract initialize(): Promise<void>;

  /**
   * 獲取 PR 信息
   */
  abstract getPRInfo(prId: string | number): Promise<PRInfo>;

  /**
   * 獲取 PR 差異
   */
  abstract getPRDiff(prId: string | number): Promise<GitDiff>;

  /**
   * 添加 PR 評論
   */
  abstract addPRComment(prId: string | number, comment: string, event?: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void>;

  /**
   * 獲取 PR 評論
   */
  abstract getPRComments(prId: string | number): Promise<PRReviewComment[]>;

  /**
   * 合併 PR
   */
  abstract mergePR(prId: string | number, commitMessage?: string): Promise<void>;

  /**
   * 檢查連接是否有效
   */
  abstract testConnection(): Promise<boolean>;

  /**
   * 獲取平台名稱
   */
  abstract getName(): string;

  /**
   * 從遠程倉庫提取信息
   */
  abstract extractRepoInfo(): Promise<{ owner: string; repo: string }>;
}
