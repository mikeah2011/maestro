/**
 * GitHub 平台實現
 */

import { GitPlatform, GitPlatformConfig, PRInfo, GitDiff, PRReviewComment } from '../interfaces/GitPlatform';
import { Octokit } from '@octokit/rest';

export class GitHubPlatform extends GitPlatform {
  private client: Octokit;
  private owner: string = '';
  private repo: string = '';

  /**
   * 驗證配置
   */
  validateConfig(): void {
    if (!this.config.token && !process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is required for GitHub platform');
    }
  }

  /**
   * 初始化平台
   */
  async initialize(): Promise<void> {
    try {
      const token = this.config.token || process.env.GITHUB_TOKEN;

      this.client = new Octokit({
        auth: token,
        baseUrl: this.config.baseUrl || 'https://api.github.com',
      });

      // 如果沒有提供 owner 和 repo，嘗試從遠程提取
      if (!this.config.owner || !this.config.repo) {
        const info = await this.extractRepoInfo();
        this.owner = info.owner;
        this.repo = info.repo;
      } else {
        this.owner = this.config.owner;
        this.repo = this.config.repo;
      }

      // 測試連接
      await this.testConnection();
    } catch (error) {
      throw new Error(`Failed to initialize GitHub platform: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取 PR 信息
   */
  async getPRInfo(prNumber: string | number): Promise<PRInfo> {
    try {
      const response = await this.client.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(prNumber),
      });

      return {
        id: String(response.data.id),
        number: response.data.number,
        title: response.data.title,
        description: response.data.body || '',
        state: response.data.state as 'open' | 'closed' | 'merged',
        branch: response.data.head.ref,
        baseBranch: response.data.base.ref,
        author: response.data.user?.login || 'unknown',
        createdAt: new Date(response.data.created_at),
        updatedAt: new Date(response.data.updated_at),
        url: response.data.html_url,
      };
    } catch (error) {
      throw new Error(`Failed to get PR info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取 PR 差異
   */
  async getPRDiff(prNumber: string | number): Promise<GitDiff> {
    try {
      const response = await this.client.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(prNumber),
        mediaType: {
          format: 'diff',
        } as any,
      });

      // 獲取詳細統計
      const prDetails = await this.client.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(prNumber),
      });

      // 獲取更改的文件
      const files = await this.client.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(prNumber),
      });

      return {
        files: files.data.map(f => f.filename),
        diff: response.data as any,
        stats: {
          additions: prDetails.data.additions,
          deletions: prDetails.data.deletions,
          filesChanged: prDetails.data.changed_files,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get PR diff: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 添加 PR 評論
   */
  async addPRComment(prNumber: string | number, comment: string, event?: 'APPROVE' | 'REQUEST_CHANGES'): Promise<void> {
    try {
      if (event) {
        await this.client.pulls.createReview({
          owner: this.owner,
          repo: this.repo,
          pull_number: Number(prNumber),
          event,
          body: comment,
        });
      } else {
        await this.client.issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: Number(prNumber),
          body: comment,
        });
      }
    } catch (error) {
      throw new Error(`Failed to add PR comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 獲取 PR 評論
   */
  async getPRComments(prNumber: string | number): Promise<PRReviewComment[]> {
    try {
      const response = await this.client.pulls.listReviews({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(prNumber),
      });

      return response.data.map(review => ({
        id: String(review.id),
        author: review.user?.login || 'unknown',
        content: review.body || '',
        createdAt: new Date(review.submitted_at || ''),
        updatedAt: new Date(review.submitted_at || ''),
      }));
    } catch (error) {
      throw new Error(`Failed to get PR comments: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 合併 PR
   */
  async mergePR(prNumber: string | number, commitMessage?: string): Promise<void> {
    try {
      await this.client.pulls.merge({
        owner: this.owner,
        repo: this.repo,
        pull_number: Number(prNumber),
        commit_message: commitMessage,
        merge_method: 'squash',
      });
    } catch (error) {
      throw new Error(`Failed to merge PR: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 檢查連接
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.client.repos.get({
        owner: this.owner,
        repo: this.repo,
      });

      return true;
    } catch (error) {
      console.error('GitHub connection test failed:', error);
      return false;
    }
  }

  /**
   * 獲取平台名稱
   */
  getName(): string {
    return 'GitHub';
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
        const match = origin.refs.fetch.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
        if (match) {
          return {
            owner: match[1],
            repo: match[2],
          };
        }
      }

      throw new Error('Could not extract GitHub repo info from git remote');
    } catch (error) {
      throw new Error(`Failed to extract repo info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
