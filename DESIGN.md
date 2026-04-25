# Maestro — Design Document

> Public-facing technical summary. The full implementation plan is tracked internally; this document captures the **shape of the system** and the **design invariants** that guide its evolution.

---

## 1. Problem statement

Modern PRs receive automated reviews from multiple AI bots — CodeRabbit, Ellipsis, Copilot Code Review, Codex, Gemini Code Assist, Sourcery, Greptile. Each bot is good at finding issues; none of them is good at **finishing the conversation**. Authors hand-drive a tedious loop:

1. Read bot comments across multiple threads.
2. Decide which findings are real bugs vs. YAGNI vs. wrong.
3. Fix the real ones, push back on the wrong ones, defer YAGNI.
4. Reply in-thread, resolve threads, request re-review.
5. Repeat — often forever, because each round can introduce new findings.

Failures of the manual loop include comment spam, missed real bugs, fix oscillation, copy-pasting between AI tools, merging because of fatigue rather than convergence.

Existing tools either *replace* one of the bots (PR-Agent, Gito, coderabbitai/ai-pr-reviewer) or run static analysis (reviewdog, Danger.js). **No OSS tool today orchestrates multiple review bots with convergence guarantees.** That is the wedge `maestro` fills.

---

## 2. Position

`maestro` is the **convergence layer above review bots**, not another reviewer. It treats CodeRabbit / Ellipsis / Copilot / etc. as inputs. Its outputs are: classified findings, in-thread replies, fix commits, resolved threads, a final PR-body rollup, and a mathematical guarantee that the loop terminates.

> "CodeRabbit reviews your PR. `maestro` closes the loop — orchestrates every bot you use, enforces convergence in ≤3 rounds, writes the merge-ready summary."

---

## 3. Architecture

Two layers, no more:

### A. Core (TypeScript library + Bun-compiled CLI binary)

All stateful logic. Tool-agnostic. Modules:

| Module | Responsibility |
|---|---|
| `Config` | Zod-validated YAML. Layered precedence: CLI flags → env → repo `.maestro.yaml` → user `~/.maestro/config.yaml` → defaults. |
| `Platform` | Interface with concrete `GitHubPlatform`, `GitLabPlatform`, `GiteaPlatform`, `GiteePlatform` implementations. Abstracts: get-PR, list-reviews, read-comments, reply-in-thread, resolve-thread, update-PR-body, request-reviewers, get-CI-status, get-HEAD-SHA. |
| `AIProvider` | Existing factory (Claude / OpenAI / Gemini / local / custom). Per-stage routing table — cheap models for high-volume ops (commit messages, unknown-finding classification), strong models for judgment ops (PR-body drafting, taste detection, final summary). |
| `BotRegistry` | Hybrid: shipped curated registry (8 bots, with per-bot parsers) + convention-based fallback + user override + `maestro bots register --login` CLI. Each entry has a parser tailored to that bot's comment structure. |
| `Classifier` | **Fenced**: deterministic rules short-circuit before any LLM call. Keywords (NPE, SQL injection, etc.), bot-assigned severity, sensitive paths (`auth/`, `crypto/`, `payment/`) all bypass the LLM. Only unknown findings go to the model. Every decision is shadow-logged for audit. |
| `Dedup` | **3-tier, cheapest first**: (1) exact hash on `(file, line_bucket=5, category)` kills ~60%; (2) fuzzy match on Levenshtein-normalized title kills another ~25%; (3) semantic LLM dedup capped at 10 calls/round for the rest. Property-tested for idempotence + associativity. |
| `ThreadManager` | In-thread replies only — never top-level PR comments during the loop. Resolves threads via platform-native API (GitHub `resolveReviewThread` mutation; degraded-mode fallback for platforms without thread-resolve support). |
| `CommitThrottle` | Accumulates all fixes for a round into one commit with a structured message. |
| `RoundBudget` | **Runtime assertions that throw, not warn.** Enforces anti-spam invariants: ≤1 commit per round, ≤1 reply per thread per round, ≤1 PR-body update per round, classify call memoized per finding, ≤1 reviewer request per round. Violation crashes the process — no silent drift. |
| `ConvergenceMonitor` | Computes Jaccard similarity between successive critical-finding sets. If `> 0.7` (oscillation), stops and escalates. Enforces no-new-finding-category-after-round-2 and `\|criticals(n+1)\| ≤ \|criticals(n)\|`. Finding hash uses `sha1(file + line_bucket + normalized_category + sha1(surrounding 10-line content))` so it's stable under both paraphrase **and** line-shift from rebase. |
| `StateMachine` | States: `Idle → Writing → PreFlight → PRCreated → WaitingForCI → WaitingForBot → Classifying → Fixing → CommitPushed → Replying → Resolving → Stopped`. Error states: `CIFailing`, `BotTimeout`, `HumanIntervened`, `Racing`, `RateLimited`, `TokenExpired`. Every transition emits a structured JSONL event. |
| `PRBodyUpdater` | Idempotent: replaces content between `<!-- maestro:start -->` and `<!-- maestro:end -->`, never appends. |
| `SecretScanner` | Scans every outgoing reply and PR-body update against configurable redaction patterns. Bot quotes can leak secrets; our echo must not persist them. |
| `CostTracker` | Hard `--cost-budget` cap. Token + dollar reporting per run as JSONL. |
| `EventEmitter` | Single source of UI truth: structured JSONL events read by Claude Code skill, MCP server, plain `tail -f`, future GitHub Action UI. |

