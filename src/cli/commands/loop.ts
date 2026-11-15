/**
 * `maestro loop` — convergence loop subcommands.
 *
 * `loop start --pr <N>` is the primary command (M5+). It:
 *   1. Loads config from .maestro.yaml
 *   2. Initializes the GitHub platform
 *   3. Runs the LoopOrchestrator (classify → fix → commit → reply → resolve)
 *   4. Streams events to stdout as JSONL
 *
 * `loop status`, `loop stop`, `loop resume` remain placeholders until
 * a persistence layer is added in M7.
 */

import type { Command } from 'commander';
import readline from 'readline';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import { loadConfig, ConfigError } from '../../config';
import { GitHubPlatform } from '../../platforms/github/GitHubPlatform';
import { LoopOrchestrator } from '../../core/loop/LoopOrchestrator';
import { EventEmitter, stdoutSink } from '../../core/events/EventEmitter';
import { ClaudeProvider } from '../../ai/providers/ClaudeProvider';
import { ClaudeCodeProvider } from '../../ai/providers/ClaudeCodeProvider';
import { FixEngine } from '../../core/fix/FixEngine';
import { Classifier } from '../../core/classify/Classifier';
import type { AIProvider } from '../../ai/interfaces/AIProvider';
import type { Finding, FindingClassification } from '../../core/types/Finding';
import type { RoundCommit } from '../../core/round/CommitThrottle';

const NOT_YET = 4;

function notYet(action: string): never {
  console.error(chalk.yellow(`maestro loop ${action}: not yet implemented (lands in M7)`));
  console.error(chalk.gray('詳見 docs/DESIGN.md §3（系統架構）。'));
  process.exit(NOT_YET);
}

