/**
 * `maestro bots` — placeholder for M4.
 *
 * Subcommands: list, register, inspect.
 * The BotRegistry implementation arrives in M4 with parsers for the curated
 * list (CodeRabbit, Ellipsis, Copilot Code Review, Codex).
 */

import type { Command } from 'commander';
import chalk from 'chalk';

const NOT_YET = 4;

function notYet(action: string): never {
  console.error(chalk.yellow(`maestro bots ${action}: not yet implemented (lands in M4)`));
  process.exit(NOT_YET);
}

export function registerBotsCommand(program: Command): void {
  const bots = program.command('bots').description('inspect and manage the bot registry');

  bots
    .command('list')
    .description('list configured + curated review bots')
    .action(() => notYet('list'));

  bots
    .command('register')
    .description('register a self-hosted or custom bot for detection')
    .requiredOption('--login <login>', 'bot login as it appears on the platform')
    .option('--treat-as <mode>', 'blocking | advisory', 'advisory')
    .action(() => notYet('register'));

  bots
    .command('inspect')
    .description('show the BotRegistry parser output for a sample comment')
    .requiredOption('--bot <login>', 'bot login')
    .requiredOption('--comment <file>', 'path to a file with the bot comment body')
    .action(() => notYet('inspect'));
}
