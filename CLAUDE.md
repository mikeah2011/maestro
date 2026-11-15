# CLAUDE.md

此檔案提供給 Claude Code（claude.ai/code）在此倉庫中工作時的指引。

## 常用指令

```bash
# 開發
bun run dev              # watch 模式（src/cli/index.ts）
bun run start            # 直接執行 CLI

# 建置
bun run build            # 打包到 dist/（Bun target，已壓縮）
bun run build:bin        # 編譯成獨立二進位 → dist/maestro

# 提交前驗證
bun run verify           # 型別檢查 + 測試

# 測試
bun run test             # 執行所有測試（單次）
bun run test:watch       # vitest watch 模式
bun run test:coverage    # 含 v8 覆蓋率報告

# 執行單一測試檔
bunx vitest run tests/core/loop/LoopOrchestrator.test.ts

# 僅型別檢查
bun run typecheck

# 文件
bun run docs:wiki         # 從 .qoder/repowiki 產出重建 docs/wiki
```

`docs/wiki/` 是產物，不要手改頁面內容；需要新內容就重新產生 Qoder Repo Wiki，再跑 `bun run docs:wiki`。腳本在寫入前會驗證渲染與連結，發現問題會拒絕寫入。

覆蓋率門檻要求：lines / functions / statements 80%，branches 75%。

## 架構概覽

Maestro 是一個 ESM TypeScript CLI，用於在 PR 上調度 AI 機器人審查的收斂循環。兩個入口點：

- **`src/cli/index.ts`** — Commander CLI（`maestro init | doctor | loop | audit | bots`）
- **`src/index.ts`** — 公開函式庫重新匯出（供消費者 / CI scripts 使用的型別和類別）

路徑別名：`@/` → `src/`。

### 分層模組（M 系列里程碑）

```
src/
├── config/         M1 — Zod schema + 分層載入器（~/.maestro/config.yaml + .maestro.yaml + 環境變數）
├── core/
│   ├── events/     M2 — 型別化 EventEmitter（所有領域事件流經此處）
│   ├── round/      M2 — RoundBudget（每輪分類 + 提交 + 回覆配額）
│   │                     CommitThrottle（將修復批次成每輪一個提交）
│   ├── state/      M2 — StateMachine（循環階段轉換，見下方狀態）
│   ├── convergence/ M3 — ConvergenceMonitor（Jaccard 振盪偵測）
│   ├── classify/   M3 — Classifier（圍欄 Markdown → bug | taste | wrong | yagni | unknown）
│   ├── dedup/      M3 — Dedup（三層：精確雜湊 → 模糊 Levenshtein → LLM 語義）
│   ├── security/   M3 — SecretScanner（遮蔽外發文字中的機密資訊）
│   ├── fix/        M6 — FixEngine（AI 自動修復引擎）
│   ├── loop/       M5 — LoopOrchestrator（將 M2+M3+M4 整合成收斂循環）
│   └── types/            共用領域型別：Finding、CI、PullRequest
├── platforms/
│   ├── interfaces/ M4 — 抽象 GitPlatform（降級平台的能力旗標）
│   └── github/     M4 — GitHubPlatform（Octokit REST + GraphQL）+ mappers
└── ai/
    ├── interfaces/       抽象 AIProvider
    └── providers/
        ├── ClaudeProvider.ts         Anthropic Messages API（需要 API Key）
        └── ClaudeCodeProvider.ts     Claude Code CLI 子程序（無需 API Key）
```

### 循環狀態機

```
waiting_for_ci → waiting_for_bot → racing → classifying → fixing
→ commit_pushed → replying → resolving → waiting_for_ci（重複）

終止狀態：stopped | ci_failing | bot_timeout
```

`LoopOrchestrator` 驅動此循環。所有副作用（`onFix`、`onCommit`、`sleep`）均透過建構函式選項注入——在測試中替換以立即解析。

### 關鍵設計決策

- **`maxRounds`** 在 Zod schema 中硬性上限為 5（預設 3），不得超過。
- **`GitPlatform`** 是抽象類別；`capabilities` 物件告知編排器哪些呼叫是安全的（如 `threadResolve`、`inlineReplies`）。降級平台退回使用 body marker。
- **`RoundBudget`** 強制每輪分類、提交和回覆的限制，溢出時 throw `RoundBudgetViolation`。
- **`Dedup`** 依序執行：精確雜湊 → 模糊（Levenshtein）→ LLM 語義，三層結果不重疊。
- **AI Provider 自動偵測**：有 `ANTHROPIC_API_KEY` → `ClaudeProvider`；有 `claude` CLI → `ClaudeCodeProvider`；兩者皆無 → 修復引擎停用。
- **設定分層**：全域（`~/.maestro/config.yaml`）先載入，倉庫（`.maestro.yaml`）深層合併覆蓋。`${ENV_VAR}` 展開在合併後執行；未設定的變數必須使用 `${VAR:-預設值}` 語法。
- **dotenv**：CLI 啟動時自動從 `process.cwd()/.env` 載入環境變數。

### 設定與環境變數

```bash
cp .env.template .env   # 複製範本
# 編輯 .env 填入 GITHUB_TOKEN
bun run start loop start --pr <PR編號> --dry-run
```

完整設定說明請參考 [`.maestro.yaml`](./.maestro.yaml) 和 [`docs/DESIGN.md`](./docs/DESIGN.md)。
