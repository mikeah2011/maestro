# 🚀 Git AI Review - 通用版本

**多 AI + 多平台的通用代碼審查系統**

完全開源、自託管、高度可定制的自動代碼審查解決方案。

```
支持 AI 提供商:          支持 Git 平台:
✅ Claude (Anthropic)    ✅ GitHub
✅ OpenAI (GPT)          ✅ GitLab
✅ Google Gemini         ✅ Gitea
✅ 本地 LLM (Ollama)      ✅ Gitee (碼雲)
✅ 自定義 API
```

---

## ✨ 核心特性

### 🎯 多 AI 提供商支持

- **Claude** - Anthropic 的最新模型
- **OpenAI** - GPT-4 系列
- **Google Gemini** - Google 的 AI
- **本地 LLM** - Ollama 本地部署
- **自定義 API** - 任何第三方 LLM

### 🌐 多 Git 平台支持

- **GitHub** - 雲端倉庫
- **GitLab** - 自託管/雲端
- **Gitea** - 輕量級自託管
- **Gitee** - 碼雲（國內）

### 🏗️ 工廠模式 + 依賴注入

```typescript
// 動態創建提供商
const ai = await AIProviderFactory.create('claude', config);
const platform = await GitPlatformFactory.create('github', config);

// 或使用快速方法
const ai = await createAIProvider('openai', { apiKey: 'sk-...' });
const platform = await createGitPlatform('gitlab', { token: 'glpat-...' });
```

### ⚙️ 靈活的配置系統

```yaml
# .gitai-review.yaml
ai:
  defaultProvider: claude
  providers:
    claude:
      model: claude-opus-4-20250805
    openai:
      model: gpt-4-turbo-preview

platform:
  type: github
```

---

## 🚀 快速開始

### 1. 安裝

```bash
npm install git-ai-review
# 或
yarn add git-ai-review
```

### 2. 配置

```bash
# 複製範本配置
cp .gitai-review.example.yaml .gitai-review.yaml

# 編輯配置文件
nano .gitai-review.yaml
```

### 3. 設置環境變數

```bash
# 設置 AI 提供商
export ANTHROPIC_API_KEY=sk-ant-...
# 或
export OPENAI_API_KEY=sk-...

# 設置 Git 平台
export GITHUB_TOKEN=ghp_...
export GIT_PLATFORM=github
```

### 4. 使用

```typescript
import { AIProviderFactory } from 'git-ai-review/ai';
import { GitPlatformFactory } from 'git-ai-review/platforms';
import { configManager } from 'git-ai-review/config';

// 加載配置
await configManager.load();

// 創建 AI 提供商
const ai = await AIProviderFactory.create(
  'claude',
  configManager.get('ai').providers.claude
);

// 創建 Git 平台
const platform = await GitPlatformFactory.create(
  'github',
  configManager.get('platform').config
);

// 進行代碼審查
const prDiff = await platform.getPRDiff(123);
const review = await ai.reviewCode(prDiff.diff, prDiff.files, false);

// 發布評論
await platform.addPRComment(123, review.summary);
```

---

## 📊 架構設計

### 提供商工廠模式

```
AIProviderFactory
├── create(type, config)
├── register(type, ProviderClass)
├── listProviders()
└── clearCache()

GitPlatformFactory
├── create(type, config)
├── detectPlatformType(url)
├── listPlatforms()
└── clearCache()
```

### 提供商實現

**AI 提供商基類**:
```typescript
abstract class AIProvider {
  abstract validateConfig(): void;
  abstract initialize(): Promise<void>;
  abstract reviewCode(diff, files, strictMode): Promise<ReviewResult>;
  abstract testConnection(): Promise<boolean>;
  abstract getName(): string;
  abstract listModels(): Promise<string[]>;
}
```

**Git 平台基類**:
```typescript
abstract class GitPlatform {
  abstract validateConfig(): void;
  abstract initialize(): Promise<void>;
  abstract getPRInfo(prId): Promise<PRInfo>;
  abstract getPRDiff(prId): Promise<GitDiff>;
  abstract addPRComment(prId, comment): Promise<void>;
  abstract mergePR(prId): Promise<void>;
  abstract testConnection(): Promise<boolean>;
}
```

---

## 🔧 配置詳解

### 切換 AI 提供商

```bash
# 使用 Claude（默認）
export AI_PROVIDER=claude

# 使用 OpenAI
export AI_PROVIDER=openai
export OPENAI_API_KEY=sk-...

# 使用本地 LLM
export AI_PROVIDER=local
export OLLAMA_BASE_URL=http://localhost:11434
export LOCAL_LLM_MODEL=mistral

# 使用 Google Gemini
export AI_PROVIDER=google
export GOOGLE_API_KEY=...
```

### 切換 Git 平台

```bash
# GitHub（默認）
export GIT_PLATFORM=github
export GITHUB_TOKEN=ghp_...

# GitLab
export GIT_PLATFORM=gitlab
export GITLAB_TOKEN=glpat-...

# Gitea 自託管
export GIT_PLATFORM=gitea
export GITEA_TOKEN=...
export GITEA_BASE_URL=http://your-gitea-server.com

# Gitee
export GIT_PLATFORM=gitee
export GITEE_TOKEN=...
```

