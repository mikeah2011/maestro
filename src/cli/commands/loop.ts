/**
 * `maestro loop` — placeholder for M2.
 *
 * Subcommands: start, status, stop, resume.
 * Currently each prints a "not yet implemented in this milestone" message
 * and exits 4 so CI scripts can detect the placeholder gracefully.
 */

import type { Command } from 'commander';
import chalk from 'chalk';

const NOT_YET = 4;

function notYet(action: string): never {
  console.error(chalk.yellow(`maestro loop ${action}: not yet implemented (lands in M2)`));
  console.error(chalk.gray('See DESIGN.md §3 (Architecture) for the full plan.'));
  process.exit(NOT_YET);
}

export function registerLoopCommand(program: Command): void {
  const loop = program.command('loop').description('run the multi-bot review convergence loop on a PR');

  loop
    .command('start')
    .description('start the loop on a PR (background)')
    .requiredOption('--pr <number>', 'PR number to drive')
    .option('--max-rounds <n>', 'override stopConditions.maxRounds')
    .option('--cost-budget <usd>', 'override stopConditions.costBudgetUSD')
    .action(() => notYet('start'));

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
