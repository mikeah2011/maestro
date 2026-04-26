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
import chalk from 'chalk';
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
    .action(async (opts: { pr: string; maxRounds?: number; costBudget?: number; bots?: string; dryRun?: boolean; remote?: string }) => {
      const prNumber = parseInt(opts.pr, 10);
      if (!Number.isFinite(prNumber) || prNumber < 1) {
        console.error(chalk.red(`error: --pr must be a positive integer, got "${opts.pr}"`));
        process.exit(2);
      }

      // Load config — --remote controls which git remote is used for owner/repo auto-detection
      let config;
      try {
        config = loadConfig({
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
        const fixEngine = new FixEngine({ provider: aiProvider, tier: 'strong' });
        onFix = (findings, round) => fixEngine.fix(findings, round);
      }

      // Run the loop
      const orchestrator = new LoopOrchestrator({
        platform,
        emitter,
        classifier,
        onFix: isDryRun ? async () => [] : onFix,
        onCommit: isDryRun ? async () => '' : undefined,
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
  'classify.result':  (p) => chalk.white(`  🔍 分類：${p['category']}  嚴重度=${p['severity']}`),
  'fix.applied':      (p) => chalk.green(`  ✅ 修復：${p['description']}`),
  'fix.skipped':      (p) => chalk.gray(`  ⏭  跳過修復：${p['reason']}`),
  'commit.pushed':    (p) => chalk.green(`  📦 提交推送：${p['sha']}`),
  'reply.sent':       ()  => chalk.blue(`  💬 已回覆討論串`),
  'thread.resolved':  ()  => chalk.blue(`  ✔  討論串已解決`),
  'reviewers.requested': (p) => chalk.blue(`  🔄 重新請求審查：${(p['bots'] as string[]).join(', ')}`),
  'rerequest.skipped':   ()  => chalk.gray(`  ⏭  跳過重新請求（仍有未關閉討論串）`),
  'loop.done':        (p) => chalk.bold(`\n◼ 循環結束  原因=${p['reason']}  共 ${p['rounds']} 輪`),
};

function prettySink(event: import('../../core/events/EventEmitter').MaestroEvent): void {
  const fmt = PRETTY[event.type];
  if (fmt) process.stderr.write(fmt(event.payload) + '\n');
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
