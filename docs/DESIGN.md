# Maestro — 技術設計文件

> 本文件為面向公眾的技術摘要，描述系統的整體架構與設計不變量。

---

## 1. 問題陳述

現代 PR 會同時接收來自多個 AI 機器人的自動審查——CodeRabbit、Ellipsis、Copilot Code Review、Codex、Gemini Code Assist、Sourcery、Greptile。每個機器人都擅長找出問題，但沒有任何機器人擅長**結束對話**。開發者必須手動驅動一個繁瑣的循環：

1. 閱讀分散在多個討論串中的機器人評論。
2. 判斷哪些問題是真正的 bug、哪些是 YAGNI、哪些是誤判。
3. 修復真正的問題、推回誤判、延後 YAGNI。
4. 在討論串中回覆、解決討論串、請求重新審查。
5. 重複執行——往往永無止境，因為每一輪都可能產生新問題。

手動循環的失敗模式包括：評論垃圾化、遺漏真正的 bug、修復來回震盪、在各 AI 工具之間複製貼上、因疲勞而不是因收斂而合併。

現有工具要麼*取代*其中一個機器人（PR-Agent、Gito、coderabbitai/ai-pr-reviewer），要麼執行靜態分析（reviewdog、Danger.js）。**目前沒有任何開源工具能以收斂保證來調度多個審查機器人。** 這正是 `maestro` 填補的空缺。

---

## 2. 產品定位

`maestro` 是**審查機器人之上的收斂層**，而不是另一個審查工具。它將 CodeRabbit / Ellipsis / Copilot 等視為輸入。它的輸出是：已分類的問題、討論串內回覆、修復提交、已解決的討論串、最終 PR 內容摘要，以及對循環終止的數學保證。

> 「CodeRabbit 審查你的 PR。`maestro` 完成閉環——調度你使用的每個機器人，在 ≤3 輪內強制收斂，撰寫準備合併的摘要。」

---

## 3. 系統架構

兩個層次，不多不少：

### A. 核心層（TypeScript 函式庫 + Bun 編譯 CLI 二進位）

所有有狀態邏輯，與工具無關。模組說明：

| 模組 | 職責 |
|---|---|
| `Config` | Zod 驗證的 YAML。分層優先順序：CLI 旗標 → 環境變數 → 倉庫 `.maestro.yaml` → 使用者 `~/.maestro/config.yaml` → 預設值。 |
| `Platform` | 介面，具體實作為 `GitHubPlatform`、`GitLabPlatform`、`GiteaPlatform`、`GiteePlatform`。抽象：取得 PR、列出審查、讀取評論、在討論串回覆、解決討論串、更新 PR 內容、請求審查者、取得 CI 狀態、取得 HEAD SHA。 |
| `AIProvider` | 多 Provider 工廠（Claude / OpenAI / Gemini / 本機 / 自訂）。每個階段有獨立的路由表——高頻低風險操作（提交訊息、未知問題分類）使用廉價模型；判斷性操作（PR 內容草稿、品味偵測、最終摘要）使用強力模型。 |
| `BotRegistry` | 混合模式：隨附精選登錄表（8 個機器人，各有專屬解析器）+ 慣例型 fallback + 使用者覆寫 + `maestro bots register --login` CLI。每個條目有針對該機器人評論結構的解析器。 |
| `Classifier` | **圍欄式設計**：確定性規則優先，在任何 LLM 呼叫之前短路。關鍵字（NPE、SQL 注入等）、機器人分配的嚴重程度、敏感路徑（`auth/`、`crypto/`、`payment/`）均繞過 LLM。只有未知問題才進入模型。每個決策都被記錄到審計日誌中。 |
| `Dedup` | **三層，最廉價優先**：(1) `(file, line_bucket=5, category)` 的精確雜湊，消除約 60%；(2) 基於 Levenshtein 正規化標題的模糊匹配，再消除約 25%；(3) 語義 LLM 去重，每輪上限 10 次呼叫，處理剩餘部分。對冪等性和結合性進行屬性測試。 |
| `ThreadManager` | 僅在討論串內回覆——在循環過程中絕不發出頂層 PR 評論。透過平台原生 API 解決討論串（GitHub `resolveReviewThread` mutation；不支援解決功能的平台使用降級模式 fallback）。 |
| `CommitThrottle` | 將一輪內的所有修復累積成一個結構化訊息的提交。 |
| `RoundBudget` | **執行期斷言，只 throw 不警告。** 強制反垃圾郵件不變量：每輪 ≤1 次提交、每個討論串每輪 ≤1 次回覆、每輪 ≤1 次 PR 內容更新、每個問題的分類呼叫已記憶化、每輪 ≤1 次審查者請求。違反即崩潰——不允許靜默漂移。 |
| `ConvergenceMonitor` | 計算連續關鍵問題集之間的 Jaccard 相似度。若 `> 0.7`（振盪），停止並升級。強制「第 2 輪後不得出現新問題類別」和 `|criticals(n+1)| ≤ |criticals(n)|`。問題雜湊使用 `sha1(file + line_bucket + normalized_category + sha1(surrounding 10-line content))`，在改寫和行號偏移下均保持穩定。 |
| `StateMachine` | 狀態：`Idle → Writing → PreFlight → PRCreated → WaitingForCI → WaitingForBot → Classifying → Fixing → CommitPushed → Replying → Resolving → Stopped`。錯誤狀態：`CIFailing`、`BotTimeout`、`HumanIntervened`、`Racing`、`RateLimited`、`TokenExpired`。每次轉換都發出結構化 JSONL 事件。 |
| `PRBodyUpdater` | 冪等式：替換 `<!-- maestro:start -->` 和 `<!-- maestro:end -->` 之間的內容，絕不追加。 |
| `SecretScanner` | 掃描每個外發回覆和 PR 內容更新，對照可設定的遮蔽模式。機器人引用可能洩漏密鑰；我們的回聲絕不能持久化它們。 |
| `CostTracker` | 硬性 `--cost-budget` 上限。每次執行以 JSONL 形式報告 Token 用量和費用。 |
| `EventEmitter` | UI 唯一真實來源：結構化 JSONL 事件，由 Claude Code skill、MCP 伺服器、純 `tail -f`、未來的 GitHub Action UI 讀取。 |

