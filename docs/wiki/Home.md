# Maestro Repo Wiki

> 統一調度 AI PR 審查機器人的收斂層。以下 78 頁由 Qoder Repo Wiki 產生，內容對應 `master` 分支；程式碼連結皆指向本倉庫，Mermaid 圖表由 GitHub 直接渲染。

**原始碼**：[mikeah2011/maestro](https://github.com/mikeah2011/maestro) ｜ **設計文件**：[docs/DESIGN.md](https://github.com/mikeah2011/maestro/blob/master/docs/DESIGN.md) ｜ **README**：[README.md](https://github.com/mikeah2011/maestro/blob/master/README.md)

---

### 總覽與指南

- [部署與發布](./%E9%83%A8%E7%BD%B2%E8%88%87%E7%99%BC%E5%B8%83.md)
- [測試策略](./%E6%B8%AC%E8%A9%A6%E7%AD%96%E7%95%A5.md)
- [開發者指南](./%E9%96%8B%E7%99%BC%E8%80%85%E6%8C%87%E5%8D%97.md)
- [快速開始](./%E5%BF%AB%E9%80%9F%E9%96%8B%E5%A7%8B.md)
- [專案概覽](./%E5%B0%88%E6%A1%88%E6%A6%82%E8%A6%BD.md)
- [資料模型](./%E8%B3%87%E6%96%99%E6%A8%A1%E5%9E%8B.md)
- [API 參考](./API%20%E5%8F%83%E8%80%83.md)
- [Git 平台整合](./Git%20%E5%B9%B3%E5%8F%B0%E6%95%B4%E5%90%88.md)

### 系統架構

- [系統架構](./%E7%B3%BB%E7%B5%B1%E6%9E%B6%E6%A7%8B.md)
- [系統上下文與分層架構](./%E7%B3%BB%E7%B5%B1%E4%B8%8A%E4%B8%8B%E6%96%87%E8%88%87%E5%88%86%E5%B1%A4%E6%9E%B6%E6%A7%8B.md)
- [Git Platform 整合](./Git%20Platform%20%E6%95%B4%E5%90%88.md)
- [核心循環引擎（LoopOrchestrator）](./%E6%A0%B8%E5%BF%83%E5%BE%AA%E7%92%B0%E5%BC%95%E6%93%8E%EF%BC%88LoopOrchestrator%EF%BC%89.md)
- [輪次預算（RoundBudget）](./%E8%BC%AA%E6%AC%A1%E9%A0%90%E7%AE%97%EF%BC%88RoundBudget%EF%BC%89.md)
- [事件系統（EventEmitter）](./%E4%BA%8B%E4%BB%B6%E7%B3%BB%E7%B5%B1%EF%BC%88EventEmitter%EF%BC%89.md)
- [提交節流（CommitThrottle）](./%E6%8F%90%E4%BA%A4%E7%AF%80%E6%B5%81%EF%BC%88CommitThrottle%EF%BC%89.md)
- [問題處理管道](./%E7%B3%BB%E7%B5%B1%E6%9E%B6%E6%A7%8B%20%E2%80%94%20%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93.md)
- [狀態機（StateMachine）](./%E7%8B%80%E6%85%8B%E6%A9%9F%EF%BC%88StateMachine%EF%BC%89.md)
- [AI Provider 架構](./AI%20Provider%20%E6%9E%B6%E6%A7%8B.md)
- [AIProvider 抽象介面](./AI%20Provider%20%E6%9E%B6%E6%A7%8B%20%E2%80%94%20AIProvider%20%E6%8A%BD%E8%B1%A1%E4%BB%8B%E9%9D%A2.md)
- [Classifier 分類器](./%E7%B3%BB%E7%B5%B1%E6%9E%B6%E6%A7%8B%20%E2%80%94%20%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20Classifier%20%E5%88%86%E9%A1%9E%E5%99%A8.md)
- [ClaudeCodeProvider（claude CLI）](./AI%20Provider%20%E6%9E%B6%E6%A7%8B%20%E2%80%94%20ClaudeCodeProvider%EF%BC%88claude%20CLI%EF%BC%89.md)
- [ClaudeProvider（Anthropic API）](./AI%20Provider%20%E6%9E%B6%E6%A7%8B%20%E2%80%94%20ClaudeProvider%EF%BC%88Anthropic%20API%EF%BC%89.md)
- [ConvergenceMonitor 收斂監控](./%E7%B3%BB%E7%B5%B1%E6%9E%B6%E6%A7%8B%20%E2%80%94%20%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20ConvergenceMonitor%20%E6%94%B6%E6%96%82%E7%9B%A3%E6%8E%A7.md)
- [Dedup 三層去重管道](./%E7%B3%BB%E7%B5%B1%E6%9E%B6%E6%A7%8B%20%E2%80%94%20%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20Dedup%20%E4%B8%89%E5%B1%A4%E5%8E%BB%E9%87%8D%E7%AE%A1%E9%81%93.md)
- [FixEngine 自動修復引擎](./FixEngine%20%E8%87%AA%E5%8B%95%E4%BF%AE%E5%BE%A9%E5%BC%95%E6%93%8E.md)
- [SecretScanner 敏感資訊掃描](./%E7%B3%BB%E7%B5%B1%E6%9E%B6%E6%A7%8B%20%E2%80%94%20%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20SecretScanner%20%E6%95%8F%E6%84%9F%E8%B3%87%E8%A8%8A%E6%8E%83%E6%8F%8F.md)

### 核心循環引擎

- [核心循環引擎](./%E6%A0%B8%E5%BF%83%E5%BE%AA%E7%92%B0%E5%BC%95%E6%93%8E.md)
- [CommitThrottle 提交節流](./CommitThrottle%20%E6%8F%90%E4%BA%A4%E7%AF%80%E6%B5%81.md)
- [EventEmitter 事件系統](./EventEmitter%20%E4%BA%8B%E4%BB%B6%E7%B3%BB%E7%B5%B1.md)
- [LoopOrchestrator 循環協調器](./LoopOrchestrator%20%E5%BE%AA%E7%92%B0%E5%8D%94%E8%AA%BF%E5%99%A8.md)
- [RoundBudget 輪次預算](./RoundBudget%20%E8%BC%AA%E6%AC%A1%E9%A0%90%E7%AE%97.md)
- [StateMachine 狀態機](./StateMachine%20%E7%8B%80%E6%85%8B%E6%A9%9F.md)

### 問題處理管道

- [問題處理管道](./%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93.md)
- [Classifier 分類器](./%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20Classifier%20%E5%88%86%E9%A1%9E%E5%99%A8.md)
- [ConvergenceMonitor 收斂監控](./%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20ConvergenceMonitor%20%E6%94%B6%E6%96%82%E7%9B%A3%E6%8E%A7.md)
- [Dedup 三層去重管道](./%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20Dedup%20%E4%B8%89%E5%B1%A4%E5%8E%BB%E9%87%8D%E7%AE%A1%E9%81%93.md)
- [SecretScanner 敏感資訊掃描](./%E5%95%8F%E9%A1%8C%E8%99%95%E7%90%86%E7%AE%A1%E9%81%93%20%E2%80%94%20SecretScanner%20%E6%95%8F%E6%84%9F%E8%B3%87%E8%A8%8A%E6%8E%83%E6%8F%8F.md)

### AI 自動修復引擎

- [AI 自動修復引擎](./AI%20%E8%87%AA%E5%8B%95%E4%BF%AE%E5%BE%A9%E5%BC%95%E6%93%8E.md)
- [AIProvider 抽象介面](./AI%20%E8%87%AA%E5%8B%95%E4%BF%AE%E5%BE%A9%E5%BC%95%E6%93%8E%20%E2%80%94%20AIProvider%20%E6%8A%BD%E8%B1%A1%E4%BB%8B%E9%9D%A2.md)
- [ClaudeCodeProvider（claude CLI）](./AI%20%E8%87%AA%E5%8B%95%E4%BF%AE%E5%BE%A9%E5%BC%95%E6%93%8E%20%E2%80%94%20ClaudeCodeProvider%EF%BC%88claude%20CLI%EF%BC%89.md)
- [ClaudeProvider（Anthropic API）](./AI%20%E8%87%AA%E5%8B%95%E4%BF%AE%E5%BE%A9%E5%BC%95%E6%93%8E%20%E2%80%94%20ClaudeProvider%EF%BC%88Anthropic%20API%EF%BC%89.md)
- [FixEngine 修復引擎](./FixEngine%20%E4%BF%AE%E5%BE%A9%E5%BC%95%E6%93%8E.md)

### CLI 命令參考

- [CLI 命令參考](./CLI%20%E5%91%BD%E4%BB%A4%E5%8F%83%E8%80%83.md)
- [maestro audit — 審計分類決策](./maestro%20audit%20%E2%80%94%20%E5%AF%A9%E8%A8%88%E5%88%86%E9%A1%9E%E6%B1%BA%E7%AD%96.md)
- [maestro doctor — 環境診斷](./maestro%20doctor%20%E2%80%94%20%E7%92%B0%E5%A2%83%E8%A8%BA%E6%96%B7.md)
- [maestro init — 初始化設定](./maestro%20init%20%E2%80%94%20%E5%88%9D%E5%A7%8B%E5%8C%96%E8%A8%AD%E5%AE%9A.md)
- [`bots list` — 列出機器人](./bots%20list%20%E2%80%94%20%E5%88%97%E5%87%BA%E6%A9%9F%E5%99%A8%E4%BA%BA.md)
- [`maestro loop status` — 查看狀態](./loop%20status%20%E2%80%94%20%E6%9F%A5%E7%9C%8B%E7%8B%80%E6%85%8B.md)
- [循環恢復 — `maestro loop resume`](./loop%20resume%20%E2%80%94%20%E6%81%A2%E5%BE%A9%E5%BE%AA%E7%92%B0.md)
- [bots register — 註冊機器人](./bots%20register%20%E2%80%94%20%E8%A8%BB%E5%86%8A%E6%A9%9F%E5%99%A8%E4%BA%BA.md)
- [bots unregister — 移除機器人](./bots%20unregister%20%E2%80%94%20%E7%A7%BB%E9%99%A4%E6%A9%9F%E5%99%A8%E4%BA%BA.md)
- [loop start — 啟動循環](./loop%20start%20%E2%80%94%20%E5%95%9F%E5%8B%95%E5%BE%AA%E7%92%B0.md)
- [loop stop — 停止循環](./loop%20stop%20%E2%80%94%20%E5%81%9C%E6%AD%A2%E5%BE%AA%E7%92%B0.md)
- [maestro bots — 機器人管理](./maestro%20bots%20%E2%80%94%20%E6%A9%9F%E5%99%A8%E4%BA%BA%E7%AE%A1%E7%90%86.md)
- [maestro loop — 循環控制](./maestro%20loop%20%E2%80%94%20%E5%BE%AA%E7%92%B0%E6%8E%A7%E5%88%B6.md)

### 設定指南

- [設定指南](./%E8%A8%AD%E5%AE%9A%E6%8C%87%E5%8D%97.md)
- [環境變數展開語法](./%E7%92%B0%E5%A2%83%E8%AE%8A%E6%95%B8%E5%B1%95%E9%96%8B%E8%AA%9E%E6%B3%95.md)
- [設定優先順序與載入機制](./%E8%A8%AD%E5%AE%9A%E5%84%AA%E5%85%88%E9%A0%86%E5%BA%8F%E8%88%87%E8%BC%89%E5%85%A5%E6%A9%9F%E5%88%B6.md)
- [Bots Registry 設定](./Bots%20Registry%20%E8%A8%AD%E5%AE%9A.md)
- [Git Platforms 設定](./Git%20Platforms%20%E8%A8%AD%E5%AE%9A.md)
- [Language Plugins 設定](./Language%20Plugins%20%E8%A8%AD%E5%AE%9A.md)
- [Security 設定](./Security%20%E8%A8%AD%E5%AE%9A.md)
- [Stop Conditions 設定](./Stop%20Conditions%20%E8%A8%AD%E5%AE%9A.md)
- [自訂 HTTP 提供者](./Custom%20HTTP%20Provider.md)
- [AI Providers 設定](./AI%20Providers%20%E8%A8%AD%E5%AE%9A.md)
- [Claude Provider（Anthropic API）](./Claude%20Provider%EF%BC%88Anthropic%20API%EF%BC%89.md)
- [Google Gemini Provider](./Google%20Gemini%20Provider.md)
- [Local Ollama Provider](./Local%20Ollama%20Provider.md)
- [OpenAI Provider](./OpenAI%20Provider.md)
- [Provider Routing Table 配置](./Provider%20Routing%20Table%20%E9%85%8D%E7%BD%AE.md)

### 外部整合與擴充

- [外部整合與擴充](./%E5%A4%96%E9%83%A8%E6%95%B4%E5%90%88%E8%88%87%E6%93%B4%E5%85%85.md)
- [自訂 AI Provider](./%E8%87%AA%E8%A8%82%20AI%20Provider.md)
- [自訂 Git Platform](./%E8%87%AA%E8%A8%82%20Git%20Platform.md)
- [Bot Registry 擴充](./Bot%20Registry%20%E6%93%B4%E5%85%85.md)
- [Claude Code Skill 整合](./Claude%20Code%20Skill%20%E6%95%B4%E5%90%88.md)
- [GitHub Action 使用](./GitHub%20Action%20%E4%BD%BF%E7%94%A8.md)
- [GitLab CI 範本](./GitLab%20CI%20%E7%AF%84%E6%9C%AC.md)
- [MCP Server 整合](./MCP%20Server%20%E6%95%B4%E5%90%88.md)

---

共 78 頁。
