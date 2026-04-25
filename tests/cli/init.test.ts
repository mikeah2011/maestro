import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/cli/commands/init';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maestro-init-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('runInit', () => {
  it('creates .maestro.yaml from the example', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInit({ cwd: tmpRoot });

    const target = join(tmpRoot, '.maestro.yaml');
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, 'utf8');
    expect(body).toContain('Maestro');
    expect(body).toContain('platform:');
    expect(body).toContain('stopConditions:');
  });

  it('creates the .maestro audit directory', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runInit({ cwd: tmpRoot });
    expect(existsSync(join(tmpRoot, '.maestro'))).toBe(true);
  });

  it('refuses to overwrite an existing .maestro.yaml without --force', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeFileSync(join(tmpRoot, '.maestro.yaml'), '# existing\n', 'utf8');

    await expect(runInit({ cwd: tmpRoot })).rejects.toThrow(/already exists/);
    expect(readFileSync(join(tmpRoot, '.maestro.yaml'), 'utf8')).toBe('# existing\n');
  });

  it('overwrites with --force', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeFileSync(join(tmpRoot, '.maestro.yaml'), '# existing\n', 'utf8');

    await runInit({ cwd: tmpRoot, force: true });

    const body = readFileSync(join(tmpRoot, '.maestro.yaml'), 'utf8');
    expect(body).not.toBe('# existing\n');
    expect(body).toContain('Maestro');
  });

  it('idempotent on the audit directory (does not error if it exists)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mkdirSync(join(tmpRoot, '.maestro'));

    await runInit({ cwd: tmpRoot });
    expect(existsSync(join(tmpRoot, '.maestro'))).toBe(true);
  });
});