### B. 語言插件層

即插即用，透過 shell 呼叫。每個插件暴露 `lint() / typecheck() / test() / format()`。隨附插件：TS/JS、Python、Go、Rust。歡迎社群貢獻其他語言。

### 不是獨立層

AI 工具適配器（Claude Code skill、Cursor rules、Gemini CLI hooks、Copilot CLI 整合）是**文件片段和 30 行 shell 包裝**，不是程式碼層。它們全部呼叫 `maestro` CLI 並在各自的 UI 中渲染 JSONL 事件流。單一 MCP 伺服器暴露 `start_loop / get_status / stop_loop / get_round_summary`——一旦上線，每個支援 MCP 的代理（Claude Desktop、Cursor、Gemini Desktop）都能免費整合。

可復用的原則：

> **CLI 是程序，Skill 是視窗。** 長時運行的編排邏輯在 CLI 中；UI 工具是監控器，負責讀取事件並分發控制指令。

---

## 4. 狀態機詳解

```
Idle
  → [作者撰寫 + maestro preflight] → PreFlight（本機自我審查 + lint + test）
  → [推送] → PRCreated（AI 生成 PR 內容，請求審查者）
  → WaitingForCI
      ├→ [CI 通過] → WaitingForBot
      ├→ [CI 失敗] → CIFailing → {重試修復 | 退出並通知}
  → WaitingForBot（含 90 秒靜默期防抖）
      ├→ [機器人發布審查] → Racing → 等待 90 秒 → Classifying
      ├→ [N 次輪詢後無審查] → BotTimeout → {跳過機器人 | 停止}
  → Classifying（RoundBudget 開始計時）
      → [存在關鍵問題] → Fixing
      → [只有品味/重複問題] → Stopped(clean)
      → [重複問題 = 偵測到振盪] → Stopped(escalate)
  → Fixing → CommitPushed（一次提交）→ WaitingForCI（重新循環）
  → Replying（討論串內，每個問題一次回覆）
  → Resolving（在適用情況下關閉討論串）
  → 請求重新審查 → WaitingForBot（第 R+1 輪）
  → [完成 3 輪 OR Jaccard>0.7 OR 違反無新類別規則] → Stopped → Finalize
```

跨狀態轉換：

- 任何狀態 + HEAD SHA 被外部更改 → `HumanIntervened` → `Paused`（等待 `--resume`）
- 任何狀態 + 平台回傳 401/403 → `TokenExpired` → 退出並通知
- 任何狀態 + 觸發速率限制 → `RateLimited` → 指數退避，遵守 `X-RateLimit-Remaining`

每次轉換都發出 JSONL 事件。每次寫操作都通過 `RoundBudget`。

---

## 5. 反垃圾郵件不變量

這些**不是**可被設定覆寫的策略。它們是 `RoundBudget` 中的執行期斷言：

```
每輪提交次數              ≤ 1
每個討論串每輪回覆次數    ≤ 1
每輪 PR 內容更新次數      ≤ 1
每個問題的分類呼叫次數    ≤ 1（已記憶化）
每輪審查者請求次數        ≤ 1
每輪 API 寫操作總次數     ≤ (1 + |討論串數| + 1 + 1)
```

任何試圖違反這些規則的程式碼路徑都會 throw。沒有 `--force` 旗標。原因在於：當循環行為異常時，它必須大聲失敗；一個被記錄但被忽略的警告，正是生產工具隨時間積累垃圾郵件的方式。