### B. Language plugins

Drop-in, shell-invoked. Each exposes `lint() / typecheck() / test() / format()`. Shipped plugins: TS/JS, Python, Go, Rust. Community contributions for other languages welcome.

### Not a layer

AI-tool adapters (Claude Code skill, Cursor rules, Gemini CLI hooks, Copilot CLI integration) are **documentation snippets and 30-line shell wrappers**, not a code layer. They all invoke the `maestro` CLI and render the JSONL event stream in their own UI. A single MCP server exposes `start_loop / get_status / stop_loop / get_round_summary` — once that ships, every MCP-capable agent (Claude Desktop, Cursor, Gemini Desktop) integrates for free.

The reusable principle:

> **CLI is the process. Skill is the window.** Long-running orchestration logic lives in the CLI; UI tools are monitors that read events and dispatch control commands.

---

## 4. State machine

```
Idle
  → [author writes + maestro preflight] → PreFlight (local self-review + lint + test)
  → [push] → PRCreated (AI-generated body, reviewers requested)
  → WaitingForCI
      ├→ [CI green] → WaitingForBot
      ├→ [CI fail]  → CIFailing → {retry-with-fix | exit + notify}
  → WaitingForBot (with 90s quiet-period debounce)
      ├→ [bot posted review] → Racing → wait 90s → Classifying
      ├→ [N polls without review] → BotTimeout → {skip-bot | stop}
  → Classifying (RoundBudget starts ticking)
      → [critical findings exist] → Fixing
      → [only taste/duplicate findings] → Stopped(clean)
      → [duplicate findings = oscillation detected] → Stopped(escalate)
  → Fixing → CommitPushed (one commit) → WaitingForCI (re-loop)
  → Replying (in-thread, one reply per finding)
  → Resolving (close threads where applicable)
  → request re-review → WaitingForBot (round R+1)
  → [3 rounds completed OR Jaccard>0.7 OR no-new-categories violated] → Stopped → Finalize
```

Cross-cutting transitions:

- Any state + HEAD SHA changed externally → `HumanIntervened` → `Paused` (waits for `--resume`).
- Any state + 401/403 from platform → `TokenExpired` → exit + notify.
- Any state + rate-limit hit → `RateLimited` → exponential backoff respecting `X-RateLimit-Remaining`.

Every transition emits a JSONL event. Every write goes through `RoundBudget`.

---

## 5. Anti-spam invariants

These are **not** policies that can be overridden by config. They are runtime assertions in `RoundBudget`:

```
commits_this_round           ≤ 1
replies_per_thread_per_round ≤ 1
pr_body_updates_per_round    ≤ 1
classify_calls_per_finding   ≤ 1   (memoized)
reviewer_requests_per_round  ≤ 1
total_api_writes_per_round   ≤ (1 + |threads| + 1 + 1)
```

Any code path that attempts to violate these throws. There is no `--force` flag. The reasoning is that when the loop misbehaves it must misbehave loudly; a warning that gets logged but ignored is exactly how production tools accumulate spam over time.

---

## 6. Convergence guarantees

Termination *is* guaranteed by the hard cap. **Convergence on quality** is a separate property and requires three additional invariants:

