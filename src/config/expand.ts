/**
 * Environment-variable expansion for config string values.
 *
 * Supported patterns:
 *   ${VAR}              required; throws if VAR is unset and no default
 *   ${VAR:-default}     optional with default (literal default; no nested ${} inside)
 *   ${VAR:?error}       required with custom error message
 *
 * Expansion of resolved env values is recursive (so an env value that itself
 * contains `${...}` will be expanded), depth-limited to prevent circular refs.
 * Nested `${}` inside default values is intentionally not supported because
 * regex can't reliably parse balanced braces; use a separate variable for
 * that case.
 */

const MAX_DEPTH = 10;
const PATTERN = /\$\{([A-Z_][A-Z0-9_]*)((?::-([^}]*))|(?::\?([^}]*)))?\}/g;

export class EnvExpansionError extends Error {
  constructor(message: string, public readonly variable: string) {
    super(message);
    this.name = 'EnvExpansionError';
  }
}

interface Env {
  [key: string]: string | undefined;
}

/** Expand env-var references in a single string. */
export function expandString(input: string, env: Env = process.env, depth = 0): string {
  if (depth > MAX_DEPTH) {
    throw new EnvExpansionError(
      `env expansion exceeded max depth (${MAX_DEPTH}); circular reference?`,
      'unknown',
    );
  }

  return input.replace(PATTERN, (_, name: string, _modifierFull?: string, defaultValue?: string, errorMessage?: string) => {
    const value = env[name];

    if (value !== undefined && value !== '') {
      // Recurse so nested references like ${A:-${B}} resolve.
      return expandString(value, env, depth + 1);
    }

    if (defaultValue !== undefined) {
      return expandString(defaultValue, env, depth + 1);
    }

    if (errorMessage !== undefined) {
      throw new EnvExpansionError(`required env var ${name} is unset: ${errorMessage}`, name);
    }

    throw new EnvExpansionError(
      `required env var ${name} is unset; use \${${name}:-default} or set it in your shell`,
      name,
    );
  });
}

/** Recursively expand env-var references in any plain JSON-like value. */
export function expandValue<T>(value: T, env: Env = process.env): T {
  if (typeof value === 'string') {
    return expandString(value, env) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((v) => expandValue(v, env)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandValue(v, env);
    }
    return out as unknown as T;
  }

  return value;
}
