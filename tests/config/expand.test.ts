import { describe, expect, it } from 'vitest';
import { EnvExpansionError, expandString, expandValue } from '../../src/config/expand';

describe('expandString', () => {
  it('returns input unchanged when no patterns', () => {
    expect(expandString('hello world', {})).toBe('hello world');
  });

  it('expands a set variable', () => {
    expect(expandString('hi ${NAME}', { NAME: 'maestro' })).toBe('hi maestro');
  });

  it('throws on unset required variable', () => {
    expect(() => expandString('${MISSING}', {})).toThrow(EnvExpansionError);
  });

  it('uses default when variable is unset', () => {
    expect(expandString('${MISSING:-fallback}', {})).toBe('fallback');
  });

  it('uses default when variable is empty string', () => {
    expect(expandString('${EMPTY:-fallback}', { EMPTY: '' })).toBe('fallback');
  });

  it('prefers set value over default', () => {
    expect(expandString('${NAME:-default}', { NAME: 'real' })).toBe('real');
  });

  it('throws with custom message via :? syntax', () => {
    try {
      expandString('${REQUIRED:?must set REQUIRED}', {});
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvExpansionError);
      const e = err as EnvExpansionError;
      expect(e.message).toContain('must set REQUIRED');
      expect(e.variable).toBe('REQUIRED');
    }
  });

  it('expands nested references in env values', () => {
    expect(expandString('${OUTER}', { OUTER: '${INNER}', INNER: 'deep' })).toBe('deep');
  });

  it('caps recursion depth on circular references', () => {
    expect(() => expandString('${A}', { A: '${B}', B: '${A}' })).toThrow(/exceeded max depth/);
  });

  it('handles multiple patterns in one string', () => {
    expect(expandString('${A}-${B}', { A: 'foo', B: 'bar' })).toBe('foo-bar');
  });

  it('does not match shell-style $VAR (no braces)', () => {
    expect(expandString('$NAME', { NAME: 'maestro' })).toBe('$NAME');
  });
});

describe('expandValue', () => {
  it('expands strings inside objects recursively', () => {
    const input = { a: '${X}', b: { c: '${Y:-def}' } };
    const out = expandValue(input, { X: 'one' });
    expect(out).toEqual({ a: 'one', b: { c: 'def' } });
  });

  it('expands strings inside arrays', () => {
    expect(expandValue(['${A}', '${B:-2}'], { A: '1' })).toEqual(['1', '2']);
  });

  it('leaves non-string primitives unchanged', () => {
    const input = { num: 42, bool: true, nul: null };
    expect(expandValue(input, {})).toEqual(input);
  });

  it('does not mutate the input', () => {
    const input = { a: '${X}' };
    expandValue(input, { X: 'changed' });
    expect(input.a).toBe('${X}');
  });
});
