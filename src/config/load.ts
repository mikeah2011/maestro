/**
 * Config loader — assembles `MaestroConfig` from the layered sources.
 *
 * Precedence (highest wins):
 *   1. CLI flags (passed in via `overrides`)
 *   2. Process env vars (a small allowlist; see `applyEnvOverrides`)
 *   3. Repo `.maestro.yaml` in the repo root
 *   4. User `~/.maestro/config.yaml`
 *   5. Schema defaults
 *
 * Each layer is parsed as YAML, env-var-expanded, then deep-merged. The merged
 * object is finally Zod-validated to produce a typed `MaestroConfig`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { type MaestroConfig, MaestroConfigSchema } from './schema';
import { expandValue } from './expand';

export interface LoadConfigOptions {
  /** Where to start searching for `.maestro.yaml`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Override the user-config path (mostly for tests). Defaults to `~/.maestro/config.yaml`. */
  userConfigPath?: string;
  /** Plain-object overrides (typically built from CLI flags). */
  overrides?: DeepPartial<MaestroConfig>;
  /** Process env to read from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
    this.cause = cause;
  }
}

type Plain = Record<string, unknown>;
type DeepPartial<T> = T extends Plain ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Deep-merge `b` over `a`, returning a fresh object. Arrays are replaced wholesale. */
export function deepMerge<A extends Plain, B extends Plain>(a: A, b: B): A & B {
  const out: Plain = { ...a };
  for (const [key, bValue] of Object.entries(b)) {
    const aValue = out[key];
    if (
      aValue &&
      typeof aValue === 'object' &&
      !Array.isArray(aValue) &&
      bValue &&
      typeof bValue === 'object' &&
      !Array.isArray(bValue)
    ) {
      out[key] = deepMerge(aValue as Plain, bValue as Plain);
    } else if (bValue !== undefined) {
      out[key] = bValue;
    }
  }
  return out as A & B;
}

function readYamlIfExists(path: string): Plain | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    // Use loadAll + take first doc so files with a trailing `---` separator (like the
    // example config) don't fail with "found more than one document".
    const docs = yaml.loadAll(raw);
    const parsed = docs[0] ?? null;
    if (parsed === null || parsed === undefined) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(`${path} must be a YAML mapping at the top level, got ${typeof parsed}`);
    }
    return parsed as Plain;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`failed to parse ${path}`, err);
  }
}

/** Pick values from env vars and turn them into config-shaped overrides. */
function applyEnvOverrides(env: NodeJS.ProcessEnv): DeepPartial<MaestroConfig> {
  const overrides: DeepPartial<MaestroConfig> = {};

  if (env['MAESTRO_MAX_ROUNDS']) {
    overrides.stopConditions = {
      ...(overrides.stopConditions ?? {}),
      maxRounds: Number.parseInt(env['MAESTRO_MAX_ROUNDS'], 10),
    };
  }

  if (env['MAESTRO_COST_BUDGET_USD']) {
    overrides.stopConditions = {
      ...(overrides.stopConditions ?? {}),
      costBudgetUSD: Number.parseFloat(env['MAESTRO_COST_BUDGET_USD']),
    };
  }

  if (env['MAESTRO_LOG_LEVEL']) {
    const level = env['MAESTRO_LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error';
    overrides.logging = { ...(overrides.logging ?? {}), level };
  }

  if (env['MAESTRO_AUDIT_DIR']) {
    overrides.audit = { ...(overrides.audit ?? {}), dir: env['MAESTRO_AUDIT_DIR'] };
  }

  return overrides;
}

/**
 * Load + layer + validate. Returns a fully-typed `MaestroConfig`. Throws
 * `ConfigError` on validation failure with a human-readable message.
 */
export function loadConfig(options: LoadConfigOptions = {}): MaestroConfig {
  const cwd = options.cwd ?? process.cwd();
  const userPath = options.userConfigPath ?? join(homedir(), '.maestro', 'config.yaml');
  const repoPath = resolve(cwd, '.maestro.yaml');
  const env = options.env ?? process.env;

  const userLayer = readYamlIfExists(userPath) ?? {};
  const repoLayer = readYamlIfExists(repoPath) ?? {};

  const expandedUser = expandValue(userLayer, env);
  const expandedRepo = expandValue(repoLayer, env);

  const envOverrides = applyEnvOverrides(env);
  const cliOverrides = options.overrides ?? {};

  const merged = deepMerge(
    deepMerge(deepMerge(expandedUser as Plain, expandedRepo as Plain), envOverrides as Plain),
    cliOverrides as Plain,
  );

  const result = MaestroConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatZodError(result.error), result.error);
  }

  return result.data;
}

function formatZodError(err: z.ZodError): string {
  const lines = ['invalid maestro config:'];
  for (const issue of err.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    lines.push(`  - ${path}: ${issue.message}`);
  }
  return lines.join('\n');
}