export function registerLoopCommand(program: Command): void {
  const loop = program.command('loop').description('run the multi-bot review convergence loop on a PR');

  loop
    .command('start')
    .description('start the convergence loop on a PR')
    .requiredOption('--pr <number>', 'PR number to drive')
    .option('--max-rounds <n>', 'override stopConditions.maxRounds', parseInt)
    .option('--cost-budget <usd>', 'override stopConditions.costBudgetUSD', parseFloat)
    .option('--bots <logins>', 'comma-separated bot logins to watch (default: all bots)')
    .option('--dry-run', 'classify and report findings but skip fix, commit, and reply')
    .option('--remote <name>', 'git remote to use for owner/repo auto-detect (default: upstream → origin)')
    .option('--cwd <path>', 'target repo directory for file fixes and git operations (default: current directory)')
    .action(async (opts: { pr: string; maxRounds?: number; costBudget?: number; bots?: string; dryRun?: boolean; remote?: string; cwd?: string }) => {
      const prNumber = parseInt(opts.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber < 1) {
        console.error(chalk.red(`error: --pr must be a positive integer, got "${opts.pr}"`));
        process.exit(2);
      }

      // Resolve target repo directory — all file I/O and git ops run here.
      // Default to CWD so `cd repo && maestro loop start` works without flags.
      const { resolve: resolvePath } = await import('node:path');
      const repoDir = opts.cwd ? resolvePath(opts.cwd) : process.cwd();

      // Load config — uses repoDir as cwd so .maestro.yaml is read from the target repo,
      // and --remote auto-detects owner/repo from that repo's git remotes.
      let config;
      try {
        config = loadConfig({
          cwd: repoDir,
          remote: opts.remote,
          overrides: opts.maxRounds !== undefined ? { stopConditions: { maxRounds: opts.maxRounds } } : undefined,
        });
      } catch (err) {
        if (err instanceof ConfigError) {
          console.error(chalk.red(`config error: ${err.message}`));
          process.exit(3);
        }
        throw err;
      }

      const maxRounds = opts.maxRounds ?? config.stopConditions.maxRounds;
      const botFilter = opts.bots ? opts.bots.split(',').map((s) => s.trim()) : [];
      const isDryRun = opts.dryRun ?? false;

      // Initialize platform
      const platform = new GitHubPlatform({
        tokenEnv: config.platform.auth.tokenEnv ?? 'GITHUB_TOKEN',
        token: config.platform.auth.token,
        baseUrl: config.platform.baseUrl,
        owner: config.platform.owner,
        repo: config.platform.repo,
      });

      try {
        await platform.initialize();
      } catch (err) {
        console.error(chalk.red(`platform error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      // Wire event stream
      const emitter = new EventEmitter();
      emitter.setContext({ round: 0 });
      emitter.subscribe(stdoutSink);
      emitter.subscribe(prettySink);

      emitter.emit('loop.starting', {
        prNumber,
        maxRounds,
        botFilter,
        dryRun: isDryRun,
      });

      // Resolve AI provider — used for both classification AND fixing.
      // Classification always runs (even in dry-run); fixing is skipped in dry-run.
      const aiProvider = await resolveAIProvider(config);

      // Build classifier: wire LLM when available so findings get real categories.
      const classifier = aiProvider
        ? new Classifier({ llmClassify: (f) => llmClassifyFinding(f, aiProvider) })
        : new Classifier();

      // Wire AI fix engine (skipped in dry-run)
      let onFix: LoopOrchestrator['onFix'] | undefined;
      if (!isDryRun && aiProvider) {
        const fixEngine = new FixEngine({ provider: aiProvider, tier: 'strong', repoRoot: repoDir });
        onFix = (findings, round) => fixEngine.fix(findings, round);
      }

      // Wire interactive decision hook (skipped in dry-run)
      const onDecide = isDryRun
        ? undefined
        : async (
            findings: Array<Finding & { classification: FindingClassification }>,
            round: number,
          ): Promise<Map<string, 'fix' | 'defer' | 'reject'>> => {
            const decisions = new Map<string, 'fix' | 'defer' | 'reject'>();

            // Compute AI-recommended defaults: unknown → fix (attempt), taste/yagni → defer, wrong → reject
            for (const f of findings) {
              const cat = f.classification?.category;
              decisions.set(
                f.hash,
                cat === 'taste' || cat === 'yagni' ? 'defer' : cat === 'wrong' ? 'reject' : 'fix',
              );
            }

            // ── AI summary ────────────────────────────────────────────────
            console.error(chalk.bold.cyan(`\n━━ 第 ${round} 輪評論分析 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));

            if (aiProvider && findings.length > 0) {
              try {
                const summaryResult = await aiProvider.complete(
                  buildDecisionSummaryPrompt(findings, round),
                  { maxTokens: 500 },
                );
                console.error(chalk.white(summaryResult.content.trim()));
              } catch {
                printFindingsList(findings, decisions);
              }
            } else {
              printFindingsList(findings, decisions);
            }

            // ── Action summary ────────────────────────────────────────────
            const fixCnt = [...decisions.values()].filter((v) => v === 'fix').length;
            const deferCnt = [...decisions.values()].filter((v) => v === 'defer').length;
            const rejectCnt = [...decisions.values()].filter((v) => v === 'reject').length;
            console.error(
              chalk.yellow(
                `\n建議行動：🔧 修復 ${fixCnt}  ⏭ 延後 ${deferCnt}  ❌ 拒絕 ${rejectCnt}`,
              ),
            );
            console.error(chalk.gray('輸入指令覆蓋（如 "skip 1,3" / "fix 2" / "reject 1"），直接 Enter 確認'));
            console.error(chalk.gray('（30 秒後自動採用建議）'));

            // ── 30-second prompt ──────────────────────────────────────────
            const answer = await promptWithTimeout('> ', 30_000);

            if (answer.trim()) {
              for (const [, action, nums] of answer.matchAll(
                /(fix|defer|reject|skip)\s+([\d,\s]+)/gi,
              )) {
                if (!action || !nums) continue;
                const normalizedAction: 'fix' | 'defer' | 'reject' =
                  /fix/i.test(action) ? 'fix' : /reject/i.test(action) ? 'reject' : 'defer';
                for (const n of nums.split(',')) {
                  const idx = parseInt(n.trim()) - 1;
                  const finding = findings[idx];
                  if (finding) decisions.set(finding.hash, normalizedAction);
                }
              }
            }

            return decisions;
          };

      // Wire commit+push (skipped in dry-run)
      // repoDir is already resolved above from --cwd or process.cwd()
      const git = simpleGit(repoDir);
      const onCommit = async (commit: RoundCommit): Promise<string> => {
        const files = commit.fixes.flatMap((f) => Array.from(f.files ?? [])).filter(Boolean);
        console.error(chalk.gray(`  [git] cwd=${repoDir}  files=${files.length > 0 ? files.join(', ') : '(all)'}`));
        try {
          if (files.length > 0) {
            await git.add(files);
          } else {
            await git.add(['-A']);
          }
          const status = await git.status();
          if (status.staged.length === 0) {
            console.error(chalk.yellow('  [git] 沒有可提交的變更（staged = 0）'));
            emitter.emit('commit.error', { round: commit.round, phase: 'nothing_to_stage', error: '沒有可提交的變更' });
            return '';
          }
          const result = await git.commit(commit.message);
          const sha = result.commit;
          await git.push();
          emitter.emit('commit.pushed', { sha, round: commit.round, fixCount: commit.fixes.length });
          return sha;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`  [git] 錯誤：${msg}`));
          emitter.emit('commit.error', { round: commit.round, phase: 'git', error: msg });
          return '';
        }
      };

      // Wire PR body update on approval (skipped in dry-run)
      const onPRApproved = isDryRun || !aiProvider
        ? undefined
        : async (pr: import('../../core/types/PullRequest').PullRequest, diff: import('../../core/types/PullRequest').PullRequestDiff) => {
            const PLACEHOLDER_RE = /^\s*$|TODO|TBD|WIP|\.\.\.|<!--/i;
            const needsUpdate = !pr.body || pr.body.trim().length < 200 || PLACEHOLDER_RE.test(pr.body);
            if (!needsUpdate) return null;

            const fileList = diff.files
              .slice(0, 20)
              .map((f) => `  - ${f.status === 'added' ? '➕' : f.status === 'removed' ? '➖' : '✏️'} ${f.path} (+${f.additions}/-${f.deletions})`)
              .join('\n');

            const prompt = `你是一位資深工程師，正在為以下 Pull Request 撰寫清晰、精準的 PR 描述（繁體中文）。

PR 標題：${pr.title}
分支：${pr.headBranch} → ${pr.baseBranch}
變更統計：${diff.stats.filesChanged} 個檔案，+${diff.stats.additions} / -${diff.stats.deletions} 行

變更檔案：
${fileList}

${pr.body?.trim() ? `現有描述（可能不完整）：\n${pr.body.trim()}\n` : ''}
請根據以上資訊，產生一份包含以下段落的 PR 描述（使用 Markdown）：
1. ## 摘要 — 2-3 句話說明這個 PR 解決什麼問題或新增什麼功能
2. ## 主要變更 — 列點說明核心改動（技術細節，不要只是複述檔名）
3. ## 測試說明 — 如何驗證這個改動（已有測試、手動驗證步驟等）

只輸出 Markdown 描述，不要加任何前置說明。`;

            try {
              const result = await aiProvider.complete(prompt, { maxTokens: 800, tier: 'strong' });
              return result.content.trim();
            } catch {
              return null;
            }
          };

      // Run the loop
      const orchestrator = new LoopOrchestrator({
        platform,
        emitter,
        classifier,
        onFix: isDryRun ? async () => [] : onFix,
        onCommit: isDryRun ? async () => '' : onCommit,
        onDecide,
        onPRApproved,
        ciPollIntervalMs: 10_000,
        botPollIntervalMs: 30_000,
        botTimeoutMs: config.stopConditions.quietPeriodSec * 1000,
        botTriggerComments: {
          'chatgpt-codex-connector[bot]': '@codex review',
        },
      });

      const result = await orchestrator.run({ prNumber, maxRounds, botFilter, dryRun: isDryRun });

      emitter.emit('loop.done', result as unknown as Record<string, unknown>);

      const exitCode = result.reason === 'error' ? 1 : 0;
      if (exitCode !== 0) {
        console.error(chalk.red(`loop ended with error: ${result.error?.message ?? 'unknown'}`));
      } else {
        const label =
          result.reason === 'approved'
            ? chalk.green('✓ PR approved')
            : result.reason === 'converged'
              ? chalk.cyan('~ converged (no new criticals)')
              : chalk.yellow(`⚠ stopped after ${result.rounds} rounds`);
        console.error(label);
      }

      process.exit(exitCode);
    });

  loop
    .command('status')
    .description('print the current state of an in-flight loop')
    .option('--pr <number>', 'PR number (default: current branch PR)')
    .action(() => notYet('status'));

  loop
    .command('stop')
    .description('stop an in-flight loop')
    .requiredOption('--pr <number>', 'PR number')
    .action(() => notYet('stop'));

  loop
    .command('resume')
    .description('resume a paused loop (after HumanIntervened state)')
    .requiredOption('--pr <number>', 'PR number')
    .action(() => notYet('resume'));
}