1. **Monotone non-increasing critical set.** `|criticals(round n+1)| ≤ |criticals(round n)|`. Violation = fix regression → escalate.
2. **No new finding category after round 2.** If round 3 introduces a previously-unseen category, the fix in round 2 created a new bug class → escalate.
3. **Stable finding hash.** Defined as `sha1(file + line_bucket(=5) + normalized_category + sha1(surrounding_10_line_content))`. Stable under:
   - Bot paraphrasing (same file/line/category produces same hash).
   - Line-shift from user rebase or unrelated edits (content hash anchors to surroundings).

If `Jaccard(criticals_n, criticals_n-1) > 0.7`, the loop is oscillating — same set keeps reappearing — `ConvergenceMonitor` stops and escalates rather than burning the remaining budget.

---

## 7. Multi-platform commitment

`maestro` ships with all four Git platforms (GitHub, GitLab, Gitea, Gitee) as first-class implementations of the `Platform` interface. Realistic note:

| Platform | API | Thread/resolve mechanics | Bot ecosystem | Notes |
|---|---|---|---|---|
| **GitHub** | REST + GraphQL | `resolveReviewThread` mutation | Strongest (8+ bots) | The reference platform |
| **GitLab** | REST v4 + GraphQL | Discussion `resolved` field | Medium (Duo, Ellipsis, Sourcery) | Full parity |
| **Gitea** | REST v1 | Limited; some versions lack resolve | Weak (mostly self-hosted custom bots) | Degraded mode: write resolution sentinel into reply body |
| **Gitee** | REST | Similar to Gitea | Weak | Same degraded-mode handling |

`BotRegistry` is partitioned by platform — we don't try to detect a GitHub-only bot on Gitea.

---

## 8. Distribution (planned)

### MVP

1. **npm `@mikeah2011/maestro`** — `npx @mikeah2011/maestro@latest init` for instant use; CLI binary name is fixed to `maestro` regardless of npm name.
2. **Bun-compiled binaries** via GitHub Releases + `install.sh`. Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. Zero runtime dependencies. (Windows in Phase 2.)
3. **GitHub Action `mikeah2011/maestro-action@v1`** — single-line `run: maestro loop start --pr ${{ github.event.number }}`.
4. **GitLab CI Component / `.gitlab-ci.yml` template** — first-class because we ship four platforms.
5. **Claude Code skill** — ~30 lines, invokes the CLI and tails the JSONL event stream into TodoWrite.

### Phase 2

6. Homebrew tap.
7. Docker image (`gh` + `glab` + `tea` pre-installed for self-hosted CI).
8. **MCP server** (`maestro mcp serve`) — once shipped, Cursor / Gemini Desktop / Claude Desktop / any MCP-capable agent integrates for free.

### Deferred indefinitely

Cursor `.cursorrules` / Gemini `GEMINI.md` / Copilot CLI shell hooks → README copy-paste snippets, no per-tool adapter code. MCP supersedes them.

---

## 9. Out of scope (v0.1)

- Windows binaries.
- Fully autonomous "merge without human approval" mode — every round still requires human acknowledgement of the fix commit before push.
- Bot account impersonation. Replies go out as the user's token; the agent never tries to look like CodeRabbit or any other bot.
- NDA-protected bot parsers. Community can contribute their own via `BotRegistry`.
- Non-PR review surfaces (issue comments, discussions).
- Adaptive model routing. Routing is configured statically per stage in v0.1.

---

## 10. Acknowledgements

- [PR-Agent (Qodo)](https://github.com/qodo-ai/pr-agent) — JSON-configurable LLM prompt structure; PR Compression for very large diffs.
- [Gito](https://github.com/Nayjest/Gito) — confidence-first finding filtering.
- [reviewdog](https://github.com/reviewdog/reviewdog) — universal lint-output bridge; we depend on it as a static-analysis input to the classifier.
- [Danger.js](https://github.com/danger/danger-js) — idempotent comment update / cleanup pattern, applied to our PR-body rollup section.
- The internal bash reference implementation at `internal-reference-repo/scripts/auto-pr-review-loop.sh` — semantic source of truth for round mechanics, GraphQL thread resolution, and state-file format. We port semantics, not syntax.

The novel contribution is the **multi-bot orchestration layer with mathematical convergence guarantees** — not present in any of the above.
