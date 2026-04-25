/**
 * `maestro init` — scaffold .maestro.yaml in the current repo.
 *
 * Behavior:
 *   - errors out if .maestro.yaml already exists, unless --force
 *   - copies .maestro.example.yaml from the installed package
 *   - creates .maestro/ audit directory (gitignored by default scaffold)
 *   - prints next-step instructions
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import chalk from 'chalk';

export interface InitOptions {
  /** Overwrite existing .maestro.yaml. */
  force?: boolean;
  /** Override target directory (defaults to cwd). */
  cwd?: string;
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const target = resolve(cwd, '.maestro.yaml');
  const auditDir = resolve(cwd, '.maestro');

  if (existsSync(target) && !opts.force) {
    throw new Error(
      `.maestro.yaml already exists at ${target}. Re-run with --force to overwrite.`,
    );
  }

  const examplePath = resolveExamplePath();
  copyFileSync(examplePath, target);

  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  console.log(chalk.green('✓ scaffolded .maestro.yaml'));
  console.log();
  console.log('Next steps:');
  console.log('  1. Edit ' + chalk.cyan('.maestro.yaml') + ' — set provider API keys, platform, bots.');
  console.log('  2. Run ' + chalk.cyan('maestro doctor') + ' to verify your environment.');
  console.log('  3. When you push a PR, run ' + chalk.cyan('maestro loop start --pr <N>') + ' to drive the review loop.');
}

/**
 * Locate `.maestro.example.yaml` shipped with the package.
 *
 * Resolution strategy:
 *   1. relative to this compiled file (in `dist/`), the example sits two levels up
 *   2. relative to the project root (when running from source via `bun run`)
 *   3. fall back to cwd
 */
function resolveExamplePath(): string {
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, '..', '..', '.maestro.example.yaml'));
    candidates.push(resolve(here, '..', '..', '..', '.maestro.example.yaml'));
  } catch {
    // ignore
  }
  candidates.push(resolve(process.cwd(), '.maestro.example.yaml'));

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  throw new Error(
    `could not locate .maestro.example.yaml. Checked:\n  ${candidates.join('\n  ')}\n\nReinstall maestro or download the example from the repo.`,
  );
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('scaffold .maestro.yaml in the current repo')
    .option('-f, --force', 'overwrite existing .maestro.yaml')
    .option('--cwd <dir>', 'directory to scaffold into (defaults to current)')
    .action(async (options: { force?: boolean; cwd?: string }) => {
      await runInit(options);
    });
}
