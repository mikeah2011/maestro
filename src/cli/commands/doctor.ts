/**
 * `maestro doctor` — environment + config sanity check.
 *
 * Does not perform network calls; it only checks for the presence of:
 *   - a valid .maestro.yaml that loads + parses
 *   - the platform CLI binary (`gh` / `glab` / `tea` / Gitee CLI) for the configured platform
 *   - the AI key env var for the routing default provider
 *   - `git` and that we're inside a git repo
 *
 * Prints a checklist of pass/fail/warn lines and exits 0 on all-pass, 1 on any fail.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { ConfigError, loadConfig } from '../../config/load';
import type { MaestroConfig } from '../../config/schema';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  detail?: string;
}

const PLATFORM_CLI: Record<string, { bin: string; install: string }> = {
  github: { bin: 'gh', install: 'https://cli.github.com/' },
  gitlab: { bin: 'glab', install: 'https://gitlab.com/gitlab-org/cli' },
  gitea: { bin: 'tea', install: 'https://gitea.com/gitea/tea' },
  gitee: { bin: 'gitee', install: 'https://gitee.com/oschina/git-osc' },
};

function which(bin: string): string | null {
  try {
    const out = execSync(`command -v ${bin}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function checkGit(cwd: string): CheckResult {
  if (!which('git')) {
    return { name: 'git installed', status: 'fail', detail: 'install git from https://git-scm.com/' };
  }
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore' });
    return { name: 'inside a git repo', status: 'pass' };
  } catch {
    return { name: 'inside a git repo', status: 'fail', detail: `${cwd} is not a git repo` };
  }
}

function checkConfig(cwd: string): { result: CheckResult; config?: MaestroConfig } {
  const repoConfigPath = resolve(cwd, '.maestro.yaml');

  if (!existsSync(repoConfigPath)) {
    // No .maestro.yaml — try loading from git remote + defaults only.
    try {
      const config = loadConfig({ cwd });
      const owner = config.platform.owner ?? '?';
      const repo = config.platform.repo ?? '?';
      return {
        result: {
          name: '.maestro.yaml',
          status: 'warn',
          detail: `not found — using git remote auto-detect (${owner}/${repo}); run \`maestro init\` to persist settings`,
        },
        config,
      };
    } catch {
      return {
        result: {
          name: '.maestro.yaml',
          status: 'fail',
          detail: `not found at ${repoConfigPath} and no git remote detected; run \`maestro init\``,
        },
      };
    }
  }

  try {
    const config = loadConfig({ cwd });
    return {
      result: { name: '.maestro.yaml loads + validates', status: 'pass' },
      config,
    };
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message.split('\n')[0] : String(err);
    return {
      result: { name: '.maestro.yaml loads + validates', status: 'fail', detail },
    };
  }
}

function checkPlatformCli(config: MaestroConfig): CheckResult {
  const meta = PLATFORM_CLI[config.platform.type];
  if (!meta) {
    return { name: `platform CLI for ${config.platform.type}`, status: 'skip', detail: 'unknown platform' };
  }
  const path = which(meta.bin);
  if (!path) {
    return {
      name: `${meta.bin} installed (${config.platform.type})`,
      status: 'fail',
      detail: `install ${meta.bin} from ${meta.install}`,
    };
  }
  return { name: `${meta.bin} installed (${config.platform.type})`, status: 'pass', detail: path };
}

function checkPlatformToken(config: MaestroConfig, env: NodeJS.ProcessEnv): CheckResult {
  const auth = config.platform.auth;
  if (auth.token && auth.token.length > 0) {
    return { name: 'platform token configured', status: 'pass', detail: 'inline token' };
  }
  if (auth.tokenEnv && env[auth.tokenEnv]) {
    return {
      name: `platform token (${auth.tokenEnv})`,
      status: 'pass',
      detail: 'env var set',
    };
  }
  return {
    name: 'platform token configured',
    status: 'fail',
    detail: auth.tokenEnv
      ? `${auth.tokenEnv} env var is unset`
      : 'no token or tokenEnv set in .maestro.yaml',
  };
}

function checkAIProvider(config: MaestroConfig, env: NodeJS.ProcessEnv): CheckResult {
  const providers = Object.entries(config.ai.providers);

  const failed: string[] = [];
  const passed: string[] = [];
  for (const [name, provider] of providers) {
    if (provider.type === 'local') {
      passed.push(`${name} (local)`);
      continue;
    }
    if (provider.apiKey && provider.apiKey.length > 0) {
      passed.push(`${name} (${provider.type})`);
    } else {
      failed.push(`${name} (${provider.type})`);
    }
  }

  if (passed.length > 0) {
    return { name: 'AI provider keys', status: 'pass', detail: `ok: ${passed.join(', ')}` };
  }

  // Fallback: check if `claude` CLI is available (ClaudeCodeProvider — no API key needed)
  try {
    const claudePath = execSync('which claude', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (claudePath) {
      return {
        name: 'AI provider keys',
        status: 'pass',
        detail: `claude CLI at ${claudePath} (ClaudeCodeProvider fallback — no API key required)`,
      };
    }
  } catch {
    // `which` failed — claude not in PATH
  }

  return {
    name: 'AI provider keys',
    status: 'warn',
    detail: `no API keys set and claude CLI not found — fix engine will be disabled. Missing: ${failed.join(', ')}`,
  };
}

export interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<{ ok: boolean; results: CheckResult[] }> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const results: CheckResult[] = [];

  results.push(checkGit(cwd));

  const { result: configResult, config } = checkConfig(cwd);
  results.push(configResult);

  if (config) {
    results.push(checkPlatformCli(config));
    results.push(checkPlatformToken(config, env));
    results.push(checkAIProvider(config, env));
  }

  return { ok: results.every((r) => r.status !== 'fail'), results };
}

function symbolFor(status: CheckResult['status']): string {
  switch (status) {
    case 'pass':
      return chalk.green('✓');
    case 'fail':
      return chalk.red('✗');
    case 'warn':
      return chalk.yellow('!');
    case 'skip':
      return chalk.gray('-');
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('verify environment, config, tokens, and platform CLI tools')
    .option('--cwd <dir>', 'directory to inspect (defaults to current)')
    .action(async (options: { cwd?: string }) => {
      const { ok, results } = await runDoctor(options);

      console.log(chalk.bold('\nmaestro doctor:\n'));
      for (const r of results) {
        const sym = symbolFor(r.status);
        const line = `  ${sym}  ${r.name}`;
        const detail = r.detail ? chalk.gray(` — ${r.detail}`) : '';
        console.log(line + detail);
      }
      console.log();

      if (ok) {
        console.log(chalk.green('all checks passed.'));
      } else {
        console.log(chalk.red('one or more checks failed; fix above before running the loop.'));
        process.exitCode = 1;
      }
    });
}