// ─── Pretty progress sink ────────────────────────────────────────────────────

const PRETTY: Record<string, (p: Record<string, unknown>) => string> = {
  'loop.starting':    (p) => chalk.bold(`▶ 開始 PR #${p['prNumber']}  最大輪數=${p['maxRounds']}${p['dryRun'] ? '  [dry-run]' : ''}`),
  'state.transition': (p) => chalk.cyan(`  → 狀態：${p['to']}`),
  'ci.polling':       (p) => chalk.gray(`  ⏳ 等待 CI… pending=${p['pending']}  failing=${p['failing']}`),
  'bots.polling':     ()  => chalk.gray(`  ⏳ 等待機器人發佈審查…`),
  'round.start':      (p) => chalk.bold.yellow(`\n━━ 第 ${p['round']} 輪 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━`),
  'round.bot_status': (p) => {
    const bots = p['bots'] as Array<{ login: string; state: string; satisfied: boolean }>;
    if (!bots || bots.length === 0) return chalk.gray('  ⏳ 尚無 bot 審查');
    return bots
      .map((b) => {
        const icon = b.satisfied ? '✅' : b.state === 'commented' ? '💬' : b.state === 'changes_requested' ? '🔴' : '⏳';
        return chalk.white(`  ${icon} ${b.login}：${b.state}${b.satisfied ? ' [已完成，不再請求]' : ''}`);
      })
      .join('\n');
  },
  'bot.satisfied':    (p) => chalk.green(`  ✅ ${p['bot']} 已完成審查（${p['state'] === 'approved' ? 'Approved' : '無新評論'}），後續不再重新請求`),
  'classify.result':  (p) => chalk.white(`  🔍 ${p['file']}${p['line'] != null ? `:${p['line']}` : ''}  分類=${p['category']}  信心=${String(p['confidence']).slice(0, 4)}`),
  'round.classified': (p) => chalk.white(`  📊 分類完成：共 ${p['total']} 個，唯一 ${p['unique']} 個，關鍵 ${p['criticals']} 個，重複 ${p['duplicates']} 個`),
  'round.decisions':  (p) => chalk.white(`  📋 決策摘要：🔧 修復 ${p['fix']} 項  ⏭ 延後 ${p['defer']} 項  ❌ 拒絕 ${p['reject']} 項`),
  'fix.applied':      (p) => chalk.green(`  ✅ 修復：${p['description']}`),
  'fix.skipped': (p) => {
    const cats = p['categories'] as Record<string, number> | undefined;
    const detail = cats ? Object.entries(cats).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    return chalk.gray(`  ⏭  跳過修復（全為風格/範圍外）${detail ? `  [${detail}]` : ''}`);
  },
  'commit.pushed':    (p) => chalk.green(`  📦 提交推送：${p['sha']}`),
  'commit.error':     (p) => chalk.red(`  ❌ 提交失敗（${p['phase']}）：${p['error']}`),
  'round.committed':  (p) => chalk.green(`  📦 本輪提交：${p['fixCount']} 個修復`),
  'thread.replied':   (p) => chalk.blue(`  💬 已回覆討論串${p['category'] ? `（${p['category']}）` : ''}`),
  'thread.resolved':  ()  => chalk.blue(`  ✔  討論串已解決`),
  'reviewers.requested': (p) => chalk.blue(`  🔄 重新請求審查：${(p['bots'] as string[]).join(', ')}`),
  'rerequest.skipped':   ()  => chalk.gray(`  ⏭  跳過重新請求（仍有未關閉討論串）`),
  'round.waiting':    (p) => chalk.gray(`  ⏱  等待 ${Math.round((p['intervalMs'] as number) / 60000)} 分鐘讓 bot 重新審查...`),
  'pr.body_updated':  (p) => chalk.cyan(`  📝 PR 描述已更新（${p['length']} 字元）`),
  'loop.error':       (p) => chalk.red(`  ❌ 錯誤：${p['error']}`),
  'loop.done':        (p) => chalk.bold(`\n◼ 循環結束  原因=${p['reason']}  共 ${p['rounds']} 輪`),
};

