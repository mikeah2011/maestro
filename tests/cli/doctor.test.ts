import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maestro-doctor-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function initGitRepo(dir: string): void {
  execSync('git init -q', { cwd: dir });
}

function writeRepoConfig(dir: string, content: string): void {
  writeFileSync(join(dir, '.maestro.yaml'), content, 'utf8');
}

describe('runDoctor — failure modes', () => {
  it('reports missing .maestro.yaml as fail', async () => {
    initGitRepo(tmpRoot);

    const { ok, results } = await runDoctor({ cwd: tmpRoot, env: {} });
    expect(ok).toBe(false);

    const cfgCheck = results.find((r) => r.name === '.maestro.yaml present');
    expect(cfgCheck?.status).toBe('fail');
  });

  it('reports invalid config as fail', async () => {
    initGitRepo(tmpRoot);
    // Missing required platform.type
    writeRepoConfig(tmpRoot, 'platform:\n  auth: {}\n');

    const { ok, results } = await runDoctor({ cwd: tmpRoot, env: {} });
    expect(ok).toBe(false);

    const cfgCheck = results.find((r) => r.name.startsWith('.maestro.yaml loads'));
    expect(cfgCheck?.status).toBe('fail');
  });

  it('reports missing platform token as fail', async () => {
    initGitRepo(tmpRoot);
    writeRepoConfig(
      tmpRoot,
      `
platform:
  type: github
  auth:
    tokenEnv: GITHUB_TOKEN
`,
    );

    const { ok, results } = await runDoctor({ cwd: tmpRoot, env: {} });
    expect(ok).toBe(false);

    const tokenCheck = results.find((r) => r.name.startsWith('platform token'));
    expect(tokenCheck?.status).toBe('fail');
  });
});

describe('runDoctor — success path', () => {
  it('passes config + token checks with valid env', async () => {
    initGitRepo(tmpRoot);
    writeRepoConfig(
      tmpRoot,
      `
platform:
  type: github
  auth:
    tokenEnv: GITHUB_TOKEN
ai:
  providers:
    local:
      type: local
      baseUrl: http://localhost:11434
`,
    );

    const { results } = await runDoctor({
      cwd: tmpRoot,
      env: { GITHUB_TOKEN: 'ghp_test', PATH: process.env['PATH'] ?? '' },
    });

    const configCheck = results.find((r) => r.name.startsWith('.maestro.yaml loads'));
    expect(configCheck?.status).toBe('pass');

    const tokenCheck = results.find((r) => r.name.startsWith('platform token'));
    expect(tokenCheck?.status).toBe('pass');

    const aiCheck = results.find((r) => r.name === 'AI provider keys');
    expect(aiCheck?.status).toBe('pass');
  });
});
