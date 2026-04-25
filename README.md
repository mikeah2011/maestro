# Maestro

> Orchestrate every AI PR review bot. Close the loop. Ship merged.

`maestro` is **not another code reviewer.** CodeRabbit, Ellipsis, Copilot Code Review, Codex, Gemini Code Assist, Sourcery — those are already excellent reviewers. The missing piece is what happens *after* the review: classifying findings, fixing real bugs, replying in-thread, resolving threads, requesting re-review, knowing when to stop. `maestro` is the convergence layer on top of your bots.

```
[ you push code ]
       │
       ▼
[ CodeRabbit reviews ]   [ Ellipsis reviews ]   [ Copilot reviews ]
       │                        │                       │
       └──────────┬─────────────┴───────────────────────┘
                  ▼
            ┌──────────┐
            │ maestro  │  ← classify · dedup · fix · reply · resolve
            └──────────┘
                  │
                  ▼
       (loop until ≤3 rounds OR convergence OR escalate)
                  │
                  ▼
            [ ready to merge ]
```

---

## Why this exists

CodeRabbit and Ellipsis are great at finding issues. They are not great at *finishing the conversation*. You fix five out of eight findings, push back on two, miss one real bug. Ten minutes later the bot re-reviews and finds three new ones. The loop never converges; you merge when you're tired, not when it's done.

`maestro` runs a hard-capped convergence loop with deterministic stop conditions:

- **Hard cap: 3 rounds.** No exceptions.
- **Monotone non-increasing critical-finding set.** If round N+1 has more critical findings than round N, escalate to human.
- **Convergence detection.** Same findings reappearing across rounds (Jaccard > 0.7) → stop and escalate.
- **Anti-spam by construction.** Runtime assertions enforce ≤1 commit per round, ≤1 reply per thread per round, ≤1 PR-body update per round. Violations crash the process — no silent drift.

---

## Quick start (target UX, M1+)

```bash
# install
npx @mikeah2011/maestro@latest init     # scaffold .maestro.yaml
maestro doctor                     # verify gh/glab/tea CLIs, tokens, AI keys

# run on an open PR
maestro loop start --pr 42         # background; emits JSONL events
maestro loop status                # see current state
maestro audit --pr 42              # replay every classification decision
```

Or in CI:

```yaml
# .github/workflows/review-loop.yml
- uses: mikeah2011/maestro-action@v1
  with:
    pr: ${{ github.event.number }}
```

---

## What's in this repo right now

`maestro` is in **active early development.** This repo currently contains:

- **Factories** — `AIProviderFactory` and `GitPlatformFactory` (Claude/OpenAI/Gemini/local; GitHub/GitLab/Gitea/Gitee).
- **Config example** — [`.maestro.example.yaml`](./.maestro.example.yaml) shows the orchestrator config shape (bots, stop conditions, per-stage AI routing).
- **Design document** — [`DESIGN.md`](./DESIGN.md) is the public technical summary.