function prettySink(event: import('../../core/events/EventEmitter').MaestroEvent): void {
  const fmt = PRETTY[event.type];
  if (fmt) process.stderr.write(fmt(event.payload) + '\n');
}

// ─── Interactive decision helpers ────────────────────────────────────────────

/** Read a line from stdin with a hard timeout. Returns '' if the timer fires first. */
function promptWithTimeout(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        rl.close();
        process.stderr.write('\n');
        console.error(chalk.gray('（已逾時，自動採用建議）'));
        resolve('');
      }
    }, timeoutMs);

    rl.question(prompt, (answer) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        rl.close();
        resolve(answer);
      }
    });
  });
}

function printFindingsList(
  findings: Array<Finding & { classification: FindingClassification }>,
  decisions: Map<string, 'fix' | 'defer' | 'reject'>,
): void {
  for (const [i, f] of findings.entries()) {
    const cat = f.classification?.category ?? 'unknown';
    const action = decisions.get(f.hash) ?? 'defer';
    const icon = action === 'fix' ? '🔧' : action === 'reject' ? '❌' : '⏭';
    const loc = `${f.location.file ?? ''}${f.location.startLine != null ? `:${f.location.startLine}` : ''}`;
    console.error(`  ${i + 1}. ${icon} [${cat}] ${loc}`);
    console.error(chalk.gray(`     ${f.title.slice(0, 80)}`));
  }
}

