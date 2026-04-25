/**
 * GitLab 平台實現
 */

import { GitPlatform, GitPlatformConfig, PRInfo, GitDiff, PRReviewComment } from '../interfaces/GitPlatform';
import axios, { AxiosInstance } from 'axios';

export class GitLabPlatform extends GitPlatform {
  private client: AxiosInstance;
  private projectId: string = '';

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.token && !process.env.GITLAB_TOKEN) {
      throw new Error('GITLAB_TOKEN is required for GitLab platform');
    }
  }

  /**
   * 初始化平台
   */
  async initialize(): Promise<void> {
    try {
      const token = this.config.token || process.env.GITLAB_TOKEN;
      const baseUrl = this.config.baseUrl || 'https://gitlab.com/api/v4';

      this.client = axios.create({
        baseURL: baseUrl,
        headers: {
          'PRIVATE-TOKEN': token,
        },
      });

      // 構建 projectId
      if (this.config.owner && this.config.repo) {
        this.projectId = `${this.config.owner}%2F${this.config.repo}`;
      }

      // 測試連接
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize GitLab platform: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取 MR（Merge Request）信息
   */
  async getPRInfo(mrNumber: string | number): Promise<PRInfo> {
    try {
      const response = await this.client.get(`/projects/${this.projectId}/merge_requests/${mrNumber}`);

      const data = response.data;

      return {
        id: String(data.id),
        number: data.iid,
        title: data.title,
        description: data.description || '',
        state: data.state as 'open' | 'closed' | 'merged',
        branch: data.source_branch,
        baseBranch: data.target_branch,
        author: data.author?.username || 'unknown',
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at),
        url: data.web_url,
      };
    } catch (error) {
      throw new Error(`Failed to get MR info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取 MR 差異
   */
  async getPRDiff(mrNumber: string | number): Promise<GitDiff> {
    try {
      const response = await this.client.get(`/projects/${this.projectId}/merge_requests/${mrNumber}/changes`);

      const changes = response.data.changes || [];

      return {
        files: changes.map((change: any) => change.new_path || change.old_path),
        diff: changes.map((change: any) => change.diff).join('\n'),
        stats: {
          additions: response.data.changes?.reduce((sum: number, change: any) => sum + (change.additions || 0), 0) || 0,
          deletions: response.data.changes?.reduce((sum: number, change: any) => sum + (change.deletions || 0), 0) || 0,
          filesChanged: changes.length,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get MR diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 添加 MR 評論
   */
  async addPRComment(mrNumber: string | number, comment: string): Promise<void> {
    try {
      await this.client.post(`/projects/${this.projectId}/merge_requests/${mrNumber}/notes`, {
        body: comment,
      });
    } catch (error) {
      throw new Error(`Failed to add MR comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取 MR 評論
   */
  async getPRComments(mrNumber: string | number): Promise<PRReviewComment[]> {
    try {
      const response = await this.client.get(`/projects/${this.projectId}/merge_requests/${mrNumber}/notes`);

      return response.data.map((note: any) => ({
        id: String(note.id),
        author: note.author?.username || 'unknown',
        content: note.body,
        createdAt: new Date(note.created_at),
        updatedAt: new Date(note.updated_at),
      }));
    } catch (error) {
      throw new Error(`Failed to get MR comments: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 合併 MR
   */
  async mergePR(mrNumber: string | number): Promise<void> {
    try {
      await this.client.put(`/projects/${this.projectId}/merge_requests/${mrNumber}/merge`, {
        squash: true,
      });
    } catch (error) {
      throw new Error(`Failed to merge MR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.get(`/projects/${this.projectId}`);
      return true;
    } catch (error) {
      console.error('GitLab connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取平台名稱
   */
  getName(): string {
    return 'GitLab';
  }

  /**
   * 從遠程倉庫提取信息
   */
  async extractRepoInfo(): Promise<{ owner: string; repo: string }> {
    try {
      const git = await import('simple-git');
      const simpleGit = git.default();

      const remotes = await simpleGit.getRemotes();
      const origin = remotes.find(r => r.name === 'origin');

      if (origin) {
        const match = origin.refs.fetch.match(/gitlab\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
        if (match) {
          return {
            owner: match[1],
            repo: match[2],
          };
        }
      }

      throw new Error('Could not extract GitLab repo info from git remote');
    } catch (error) {
      throw new Error(`Failed to extract repo info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