The convergence loop, classifier, bot registry, dedup, state machine, and CLI are tracked under [milestones](#roadmap). Reference implementation in bash exists at `internal-reference-repo/scripts/auto-pr-review-loop.sh` (internal); we are porting its semantics.

---

## Multi-platform, multi-AI, multi-language

| Layer | Pluggable surfaces |
|---|---|
| **AI Provider** | Claude, OpenAI, Gemini, local (Ollama), custom HTTP endpoint |
| **Git Platform** | GitHub, GitLab, Gitea, Gitee |
| **Review Bots** | CodeRabbit, Ellipsis, Copilot Code Review, Codex, Gemini Code Assist, Sourcery, Greptile, Cursor BugBot — plus convention-based detection for self-hosted bots |
| **Language Plugin** | TS/JS, Python, Go, Rust (community contributions welcome) |

Per-stage AI routing keeps cost down: cheap model for commit-message generation and unknown-finding classification; strong model for PR-body drafting and final summary.

---

## Configuration shape

See [`.maestro.example.yaml`](./.maestro.example.yaml) for the full schema. Highlights:

```yaml
ai:
  routing:
    commitMessage:    claude-haiku-4-5    # cheap
    classification:   claude-sonnet-4-6   # strong
    finalSummary:     claude-opus-4-7     # strongest
    fallback:         claude-haiku-4-5

platform:
  type: github
  auth: { tokenEnv: GITHUB_TOKEN }

bots:
  registry:
    - login: coderabbitai            # treatAs: blocking
    - login: ellipsis-dev[bot]
    - login: copilot-pull-request-reviewer
    - login: codex-connector

stopConditions:
  maxRounds: 3
  jaccardCeiling: 0.7
  tasteDetection: { enabled: true, reviewerModel: claude-sonnet-4-6 }
  ciFail: exit

plugins:
  languages:
    typescript: { lint: "pnpm eslint", typecheck: "pnpm tsc --noEmit", test: "pnpm vitest run" }
```

Config layering follows git's mental model: CLI flags → env vars → repo `.maestro.yaml` → user `~/.maestro/config.yaml` → defaults.

---

## Comparison

|                                  | maestro | CodeRabbit | Ellipsis | PR-Agent | reviewdog |
|---|---|---|---|---|---|
| Reviews code itself              | No¹     | Yes        | Yes      | Yes      | No (linters) |
| Orchestrates *other* bots        | **Yes** | No         | No       | No       | No |
| Multi-round convergence loop     | **Yes** | Partial    | Partial  | No       | No |
| Hard stop conditions             | **Yes** | No         | No       | No       | No |
| Anti-spam runtime invariants     | **Yes** | No         | No       | No       | No |
| Tool-agnostic (CLI/Action/MCP)   | **Yes** | App only   | App only | Action   | Multi |
| Self-hostable, OSS               | **Yes** | OSS subset | No       | Yes      | Yes |

¹ `maestro` does run local pre-push self-review (calls your AI of choice), but its core value is orchestrating external review bots.

---

## Roadmap

| Milestone | Status | What lands |
|---|---|---|
| M0 — Naming + reframe | done | Repo renamed, README + config rewritten, DESIGN.md published |
| M1 — CLI + config + Platform interface | next | Bun-compiled `maestro` binary, Zod schema, `init` + `doctor` |
| M2 — Loop port (GitHub) | | StateMachine, RoundBudget, CommitThrottle, EventEmitter |
| M3 — Convergence + classifier | | ConvergenceMonitor, fenced Classifier, 3-tier Dedup, SecretScanner |
| M4 — Bot registry | | CodeRabbit + Ellipsis + Copilot + Codex parsers |
| M5 — Other 3 platforms | | GitLab + Gitea + Gitee implementations |
| M6 — Distribution | | GitHub Releases binaries, GitHub Action, GitLab CI Component, Claude Code skill |
| M7 — Phase 2 | | Homebrew tap, Docker image, MCP server, more language plugins |

---

## Adoption phases

The project is being dogfooded internally before public OSS launch. Phases:

- **P0 self-dogfood** (in progress) — single-author, single-repo, prove the loop converges.
- **P1 team pilot** — 3–5 internal repos, 4 weeks, NPS + cost-per-PR metrics.
- **P2 org-wide** — 20+ repos, runbook, on-call, p50 loop completion <30 min.
- **P3 public OSS** — zero internal deps, external contributor onboarding works, public launch.

---

## License

Pending — will be MIT or Apache-2.0 before public release. internal use is granted under the existing employment relationship.

## Contributing

Public contributions are not yet open. The project will accept external contributions starting at P3 (public OSS phase). Until then, internal contributors can open PRs directly.

---

## Acknowledgements

`maestro` borrows ideas from:
- [PR-Agent (Qodo)](https://github.com/qodo-ai/pr-agent) — JSON-configurable LLM prompts, PR compression for large diffs.
- [Gito](https://github.com/Nayjest/Gito) — confidence-first finding filtering.
- [reviewdog](https://github.com/reviewdog/reviewdog) — universal lint-output → PR-comment bridge (we depend on it as a static-analysis source).
- [Danger.js](https://github.com/danger/danger-js) — idempotent comment update / cleanup pattern for the PR-body rollup section.

The novel contribution is the multi-bot orchestration layer with mathematical convergence guarantees — not present in any of the above.