function buildDecisionSummaryPrompt(
  findings: Array<Finding & { classification: FindingClassification }>,
  round: number,
): string {
  const lines = findings
    .map((f, i) => {
      const cat = f.classification?.category ?? 'unknown';
      const loc = `${f.location.file ?? ''}${f.location.startLine != null ? `:${f.location.startLine}` : ''}`;
      const body = f.body.length > 200 ? `${f.body.slice(0, 200)}…` : f.body;
      return `${i + 1}. [${cat}] ${loc}\n   標題：${f.title}\n   內容：${body}`;
    })
    .join('\n\n');

  return `請分析以下第 ${round} 輪 PR 審查評論，給出繁體中文摘要：

${lines}

請回覆以下格式（繁體中文，每項盡量簡短）：
需要修復：<列出需修復的項目編號，若無則寫「無」>
建議延後：<列出可延後的項目編號，若無則寫「無」>
建議拒絕：<列出建議拒絕的項目編號，若無則寫「無」>
總結：<一句話說明本輪重點>

只回覆以上格式，不要添加其他說明。`;
}

// ─── AI provider resolution ───────────────────────────────────────────────────

/**
 * Resolve an AIProvider from config + environment.
 *
 * Priority:
 *   1. ClaudeProvider  — when ANTHROPIC_API_KEY or config.ai.providers[*].apiKey is set
 *   2. ClaudeCodeProvider — when `claude` CLI is available in PATH (no API key needed)
 *   3. undefined — fix engine is disabled, loop runs classify-only
 */
async function resolveAIProvider(config: ReturnType<typeof import('../../config').loadConfig>): Promise<AIProvider | undefined> {
  // Try direct API key first
  const aiProviderConfig = Object.values(config.ai.providers)[0];
  const apiKey = aiProviderConfig?.apiKey ?? process.env['ANTHROPIC_API_KEY'];

  if (apiKey) {
    const provider = new ClaudeProvider({ ...aiProviderConfig, apiKey });
    try {
      await provider.initialize();
      return provider;
    } catch {
      // fall through to ClaudeCodeProvider
    }
  }

  // Fallback: Claude Code CLI
  const ccProvider = new ClaudeCodeProvider();
  try {
    await ccProvider.initialize();
    console.error(chalk.gray('Using Claude Code CLI for AI fixes (no API key configured).'));
    return ccProvider;
  } catch {
    console.error(chalk.yellow('Warning: no AI provider available — fix engine disabled.'));
    return undefined;
  }
}

// ─── LLM-backed classification ────────────────────────────────────────────────

const CLASSIFY_CATEGORIES = ['bug', 'taste', 'wrong', 'yagni', 'unknown'] as const;

async function llmClassifyFinding(
  finding: Finding,
  provider: AIProvider,
): Promise<FindingClassification> {
  const prompt = `將以下程式碼審查意見分類為一個類別。

意見內容：
"""
${finding.body}
"""

檔案：${finding.location.file ?? 'unknown'}${finding.location.startLine != null ? `，第 ${finding.location.startLine} 行` : ''}

類別：
- bug: 真正的缺陷，會導致錯誤的執行期行為或資料損壞
- taste: 風格、命名、格式或主觀的程式碼偏好
- wrong: 審查者誤解了程式碼，該問題不適用於此處
- yagni: 有效的建議但不在此 PR 的範圍內
- unknown: 無法確定

僅回傳 JSON 物件，不要加 markdown：
{"category":"<以上其中一個>","confidence":<0.0 到 1.0>,"reasoning":"<一句簡短的繁體中文說明>"}`;

  try {
    const result = await provider.complete(prompt, { maxTokens: 150 });
    const raw = result.content.trim().replace(/^```json\s*/i, '').replace(/```\s*$/,'');
    const parsed = JSON.parse(raw) as { category: string; confidence: number; reasoning?: string };
    const category = CLASSIFY_CATEGORIES.includes(parsed.category as never)
      ? (parsed.category as FindingClassification['category'])
      : 'unknown';
    return { category, confidence: parsed.confidence ?? 0.7, viaFence: false, reasoning: parsed.reasoning };
  } catch {
    return { category: 'unknown', confidence: 0, viaFence: false };
  }
}
