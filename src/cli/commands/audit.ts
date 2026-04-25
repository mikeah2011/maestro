/**
 * `maestro audit` — placeholder for M3.
 *
 * Replays every classification decision for a PR from the audit JSONL log,
 * useful for debugging misclassifications before scaling.
 */

import type { Command } from 'commander';
import chalk from 'chalk';

const NOT_YET = 4;

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('replay every classification decision for a PR from the audit log')
    .requiredOption('--pr <number>', 'PR number')
    .option('--round <n>', 'limit to a specific round')
    .option('--format <fmt>', 'output format: text | jsonl', 'text')
    .action(() => {
      console.error(chalk.yellow('maestro audit: not yet implemented (lands in M3)'));
      console.error(chalk.gray('Will replay .maestro/audit/pr-<N>-round-<R>.jsonl entries.'));
      process.exit(NOT_YET);
    });
}