---

## 6. 收斂保證

**終止**由硬性上限保證。**品質收斂**是一個獨立屬性，需要三個額外不變量：

### 不變量 1：單調不增的關鍵問題集

```
|criticals(round n+1)| ≤ |criticals(round n)|
```

違反 = 修復引入了迴歸 → 升級給人工處理。

### 不變量 2：第 2 輪後不得出現新問題類別

若第 3 輪引入了之前未見過的類別，表示第 2 輪的修復創造了新的 bug 類 → 升級。

### 不變量 3：穩定的問題雜湊

定義為：
```
sha1(file + line_bucket(=5) + normalized_category + sha1(surrounding_10_line_content))
```

在以下情況下保持穩定：
- 機器人改寫（相同的 file/line/category 產生相同的雜湊）
- rebase 或無關修改導致的行號偏移（內容雜湊錨定到周邊程式碼）

若 `Jaccard(criticals_n, criticals_{n-1}) > 0.7`，表示循環在振盪——相同問題集不斷重複出現。`ConvergenceMonitor` 停止並升級，而不是繼續消耗剩餘預算。

---

## 7. 多平台承諾

`maestro` 將 GitHub、GitLab、Gitea、Gitee 四個 Git 平台作為 `Platform` 介面的一流實作隨附。

| 平台 | API | 討論串解決機制 | 機器人生態 | 備註 |
|---|---|---|---|---|
| **GitHub** | REST + GraphQL | `resolveReviewThread` mutation | 最豐富（8+ 個機器人）| 參考平台 |
| **GitLab** | REST v4 + GraphQL | Discussion `resolved` 欄位 | 中等（Duo、Ellipsis、Sourcery）| 完全對等 |
| **Gitea** | REST v1 | 有限；部分版本不支援解決功能 | 較弱（主要是自託管自訂機器人）| 降級模式：在回覆正文中寫入解決標記 |
| **Gitee** | REST | 類似 Gitea | 較弱 | 相同降級模式處理 |

`BotRegistry` 按平台分區——我們不會在 Gitea 上嘗試偵測僅限 GitHub 的機器人。

---

## 8. 發布計畫

### MVP

1. **npm `@mikeah2011/maestro`** — `npx @mikeah2011/maestro@latest init` 即時可用；無論 npm 包名如何，CLI 二進位名稱固定為 `maestro`。
2. **Bun 編譯二進位** 透過 GitHub Releases + `install.sh`。目標平台：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`。零執行期依賴。（Windows 在 Phase 2。）
3. **GitHub Action `mikeah2011/maestro-action@v1`** — 單行 `run: maestro loop start --pr ${{ github.event.number }}`。
4. **GitLab CI Component / `.gitlab-ci.yml` 範本** — 因為我們支援四個平台，所以這是一流功能。
5. **Claude Code skill** — 約 30 行，呼叫 CLI 並將 JSONL 事件流管道到 TodoWrite。

### Phase 2

6. Homebrew tap。
7. Docker 映像（預裝 `gh` + `glab` + `tea`，適用於自託管 CI）。
8. **MCP 伺服器**（`maestro mcp serve`）——一旦上線，Cursor / Gemini Desktop / Claude Desktop / 任何支援 MCP 的代理均可免費整合。

### 無限期延後

Cursor `.cursorrules` / Gemini `GEMINI.md` / Copilot CLI shell hooks → README 複製貼上片段，無需每工具適配器程式碼。MCP 將取代它們。

---

## 9. v0.1 範圍外

- Windows 二進位。
- 完全自主的「無需人工批准即合併」模式——每輪仍需人工確認修復提交後才能推送。
- 機器人帳號模擬。回覆以使用者 token 發出；代理絕不會偽裝成 CodeRabbit 或其他機器人。
- 受 NDA 保護的機器人解析器。社群可透過 `BotRegistry` 貢獻自己的解析器。
- 非 PR 審查場景（issue 評論、討論區）。
- 自適應模型路由。v0.1 中每個階段的路由在設定中靜態配置。

---

## 10. 致謝

- [PR-Agent (Qodo)](https://github.com/qodo-ai/pr-agent) — JSON 可設定的 LLM 提示詞結構；超大 diff 的 PR 壓縮。
- [Gito](https://github.com/Nayjest/Gito) — 置信度優先的問題過濾。
- [reviewdog](https://github.com/reviewdog/reviewdog) — 通用 lint 輸出橋接；作為分類器的靜態分析輸入。
- [Danger.js](https://github.com/danger/danger-js) — 冪等評論更新/清理模式，應用於 PR 內容摘要區塊。

核心創新是**帶有數學收斂保證的多機器人編排層**——這在上述任何專案中都不存在。
