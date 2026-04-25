#!/usr/bin/env node
/**
 * `maestro` CLI entry point.
 *
 * Subcommands:
 *   init      scaffold .maestro.yaml in the current repo
 *   doctor    diagnose config, tools, tokens
 *   loop      run the bot-review convergence loop on a PR (M2+)
 *   audit     replay classification decisions for a PR (M3+)
 *   bots      list / register / inspect bot registry entries (M4+)
 *
 * Exit codes:
 *   0  success
 *   1  generic error
 *   2  invalid usage
 *   3  config error
 *   4  not implemented yet (placeholder commands)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';
import { registerInitCommand } from './commands/init';
import { registerDoctorCommand } from './commands/doctor';
import { registerLoopCommand } from './commands/loop';
import { registerAuditCommand } from './commands/audit';
import { registerBotsCommand } from './commands/bots';

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildCli(): Command {
  const program = new Command();

  program
    .name('maestro')
    .description('Orchestrate every AI PR review bot. Close the loop. Ship merged.')
    .version(readPackageVersion())
    .showHelpAfterError(true);

  registerInitCommand(program);
  registerDoctorCommand(program);
  registerLoopCommand(program);
  registerAuditCommand(program);
  registerBotsCommand(program);

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildCli();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof Error) {
      console.error(chalk.red(`error: ${err.message}`));
    } else {
      console.error(chalk.red(`error: ${String(err)}`));
    }
    return 1;
  }
}

// Run when executed directly (not when imported as a library).
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
