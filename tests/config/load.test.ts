import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, deepMerge, loadConfig } from '../../src/config/load';

let tmpRoot: string;
let repoDir: string;
let userDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maestro-test-'));
  repoDir = join(tmpRoot, 'repo');
  userDir = join(tmpRoot, 'user');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeRepoConfig(content: string): void {
  writeFileSync(join(repoDir, '.maestro.yaml'), content, 'utf8');
}

function writeUserConfig(content: string): void {
  writeFileSync(join(userDir, 'config.yaml'), content, 'utf8');
}

const userPath = () => join(userDir, 'config.yaml');

describe('loadConfig — required fields', () => {
  it('throws when no config exists and no platform is provided', () => {
    expect(() =>
      loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} }),
    ).toThrow(ConfigError);
  });

  it('throws with helpful message when platform.type is missing', () => {
    writeRepoConfig('platform:\n  auth: {}\n');
    try {
      loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const e = err as ConfigError;
      expect(e.message).toContain('platform.type');
    }
  });

  it('accepts a minimal valid config', () => {
    writeRepoConfig(`
platform:
  type: github
  auth:
    tokenEnv: GITHUB_TOKEN
`);
    const cfg = loadConfig({
      cwd: repoDir,
      userConfigPath: userPath(),
      env: { GITHUB_TOKEN: 'ghp_test' },
    });
    expect(cfg.platform.type).toBe('github');
    expect(cfg.stopConditions.maxRounds).toBe(3);
  });
});

describe('loadConfig — defaults', () => {
  it('applies all schema defaults to a minimal config', () => {
    writeRepoConfig(`
platform:
  type: github
`);
    const cfg = loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} });
    expect(cfg.stopConditions.maxRounds).toBe(3);
    expect(cfg.stopConditions.jaccardCeiling).toBe(0.7);
    expect(cfg.stopConditions.duplicateFindingPolicy).toBe('pushback');
    expect(cfg.preflight.enabled).toBe(true);
    expect(cfg.audit.dir).toBe('.maestro/audit');
    expect(cfg.logging.format).toBe('jsonl');
    expect(cfg.security.scanOutgoing).toBe(true);
    expect(cfg.prBody.marker.start).toBe('<!-- maestro:start -->');
  });

  it('caps maxRounds at 5 even if user tries to set it higher', () => {
    writeRepoConfig(`
platform:
  type: github
stopConditions:
  maxRounds: 10
`);
    expect(() =>
      loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} }),
    ).toThrow(/maxRounds/i);
  });
});

describe('loadConfig — env-var expansion', () => {
  it('expands ${VAR} in token fields', () => {
    writeRepoConfig(`
platform:
  type: github
  auth:
    token: \${GITHUB_TOKEN}
`);
    const cfg = loadConfig({
      cwd: repoDir,
      userConfigPath: userPath(),
      env: { GITHUB_TOKEN: 'ghp_secret' },
    });
    expect(cfg.platform.auth.token).toBe('ghp_secret');
  });

  it('falls back to default when env unset', () => {
    writeRepoConfig(`
platform:
  type: github
audit:
  dir: \${MAESTRO_AUDIT_DIR:-./custom/audit}
`);
    const cfg = loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} });
    expect(cfg.audit.dir).toBe('./custom/audit');
  });
});

describe('loadConfig — layering', () => {
  it('layers user config under repo config (repo wins)', () => {
    writeUserConfig(`
platform:
  type: gitlab
audit:
  dir: ./user-audit
`);
    writeRepoConfig(`
platform:
  type: github
`);
    const cfg = loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} });
    expect(cfg.platform.type).toBe('github'); // repo wins
    expect(cfg.audit.dir).toBe('./user-audit'); // user provided, repo did not
  });

  it('env overrides win over file config', () => {
    writeRepoConfig(`
platform:
  type: github
stopConditions:
  maxRounds: 2
`);
    const cfg = loadConfig({
      cwd: repoDir,
      userConfigPath: userPath(),
      env: { MAESTRO_MAX_ROUNDS: '4' },
    });
    expect(cfg.stopConditions.maxRounds).toBe(4);
  });

  it('CLI overrides win over everything', () => {
    writeRepoConfig(`
platform:
  type: github
stopConditions:
  maxRounds: 2
`);
    const cfg = loadConfig({
      cwd: repoDir,
      userConfigPath: userPath(),
      env: { MAESTRO_MAX_ROUNDS: '3' },
      overrides: { stopConditions: { maxRounds: 1 } },
    });
    expect(cfg.stopConditions.maxRounds).toBe(1);
  });
});

describe('loadConfig — bots & detection', () => {
  it('accepts a populated bot registry', () => {
    writeRepoConfig(`
platform:
  type: github
bots:
  registry:
    - login: coderabbitai
      treatAs: blocking
    - login: ellipsis-dev[bot]
`);
    const cfg = loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} });
    expect(cfg.bots.registry).toHaveLength(2);
    expect(cfg.bots.registry[0]?.login).toBe('coderabbitai');
    expect(cfg.bots.registry[0]?.treatAs).toBe('blocking');
    expect(cfg.bots.registry[1]?.treatAs).toBe('advisory'); // default
  });

  it('rejects detection rule with no fields set', () => {
    writeRepoConfig(`
platform:
  type: github
bots:
  detectByConvention:
    enabled: true
    rules:
      - {}
`);
    expect(() =>
      loadConfig({ cwd: repoDir, userConfigPath: userPath(), env: {} }),
    ).toThrow(/detection rule/);
  });
});

describe('deepMerge', () => {
  it('replaces arrays wholesale, does not concat', () => {
    const a = { list: [1, 2] };
    const b = { list: [3] };
    expect(deepMerge(a, b)).toEqual({ list: [3] });
  });

  it('merges nested objects', () => {
    const a = { x: { y: 1, z: 2 } };
    const b = { x: { z: 3 } };
    expect(deepMerge(a, b)).toEqual({ x: { y: 1, z: 3 } });
  });

  it('skips undefined values in b', () => {
    const a = { x: 1, y: 2 };
    const b = { y: undefined } as Record<string, unknown>;
    expect(deepMerge(a, b)).toEqual({ x: 1, y: 2 });
  });
});