---

## 📈 高級用法

### 使用多個 AI 提供商

```typescript
const claudeReview = await aiProviderFactory.create('claude', config);
const openaiReview = await aiProviderFactory.create('openai', config);

// 交叉驗證
const results = await Promise.all([
  claudeReview.reviewCode(diff, files, false),
  openaiReview.reviewCode(diff, files, false),
]);
```

### 自定義提供商

```typescript
// 創建自定義 AI 提供商
class MyCustomProvider extends AIProvider {
  async initialize(): Promise<void> {
    // 初始化代碼
  }

  async reviewCode(diff, files, strictMode): Promise<ReviewResult> {
    // 自定義審查邏輯
  }

  // ... 實現其他抽象方法
}

// 註冊自定義提供商
AIProviderFactory.register('mycustom', MyCustomProvider);

// 使用
const ai = await AIProviderFactory.create('mycustom', config);
```

### 審查規則

```yaml
review:
  rules:
    - name: 'Security Check'
      enabled: true
      providers: [claude, openai]  # 多個提供商
      strictMode: true

    - name: 'Performance'
      enabled: true
      provider: local  # 單個提供商
      model: mistral
```

---

## 🏆 最佳實踐

### 1. 使用配置文件

```bash
cp .gitai-review.example.yaml .gitai-review.yaml
# 編輯配置
npm run review
```

### 2. 環境變數優先級

```
優先級：環境變數 > 命令行參數 > 配置文件 > 默認值
```

### 3. 性能優化

```typescript
// 啟用提供商緩存
const config = configManager.get('advanced');
config.cacheProviders = true;

// 使用本地 LLM 提高速度
const ai = await createAIProvider('local', {
  baseUrl: 'http://localhost:11434',
  model: 'mistral',  // 快速的小模型
});
```

### 4. 成本控制

```yaml
ai:
  defaultProvider: local  # 免費的本地 LLM
  providers:
    local:
      model: mistral  # 小型快速模型
```

---

## 📚 文檔

- [快速開始](./docs/QUICK_START.md)
- [配置指南](./docs/CONFIG.md)
- [API 參考](./docs/API.md)
- [部署指南](./docs/DEPLOYMENT.md)
- [示例代碼](./examples/)

---

## 🎯 使用場景

### 場景 1：開發者本地使用

```bash
# 本地快速審查
claude-git-review check

# 使用本地 LLM（免費）
export AI_PROVIDER=local
claude-git-review check
```

### 場景 2：團隊 CI/CD 集成

```yaml
# GitHub Actions 中使用
- name: Code Review
  run: |
    export AI_PROVIDER=openai
    npm run review
```

### 場景 3：企業級部署

```bash
# 使用多個 AI 進行交叉驗證
# 使用私有 Git 服務（Gitea）
# 通過配置文件統一管理
```

---

## 🔒 安全特性

✅ **API Key 管理**
- 支持環境變數
- 支持配置文件
- 支持 Secret Manager

✅ **請求簽名驗證**
- WebHook 簽名驗證
- 防止未授權訪問

✅ **數據隱私**
- 支持本地 LLM（無數據外傳）
- 支持自託管平台

---

## 📊 成本對比

| 方式 | 成本/月 | 速度 | 隱私 |
|------|--------|------|------|
| Claude + GitHub | $5-20 | 快 | ⭐⭐⭐ |
| OpenAI + GitHub | $5-15 | 快 | ⭐⭐ |
| 本地 LLM + GitHub | $0 | 慢 | ⭐⭐⭐⭐⭐ |
| Claude + Gitea 自託管 | $5-20 | 快 | ⭐⭐⭐⭐ |

---

## 🤝 貢獻

歡迎提交 PR 或 Issue！

```bash
# 開發設置
npm install
npm run dev

# 測試
npm run test

# 構建
npm run build
```

---

## 📄 許可證

MIT - 自由使用和修改

---

## 💡 常見問題

**Q: 如何使用本地 LLM？**

```bash
# 安裝 Ollama：https://ollama.ai
ollama pull mistral

# 配置
export AI_PROVIDER=local
export OLLAMA_BASE_URL=http://localhost:11434
```

**Q: 如何支持自定義 API？**

```typescript
class CustomProvider extends AIProvider {
  // 實現接口
}

AIProviderFactory.register('custom', CustomProvider);
```

**Q: 如何在企業 GitHub/GitLab 上使用？**

```bash
# GitHub Enterprise
export GITHUB_TOKEN=ghp_...
export GITHUB_API_URL=https://your-github.company.com/api/v3

# GitLab self-hosted
export GITLAB_TOKEN=glpat-...
export GITLAB_BASE_URL=https://your-gitlab.company.com/api/v4
```

---

**開始使用** 🚀

```bash
git clone https://github.com/mikeah2011/git-ai-review-universal.git
cd git-ai-review-universal
npm install
cp .gitai-review.example.yaml .gitai-review.yaml
npm run review
```

**祝你使用愉快！**
