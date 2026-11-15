# Maestro

> 統一調度 AI PR 審查機器人。讓收斂循環自動完成。讓 PR 真正合併。

`maestro` **不是另一個程式碼審查工具。** CodeRabbit、Ellipsis、Copilot Code Review、Codex、Gemini Code Assist、Sourcery——這些已經是很好的審查工具了。缺少的是審查之後發生的事：分類問題、修復真正的 bug、在討論串中回覆、解決討論串、請求重新審查、知道何時該停止。`maestro` 是疊加在這些機器人之上的**收斂層**。

```
[ 你推送程式碼 ]
       │
       ▼
[ CodeRabbit 審查 ]  [ Ellipsis 審查 ]  [ Copilot 審查 ]
       │                    │                   │
       └──────────┬──────────┴───────────────────┘
                  ▼
            ┌──────────┐
            │ maestro  │  ← 分類 · 去重 · 修復 · 回覆 · 解決討論串
            └──────────┘
                  │
                  ▼
       （循環直到 ≤3 輪 或 收斂 或 升級人工處理）
                  │
                  ▼
            [ 準備合併 ]
```

---

## 文檔

完整文件見 **[Repo Wiki 索引](./docs/wiki/Home.md)**（78 頁，含架構、模組、CLI 命令、設定、測試、部署）。

| 文件 | 內容 |
|---|---|
| [Repo Wiki 索引](./docs/wiki/Home.md) | 全部文件導覽 |
| [系統架構](./docs/wiki/系統架構.md) | 分層架構與系統上下文 |
| [快速開始](./docs/wiki/快速開始.md) | 安裝與首次運行 |
| [CLI 命令參考](./docs/wiki/CLI%20命令參考.md) | init / doctor / loop / audit / bots |
| [設定指南](./docs/wiki/設定指南.md) | `.maestro.yaml` 各區塊 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 原始設計文件 |

---

## 為什麼需要這個工具

CodeRabbit 和 Ellipsis 很擅長找問題，但不擅長*結束對話*。你修了八個問題中的五個，推回了兩個，漏掉了一個真正的 bug。十分鐘後機器人重新審查，又找到三個新問題。循環永遠不收斂；你在疲憊時合併，而不是在完成時合併。

`maestro` 執行具有確定性停止條件的硬性收斂循環：

- **硬性上限：3 輪。** 不設例外。
- **單調不增的關鍵問題集。** 若第 N+1 輪的關鍵問題比第 N 輪多，升級給人工處理。
- **收斂偵測。** 相同問題跨輪重複出現（Jaccard 相似度 > 0.7）→ 停止並升級。
- **反垃圾郵件設計。** 執行期斷言強制每輪最多 1 次提交、每個討論串每輪最多 1 次回覆、每輪最多 1 次 PR 內容更新。違反即使程序崩潰——不允許靜默漂移。

---

## 快速開始

### 安裝需求

