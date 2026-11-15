# SecretScanner 敏感資訊掃描

**本文引用的檔案**

- [SecretScanner.ts](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts)
- [SecretScanner.test.ts](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts)
- [DESIGN.md](https://github.com/mikeah2011/maestro/blob/master/docs/DESIGN.md)
- [README.md](https://github.com/mikeah2011/maestro/blob/master/README.md)
- [FixEngine.ts](https://github.com/mikeah2011/maestro/blob/master/src/core/fix/FixEngine.ts)
- [GitHubPlatform.ts](https://github.com/mikeah2011/maestro/blob/master/src/platforms/github/GitHubPlatform.ts)

## 目錄
1. [引言](#引言)
2. [專案結構與定位](#專案結構與定位)
3. [核心元件分析](#核心元件分析)
4. [遮蔽模式配置與支援語法](#遮蔽模式配置與支援語法)
5. [遮蔽前後的字串對比範例](#遮蔽前後的字串對比範例)
6. [與外部系統的整合方式](#與外部系統的整合方式)
7. [安全最佳實踐](#安全最佳實踐)
8. [常見問題診斷與調優](#常見問題診斷與調優)
9. [依賴關係圖](#依賴關係圖)
10. [結論](#結論)

## 引言
SecretScanner 是 Maestro 工具中的敏感資訊掃描模組，主要職責是在資料外發至 AI provider、平台 API 或寫入 PR 內容之前，對文字進行掃描並遮蔽敏感內容。它專注於防止 bot 引用程式碼差異時把 API key、token、密碼、個人識別資訊等重新持久化到 PR 討論串或 PR body 中。

根據設計文件，SecretScanner 的公開角色是「掃描每個外發回覆與 PR 內容更新，對照可設定的遮蔽模式」，並強調機器人引用可能洩漏密鑰，因此回聲不能直接持久化原始值。

**章節來源**
- [DESIGN.md:1-200](https://github.com/mikeah2011/maestro/blob/master/docs/DESIGN.md#L1-L200)

## 專案結構與定位
SecretScanner 位於 `src/core/security` 之下，屬於核心安全模組；測試位於 `tests/core/security/SecretScanner.test.ts`。它不直接操作網路請求或 Git 平台，而是提供一個純函數式風格的 `scan(text)` API，由呼叫端決定在什麼 outgoing 路徑中使用。

```mermaid
graph TB
  A["LoopOrchestrator<br/>收斂循環"] --> B["AIProvider<br/>AI 服務提供者"]
  A --> C["GitPlatform<br/>Git 平台適配器"]
  D["SecretScanner<br/>敏感資訊掃描"] --> E["FixEngine<br/>自動修復引擎"]
  D --> F["GitHubPlatform<br/>GitHub 平台實作"]
  G["使用者輸入<br/>PR 評論／回覆／PR Body"] --> D
  D --> H["已遮蔽文字<br/>clean／redacted／findings"]
```

**圖表來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)
- [FixEngine.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/src/core/fix/FixEngine.ts#L1-L200)
- [GitHubPlatform.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/src/platforms/github/GitHubPlatform.ts#L1-L200)

**章節來源**
- [README.md:1-200](https://github.com/mikeah2011/maestro/blob/master/README.md#L1-L200)
- [DESIGN.md:1-200](https://github.com/mikeah2011/maestro/blob/master/docs/DESIGN.md#L1-L200)

## 核心元件分析
### 公開介面
SecretScanner 暴露三個關鍵介面：

| 名稱 | 用途 | 重要欄位說明 |
|---|---|---|
| `SecretPattern` | 定義一條遮蔽規則 | `name` 用於審計與報告；`pattern` 為正規表示式；`redact` 將匹配到的完整字串轉換為安全表示 |
| `SecretFinding` | 記錄一次敏感資訊發現 | `patternName`、`start`、`end`、`redacted` |
| `SecretScanResult` | 掃描結果 | `clean` 表示是否無敏感內容；`redacted` 為遮蔽後字串；`findings` 為所有發現 |

這些介面的設計讓呼叫端可以同時取得「是否需要替換」與「哪些位置被遮蔽」兩種資訊。

**章節來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

### 內建遮蔽模式
系統預設包含以下幾類敏感格式：

| 模式名稱 | 目的 | 處理策略 |
|---|---|---|
| `aws_access_key_id` | AWS Access Key ID | 整段替換為遮蔽標記 |
| `aws_secret_access_key` | AWS Secret Access Key 鍵值對 | 僅遮蔽等號右側的值 |
| `github_token` | GitHub Personal / Server-to-server / Fine-grained token | 保留前綴片段，其餘遮蔽 |
| `private_key_pem` | PEM 私鑰區塊 | 整段替換為私密金鑰遮蔽標記 |
| `jwt` | JSON Web Token | 保留開頭片段，其餘以 JWT 遮蔽標記取代 |
| `stripe_key` | Stripe live/test key | 保留前綴片段，其餘遮蔽 |
| `slack_token` | Slack Bot/App token | 保留前綴片段，其餘遮蔽 |
| `generic_api_key` | 通用 API key 或 access token 鍵值對 | 遮蔽長值部分 |

這些模式適合常見的雲端供應商、開發平台與支付服務 token，但不會涵蓋所有組織內部自訂格式；擴充方式見下一節。

**章節來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

### 掃描演算法流程
掃描過程不是簡單地逐字串比對，而是針對每個 pattern 在原字串上執行全域匹配，並同步維護一個偏移量來修正遮蔽字串中的位置。

```mermaid
flowchart TD
  Start(["進入 scan"]) --> Init["初始化 findings、redacted、offset"]
  Init --> LoopPatterns["依序遍歷所有遮蔽模式"]
  LoopPatterns --> CloneRegex["複製正規表示式並設定全域旗標"]
  CloneRegex --> ResetIndex["重置 lastIndex"]
  ResetIndex --> Match{"找到下一個匹配？"}
  Match -->|是| Record["記錄 start、end、redacted 值"]
  Record --> ApplyRedact["計算遮蔽後字串並更新 offset"]
  ApplyRedact --> Match
  Match -->|否| SortFindings["按 start 索引排序 findings"]
  SortFindings --> Result{"有敏感內容？"}
  Result -->|否| ReturnClean["返回 clean=true、原字串"]
  Result -->|是| ReturnRedacted["返回 redacted 字串與 findings"]
```

**圖表來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

### 時間與空間複雜度
假設輸入字串長度為 \(n\)，pattern 數量為 \(p\)：

| 項目 | 複雜度 | 說明 |
|---|---|---|
| 掃描主迴圈 | \(O(p \times n)\) | 每個 pattern 都對原始字串執行全域匹配 |
| 遮蔽字串更新 | 最壞 \(O(n^2)\) | 每次匹配使用 slice 拼接，若匹配次數多，重複建立新字串 |
| findings 排序 | \(O(f \log f)\) | \(f\) 為敏感內容發現次數 |
| 額外空間 | \(O(n + f)\) | 儲存 redacted 字串與 findings |

優化建議：
- 若 outgoing 文字量很大，可先做快速預篩，例如排除短字串或已知安全字首。
- 大量匹配情境下，可改用單一遍歷位置陣列，最後一次性重建 redacted 字串。
- 可考慮對 pattern 分類（固定字首 vs 自由形式），減少不必要的正則匹配。

**章節來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

## 遮蔽模式配置與支援語法
### 注入方式
SecretScanner 的建構子接受 `extraPatterns`，用來追加組織內部或第三方服務的敏感格式。內建模式與自訂模式會合併成同一份 patterns 清單，沒有優先順序覆寫機制；因此新增模式應避免與內建模式產生重疊匹配。

| 欄位 | 類型 | 行為 |
|---|---|---|
| `name` | 字串 | 顯示於 finding 與稽核事件，方便排錯 |
| `pattern` | `RegExp` | 必須不使用 `/g`；scanner 會自行克隆並加上全域旗標 |
| `redact` | 函式 | 接收完整匹配字串，回傳安全的遮蔽結果 |

### 支援的正規表示式語法
由於 pattern 是 JavaScript `RegExp`，因此支援大多數 ECMAScript 正則能力，包括：
- 單字元類別與反斜線轉義
- 群組、非捕獲群組
- 前瞻、後瞻（若需要）
- 量詞、惰性匹配
- 字首/字尾邊界 `\b`

但需注意：
- 不要直接在 pattern 上使用 `/g`，否則 scanner 克隆時會移除該旗標或產生不一致行為。
- 若需大小寫不敏感，請使用 `i` 旗標。
- 跨行內容（如 PEM 私鑰）可使用 `[\s\S]` 搭配惰性匹配。
- 極度高靈敏的模式可能造成誤遮蔽，應搭配最小必要長度限制降低 false positive。

**章節來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

## 遮蔽前後的字串對比範例
以下範例基於單元測試所驗證的行為，展示常見敏感格式在遮蔽前的預期輸入與遮蔽後的處理結果。

### AWS Access Key ID
| 項目 | 內容 |
|---|---|
| 遮蔽前 | `The key is AKIAIOSFODNN7EXAMPLE here.` |
| 遮蔽後 | 不再包含原始 AKIA 開頭金鑰，並包含遮蔽標記 |
| 行為重點 | 即使嵌入句子中間也能偵測 |

**章節來源**
- [SecretScanner.test.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts#L1-L200)

### GitHub Token
| 項目 | 內容 |
|---|---|
| 遮蔽前 | `ghp_`、`ghs_`、`github_pat_` 開頭的 token |
| 遮蔽後 | 不再包含完整 token，通常保留前綴片段以便辨識 |
| 行為重點 | 支援個人權杖、伺服器權杖與細粒度權杖前綴 |

**章節來源**
- [SecretScanner.test.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts#L1-L200)

### JWT
| 項目 | 內容 |
|---|---|
| 遮蔽前 | 三段 base64url 編碼區段以點號連接的 JWT |
| 遮蔽後 | 保留開頭片段，其餘替換為 JWT 遮蔽標記 |
| 行為重點 | 最低長度限制用於降低一般 base64 片段的誤判 |

**章節來源**
- [SecretScanner.test.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts#L1-L200)

### 資料庫連接字串
目前內建模式未直接列出「資料庫連接字串」類別。實務上可透過以下方式處理：
- 使用 `generic_api_key` 模式覆蓋含長值的連線參數。
- 新增自訂 pattern，匹配 `mysql://`、`postgres://`、`mongodb+srv://` 等 URL 型別連接字串。
- 在 `redact` 中只遮蔽帳號、密碼與 host 部分，保留連接類型以便診斷。

此處屬於擴展建議，而非現有內建行為。

### 多個敏感內容
測試驗證了同一筆文字中同時出現 GitHub token 與 AWS key 時，兩者都會被遮蔽，且不會遺漏任一敏感值。

**章節來源**
- [SecretScanner.test.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts#L1-L200)

## 與外部系統的整合方式
### 在 FixEngine 的 outgoing 路徑中注入掃描
FixEngine 的主要流程是：讀取上下文 → 呼叫 AIProvider → 解析 JSON 回應 → 應用修改 → 寫回檔案。雖然當前 FixEngine 實作並未直接呼叫 SecretScanner，但其 outgoing 路徑非常適合注入掃描步驟：

1. 在呼叫 `provider.complete()` 之前，對 prompt 與 context 執行掃描。
2. 若發現敏感內容，使用 `redacted` 字串作為實際提示。
3. 保留 `findings` 供稽核日誌，但不將原始敏感內容送給 AI provider。
4. 若 AI 回應包含敏感內容，可在寫回檔案前再次掃描。

```mermaid
sequenceDiagram
  participant FE as "FixEngine"
  participant SS as "SecretScanner"
  participant AI as "AIProvider"
  participant FS as "Filesystem"

  FE->>FE: 讀取檔案與上下文
  FE->>SS: scan(promptWithContext)
  SS-->>FE: SecretScanResult
  FE->>AI: complete(redactedPrompt)
  AI-->>FE: parsedJson
  FE->>FS: writeFile(redactedContent)
```

**圖表來源**
- [FixEngine.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/src/core/fix/FixEngine.ts#L1-L200)
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

### 在 GitHubPlatform 的 outgoing 路徑中注入掃描
GitHubPlatform 負責與 GitHub REST 與 GraphQL API 互動，包含回覆討論串、解決討論串、更新 PR 內容等操作。適合注入的位置包括：

| 路徑 | 建議注入點 | 原因 |
|---|---|---|
| 回覆討論串 | 發送 `addPullRequestReviewThreadReply` 前 | 防止 bot 引用內容帶出敏感金鑰 |
| 更新 PR Body | 寫入 PR 內容前 | 防止 echo 機制持久化敏感內容 |
| 錯誤訊息 | 對外通知或日誌前 | 避免將原始堆疊或查詢內容外洩 |
| 機器人生成內容 | 任何 platform adapter 的 outgoing text | 符合設計文件中對「外發回覆」的要求 |

```mermaid
sequenceDiagram
  participant Orchestrator as "LoopOrchestrator"
  participant GH as "GitHubPlatform"
  participant SS as "SecretScanner"
  participant API as "GitHub API"

  Orchestrator->>GH: 回覆討論串／更新 PR Body
  GH->>SS: scan(outgoingText)
  SS-->>GH: SecretScanResult
  GH->>API: 傳送 redactedText
  GH-->>Orchestrator: 成功狀態
```

**圖表來源**
- [GitHubPlatform.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/src/platforms/github/GitHubPlatform.ts#L1-L200)
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

**章節來源**
- [DESIGN.md:1-200](https://github.com/mikeah2011/maestro/blob/master/docs/DESIGN.md#L1-L200)
- [FixEngine.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/src/core/fix/FixEngine.ts#L1-L200)
- [GitHubPlatform.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/src/platforms/github/GitHubPlatform.ts#L1-L200)

## 安全最佳實踐
1. **最小化外發文字量**  
   只在必要時掃描 outgoing text。對大型 diff 或冗長 prompt，可先截斷非必要段落，再交由 AI provider 處理。

2. **定期更新遮蔽規則**  
   當引入新的雲端服務、支付服務或內部認證機制時，應新增對應 `SecretPattern`。建議在 CI 中加入涵蓋新格式的測試。

3. **避免將原始錯誤訊息直接傳給第三方 API**  
   錯誤堆疊、SQL 查詢、HTTP 請求體可能包含憑證。應在紀錄前先用 SecretScanner 處理，或直接過濾敏感欄位。

4. **保留 findings 但不外洩敏感內容**  
   `findings` 可用於稽核與排錯，但其中 `redacted` 已是遮蔽值；原始匹配位置可用於內部診斷，不應寫入外部日誌或第三方服務。

5. **謹慎擴充 generic 模式**  
   `generic_api_key` 與類似寬鬆模式容易產生誤遮蔽，應設定最小長度與明確字首限制。

6. **測試 false positive 與 false negative**  
   每新增 pattern 都要加入正反例測試，特別是邊界條件：空字串、短字串、相似但不敏感的常數。

**章節來源**
- [DESIGN.md:1-200](https://github.com/mikeah2011/maestro/blob/master/docs/DESIGN.md#L1-L200)
- [SecretScanner.test.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts#L1-L200)

## 常見問題診斷與調優
### 誤遮蔽（false positive）
**現象**：正常程式碼或文案被當成敏感內容遮蔽。  
**常見原因**：
- 正則過於寬鬆，例如 `generic_api_key` 匹配到一般長字串。
- 字首太短，導致普通變數名或常數被誤判。
- 未使用適當邊界 `\b`，造成部分匹配。

**調優方法**：
- 縮小匹配範圍，要求更明確的字首或鍵名。
- 增加最小長度限制。
- 加入否定前瞻，排除已知安全字首。
- 使用測試用例驗證正常字串不被遮蔽。

### 漏遮蔽（false negative）
**現象**：敏感內容未被偵測，仍可能被外發。  
**常見原因**：
- 使用了新形式的 token 或連接字串。
- 字首變化，例如新版 GitHub token 或內部服務 key 前綴。
- 字串被分割或換行，使單一行無法匹配。

**調優方法**：
- 新增對應 `SecretPattern`。
- 對於多行內容（如 PEM），確保正則支援跨行匹配。
- 在 outgoing 路徑統一掃描，而不是只在某個環節掃描。
- 加入負向測試，確保已知敏感字串一定被遮蔽。

### 遮蔽結果難以診斷
**現象**：知道有敏感內容，但不知道是哪個 pattern 造成的。  
**解法**：
- 檢查 `SecretScanResult.findings` 中的 `patternName`。
- 使用 `start` 與 `end` 定位原始字串中的敏感位置。
- 在稽核日誌中記錄 pattern 名稱與遮蔽結果，但不記錄原始敏感值。

**章節來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)
- [SecretScanner.test.ts:1-200](https://github.com/mikeah2011/maestro/blob/master/tests/core/security/SecretScanner.test.ts#L1-L200)

## 依賴關係圖
```mermaid
classDiagram
  class SecretPattern {
    +string name
    +RegExp pattern
    +redact(match) string
  }

  class SecretFinding {
    +string patternName
    +number start
    +number end
    +string redacted
  }

  class SecretScanResult {
    +boolean clean
    +string redacted
    +SecretFinding[] findings
  }

  class SecretScanner {
    -patterns : SecretPattern[]
    +constructor(extraPatterns)
    +scan(text) SecretScanResult
  }

  SecretScanner --> SecretPattern : "使用"
  SecretScanner --> SecretFinding : "產生"
  SecretScanner --> SecretScanResult : "回傳"
```

**圖表來源**
- [SecretScanner.ts:1-136](https://github.com/mikeah2011/maestro/blob/master/src/core/security/SecretScanner.ts#L1-L136)

## 結論
SecretScanner 提供了一個集中、可擴充且可稽核的敏感資訊遮蔽機制。它的設計重點不在於成為萬能金剛，而在於：
- 在 outgoing 路徑前攔截常見敏感格式。
- 允許組織追加內部與第三方服務的遮蔽規則。
- 提供結構化的 findings，方便稽核與排錯。
- 與 FixEngine、GitHubPlatform 等 outgoing 路徑保持概念性整合點。

生產環境應將其視為防禦層之一，配合最小外發原則、嚴格日誌規範與持續更新的遮蔽規則，才能有效降低敏感資訊外洩風險。