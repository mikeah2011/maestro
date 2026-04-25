/**
 * Gitea 和 Gitee 平台實現
 */

import { GitPlatform, GitPlatformConfig, PRInfo, GitDiff, PRReviewComment } from '../interfaces/GitPlatform';
import axios, { AxiosInstance } from 'axios';

/**
 * Gitea 平台 (自託管 Git)
 */
export class GiteaPlatform extends GitPlatform {
  private client: AxiosInstance;

  validateConfig(): void {
    if (!this.config.token && !process.env.GITEA_TOKEN) {
      throw new Error('GITEA_TOKEN is required for Gitea platform');
    }
    if (!this.config.baseUrl && !process.env.GITEA_BASE_URL) {
      throw new Error('baseUrl or GITEA_BASE_URL is required for Gitea platform');
    }
  }

  async initialize(): Promise<void> {
    try {
      const baseUrl = (this.config.baseUrl || process.env.GITEA_BASE_URL || '').replace(/\/$/, '');
      const token = this.config.token || process.env.GITEA_TOKEN;

      this.client = axios.create({
        baseURL: `${baseUrl}/api/v1`,
        headers: {
          'Authorization': `token ${token}`,
        },
      });

      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize Gitea platform: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPRInfo(prNumber: string | number): Promise<PRInfo> {
    try {
      const response = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`
      );

      const data = response.data;

      return {
        id: String(data.id),
        number: data.number,
        title: data.title,
        description: data.body || '',
        state: data.state as 'open' | 'closed' | 'merged',
        branch: data.head.ref,
        baseBranch: data.base.ref,
        author: data.user?.login || 'unknown',
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at),
        url: data.html_url,
      };
    } catch (error) {
      throw new Error(`Failed to get PR info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPRDiff(prNumber: string | number): Promise<GitDiff> {
    try {
      const prResponse = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`
      );

      const diffResponse = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}.patch`
      );

      return {
        files: [], // Gitea 的 diff 格式需要解析
        diff: diffResponse.data,
        stats: {
          additions: prResponse.data.additions || 0,
          deletions: prResponse.data.deletions || 0,
          filesChanged: prResponse.data.changed_files || 0,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get PR diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addPRComment(prNumber: string | number, comment: string): Promise<void> {
    try {
      await this.client.post(
        `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`,
        { body: comment }
      );
    } catch (error) {
      throw new Error(`Failed to add PR comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPRComments(prNumber: string | number): Promise<PRReviewComment[]> {
    try {
      const response = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`
      );

      return response.data.map((comment: any) => ({
        id: String(comment.id),
        author: comment.user?.login || 'unknown',
        content: comment.body,
        createdAt: new Date(comment.created_at),
        updatedAt: new Date(comment.updated_at),
      }));
    } catch (error) {
      throw new Error(`Failed to get PR comments: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async mergePR(prNumber: string | number): Promise<void> {
    try {
      await this.client.post(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/merge`
      );
    } catch (error) {
      throw new Error(`Failed to merge PR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.get(`/repos/${this.config.owner}/${this.config.repo}`);
      return true;
    } catch (error) {
      console.error('Gitea connection test failed:', error);
      return false;
    }
  }

  getName(): string {
    return 'Gitea';
  }

  async extractRepoInfo(): Promise<{ owner: string; repo: string }> {
    throw new Error('Gitea requires explicit owner and repo configuration');
  }
}

/**
 * Gitee 平台 (碼雲)
 */
export class GiteePlatform extends GitPlatform {
  private client: AxiosInstance;

  validateConfig(): void {
    if (!this.config.token && !process.env.GITEE_TOKEN) {
      throw new Error('GITEE_TOKEN is required for Gitee platform');
    }
  }

  async initialize(): Promise<void> {
    try {
      const token = this.config.token || process.env.GITEE_TOKEN;

      this.client = axios.create({
        baseURL: 'https://gitee.com/api/v5',
        params: {
          access_token: token,
        },
      });

      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize Gitee platform: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPRInfo(prNumber: string | number): Promise<PRInfo> {
    try {
      const response = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}`
      );

      const data = response.data;

      return {
        id: String(data.id),
        number: data.number,
        title: data.title,
        description: data.body || '',
        state: data.state as 'open' | 'closed' | 'merged',
        branch: data.head.ref,
        baseBranch: data.base.ref,
        author: data.user?.login || 'unknown',
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at),
        url: data.html_url,
      };
    } catch (error) {
      throw new Error(`Failed to get PR info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPRDiff(prNumber: string | number): Promise<GitDiff> {
    try {
      const response = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}.patch`
      );

      return {
        files: [],
        diff: response.data,
        stats: {
          additions: 0,
          deletions: 0,
          filesChanged: 0,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get PR diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addPRComment(prNumber: string | number, comment: string): Promise<void> {
    try {
      await this.client.post(
        `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`,
        { body: comment }
      );
    } catch (error) {
      throw new Error(`Failed to add PR comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getPRComments(prNumber: string | number): Promise<PRReviewComment[]> {
    try {
      const response = await this.client.get(
        `/repos/${this.config.owner}/${this.config.repo}/issues/${prNumber}/comments`
      );

      return response.data.map((comment: any) => ({
        id: String(comment.id),
        author: comment.user?.login || 'unknown',
        content: comment.body,
        createdAt: new Date(comment.created_at),
        updatedAt: new Date(comment.updated_at),
      }));
    } catch (error) {
      throw new Error(`Failed to get PR comments: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async mergePR(prNumber: string | number): Promise<void> {
    try {
      await this.client.post(
        `/repos/${this.config.owner}/${this.config.repo}/pulls/${prNumber}/merge`
      );
    } catch (error) {
      throw new Error(`Failed to merge PR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.get(`/repos/${this.config.owner}/${this.config.repo}`);
      return true;
    } catch (error) {
      console.error('Gitee connection test failed:', error);
      return false;
    }
  }

  getName(): string {
    return 'Gitee (碼雲)';
  }

  async extractRepoInfo(): Promise<{ owner: string; repo: string }> {
    try {
      const git = await import('simple-git');
      const simpleGit = git.default();

      const remotes = await simpleGit.getRemotes();
      const origin = remotes.find(r => r.name === 'origin');

      if (origin) {
        const match = origin.refs.fetch.match(/gitee\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
        if (match) {
          return {
            owner: match[1],
            repo: match[2],
          };
        }
      }

      throw new Error('Could not extract Gitee repo info from git remote');
    } catch (error) {
      throw new Error(`Failed to extract repo info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