- [Bun](https://bun.sh) >= 1.0
- Node.js >= 20（用於二進位執行）
- GitHub Token（具備 repo + pull_requests 讀寫權限）
- Claude Code CLI（可選，無 API Key 時自動使用）或 Anthropic API Key

### 設定步驟

```bash
# 1. 複製環境變數範本
cp .env.template .env

# 2. 填入你的 GitHub Token
#    編輯 .env，設定 GITHUB_TOKEN=ghp_你的token

# 3. 設定 .maestro.yaml（編輯 owner/repo 為你的 GitHub 倉庫）
#    .maestro.yaml 已提供完整範例，按需調整即可

# 4. 驗證環境
bun run src/cli/index.ts doctor

# 5. 試跑（dry-run 模式，不會實際修改任何內容）
bun run src/cli/index.ts loop start --pr 1 --dry-run
```

### 常用指令

```bash
# 開發模式（watch）
bun run dev

# 執行 CLI
bun run start <subcommand>

# 建置 binary
bun run build:bin       # 輸出 dist/maestro

# 驗證（型別檢查 + 測試）
bun run verify

# 執行測試
bun run test
bun run test:coverage   # 含覆蓋率報告

# 執行單一測試檔
bunx vitest run tests/core/loop/LoopOrchestrator.test.ts
```

---

## 架構概覽

```
src/
├── cli/
│   ├── index.ts              CLI 入口（Commander）
│   └── commands/
│       ├── init.ts           maestro init — 初始化 .maestro.yaml
│       ├── doctor.ts         maestro doctor — 環境診斷
│       ├── loop.ts           maestro loop start/status/stop/resume
│       ├── audit.ts          maestro audit — 重播分類決策
│       └── bots.ts           maestro bots — 機器人管理
├── config/                   Zod schema + 多層設定載入
├── core/
│   ├── events/               EventEmitter — 所有領域事件流經此處
│   ├── round/                RoundBudget（每輪配額）、CommitThrottle
│   ├── state/                StateMachine — 循環狀態機
│   ├── convergence/          ConvergenceMonitor — Jaccard 振盪偵測
│   ├── classify/             Classifier — 圍欄 Markdown → bug/taste/wrong/yagni
│   ├── dedup/                Dedup — 三層去重（精確雜湊 → 模糊 → LLM 語義）
│   ├── security/             SecretScanner — 敏感資訊偵測
│   ├── fix/                  FixEngine — AI 自動修復引擎
│   └── loop/                 LoopOrchestrator — 核心收斂循環
├── platforms/
│   ├── interfaces/           GitPlatform 抽象介面
│   └── github/               GitHub REST + GraphQL 實作
└── ai/
    ├── interfaces/           AIProvider 抽象介面
    └── providers/
        ├── ClaudeProvider.ts          Anthropic API（需要 API Key）
        └── ClaudeCodeProvider.ts      Claude Code CLI（無需 API Key）
```

### 循環狀態機

```
等待 CI → 等待機器人 → 競速 → 分類 → 修復
→ 提交推送 → 回覆 → 解決討論串 → 等待 CI（重複）

終止狀態：stopped（手動停止）| ci_failing（CI 失敗）| bot_timeout（機器人逾時）
```

### AI Provider 自動偵測順序

1. **ClaudeProvider** — 當 `ANTHROPIC_API_KEY` 或設定中的 `apiKey` 有值時使用
2. **ClaudeCodeProvider** — 當本機已安裝 `claude` CLI 時自動 fallback（無需 API Key）
3. **停用修復引擎** — 兩者皆不可用時，循環繼續但跳過 AI 自動修復

---

## 設定說明

設定優先順序（高 → 低）：CLI 旗標 → 環境變數 → 倉庫 `.maestro.yaml` → 使用者 `~/.maestro/config.yaml` → 預設值

`.maestro.yaml` 的主要設定區塊：

```yaml
# Git 平台
platform:
  type: github
  auth:
    tokenEnv: GITHUB_TOKEN
  owner: your-org
  repo: your-repo

# AI Provider
ai:
  providers:
    claude:
      type: claude
      apiKey: ${ANTHROPIC_API_KEY:-}   # 留空時自動改用 Claude Code CLI

# 停止條件
stopConditions:
  maxRounds: 3          # 最多 3 輪（最大值 5）
  quietPeriodSec: 90    # 機器人發文後的靜默等待期（秒）
  costBudgetUSD: 5.00   # 單次 loop 成本上限（美元）
```

完整設定範例請參考 [`.maestro.yaml`](./.maestro.yaml)。

---

## 多平台 · 多 AI · 多語言

| 層級 | 支援項目 |
|---|---|
| **AI Provider** | Claude（API 或 CLI）、OpenAI、Gemini、本機 Ollama、自訂 HTTP |
| **Git 平台** | GitHub、GitLab、Gitea、Gitee |
| **審查機器人** | CodeRabbit、Ellipsis、Copilot Code Review、Codex、Gemini Code Assist、Sourcery、Greptile，以及慣例型偵測 |
| **語言插件** | TypeScript/JS、Python、Go、Rust |

---

## 與其他工具的比較

|                            | maestro   | CodeRabbit | Ellipsis | PR-Agent | reviewdog |
|---|---|---|---|---|---|
| 自行審查程式碼              | 否¹        | 是         | 是       | 是       | 否        |
| 調度其他機器人              | **是**    | 否         | 否       | 否       | 否        |
| 多輪收斂循環                | **是**    | 部分       | 部分     | 否       | 否        |
| 硬性停止條件                | **是**    | 否         | 否       | 否       | 否        |
| 反垃圾郵件執行期斷言        | **是**    | 否         | 否       | 否       | 否        |
| 工具無關（CLI/Action/MCP）  | **是**    | 僅 App     | 僅 App   | Action   | 多種      |
| 可自託管 · 開源             | **是**    | 部分開源   | 否       | 是       | 是        |

¹ `maestro` 在推送前執行本機 AI 自我審查，但核心價值是調度外部審查機器人。

---

## 開發路線圖

| 里程碑 | 狀態 | 內容 |
|---|---|---|
| M1 — CLI + 設定 + 平台介面 | ✅ 完成 | Bun 編譯 binary、Zod schema、`init` + `doctor` |
| M2 — 循環基礎建設 | ✅ 完成 | StateMachine、RoundBudget、CommitThrottle、EventEmitter |
| M3 — 收斂 + 分類器 | ✅ 完成 | ConvergenceMonitor、Classifier、3 層 Dedup、SecretScanner |
| M4 — GitHub 平台 | ✅ 完成 | GitHub REST + GraphQL 實作、型別對映 |
| M5 — 循環編排器 | ✅ 完成 | LoopOrchestrator — 整合 M2~M4 |
| M6 — AI 自動修復 | ✅ 完成 | ClaudeProvider、ClaudeCodeProvider、FixEngine |
| M7 — 持久化 + 狀態管理 | 待開發 | loop status/stop/resume、JSONL 重播 |
| M8 — 發布 | 待開發 | GitHub Releases 二進位、GitHub Action、Homebrew tap |

---

## 授權

MIT — 詳見 [LICENSE](./LICENSE)。

## 致謝

`maestro` 參考了以下專案的設計理念：
- [PR-Agent (Qodo)](https://github.com/qodo-ai/pr-agent) — JSON 可設定的 LLM 提示詞、大 diff 的 PR 壓縮
- [Gito](https://github.com/Nayjest/Gito) — 置信度優先的問題過濾
- [reviewdog](https://github.com/reviewdog/reviewdog) — 通用 lint 輸出 → PR 評論橋接
- [Danger.js](https://github.com/danger/danger-js) — PR 內容區塊的冪等更新模式

核心創新是**帶有數學收斂保證的多機器人編排層**——這在上述任何專案中都不存在。
