import { describe, expect, it } from 'vitest';
import { SecretScanner } from '../../../src/core/security/SecretScanner';
import type { SecretPattern } from '../../../src/core/security/SecretScanner';

// ─── Clean text ───────────────────────────────────────────────────────────────

describe('SecretScanner — clean text', () => {
  it('returns clean=true and unchanged text for safe input', () => {
    const s = new SecretScanner();
    const result = s.scan('This is a normal code review comment.');
    expect(result.clean).toBe(true);
    expect(result.redacted).toBe('This is a normal code review comment.');
    expect(result.findings).toHaveLength(0);
  });

  it('handles empty string', () => {
    const s = new SecretScanner();
    const result = s.scan('');
    expect(result.clean).toBe(true);
    expect(result.redacted).toBe('');
  });
});

// ─── AWS keys ─────────────────────────────────────────────────────────────────

describe('SecretScanner — AWS access key ID', () => {
  it('detects a bare AWS access key ID', () => {
    const s = new SecretScanner();
    const result = s.scan('The key is AKIAIOSFODNN7EXAMPLE here.');
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'aws_access_key_id')).toBe(true);
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.redacted).toContain('[REDACTED]');
  });

  it('detects AWS access key ID embedded in a sentence', () => {
    const s = new SecretScanner();
    const text = 'Found: AKIAIOSFODNN7EXAMPLE in the config file.';
    const result = s.scan(text);
    expect(result.clean).toBe(false);
  });
});

// ─── GitHub tokens ────────────────────────────────────────────────────────────

describe('SecretScanner — GitHub tokens', () => {
  it('detects ghp_ personal access token', () => {
    const s = new SecretScanner();
    const token = 'ghp_' + 'a'.repeat(36);
    const result = s.scan(`Token: ${token}`);
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'github_token')).toBe(true);
    expect(result.redacted).not.toContain(token);
  });

  it('detects ghs_ server-to-server token', () => {
    const s = new SecretScanner();
    const token = 'ghs_' + 'b'.repeat(36);
    const result = s.scan(`Using token: ${token} for auth.`);
    expect(result.clean).toBe(false);
  });

  it('detects github_pat_ fine-grained token', () => {
    const s = new SecretScanner();
    const token = 'github_pat_' + 'c'.repeat(36);
    const result = s.scan(token);
    expect(result.clean).toBe(false);
  });
});

// ─── PEM private keys ─────────────────────────────────────────────────────────

describe('SecretScanner — private key PEM', () => {
  it('detects RSA private key block', () => {
    const s = new SecretScanner();
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsH',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = s.scan(`Key material found:\n${pem}\nEnd of key.`);
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'private_key_pem')).toBe(true);
    expect(result.redacted).toContain('[PRIVATE KEY REDACTED]');
    expect(result.redacted).not.toContain('MIIEow');
  });

  it('detects generic PRIVATE KEY block (PKCS#8)', () => {
    const s = new SecretScanner();
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk=\n-----END PRIVATE KEY-----';
    const result = s.scan(pem);
    expect(result.clean).toBe(false);
  });
});

// ─── JWT ─────────────────────────────────────────────────────────────────────

describe('SecretScanner — JWT', () => {
  it('detects a well-formed JWT', () => {
    const s = new SecretScanner();
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = s.scan(`Authorization: Bearer ${jwt}`);
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'jwt')).toBe(true);
    expect(result.redacted).toContain('[JWT REDACTED]');
    expect(result.redacted).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  });
});

// ─── Stripe keys ──────────────────────────────────────────────────────────────

describe('SecretScanner — Stripe keys', () => {
  it('detects a Stripe live secret key', () => {
    const s = new SecretScanner();
    const key = 'sk_live_' + '0'.repeat(25);
    const result = s.scan(`STRIPE_SECRET_KEY=${key}`);
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'stripe_key')).toBe(true);
  });

  it('detects a Stripe test publishable key', () => {
    const s = new SecretScanner();
    const key = 'pk_test_' + '1'.repeat(25);
    const result = s.scan(key);
    expect(result.clean).toBe(false);
  });
});

// ─── Generic API key pattern ──────────────────────────────────────────────────

describe('SecretScanner — generic api_key pattern', () => {
  it('detects api_key = <value>', () => {
    const s = new SecretScanner();
    const result = s.scan('api_key = abcdefghijklmnopqrstuvwxyz123456');
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'generic_api_key')).toBe(true);
  });

  it('detects access_token: <value>', () => {
    const s = new SecretScanner();
    const result = s.scan('access_token: 1234567890abcdefghijklmnopqrst');
    expect(result.clean).toBe(false);
  });
});

// ─── Redaction correctness ────────────────────────────────────────────────────

describe('SecretScanner — redaction', () => {
  it('redacted text no longer contains the original secret', () => {
    const s = new SecretScanner();
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const input = `Config: key=${key}, region=us-east-1`;
    const result = s.scan(input);
    expect(result.redacted).not.toContain(key);
  });

  it('preserves surrounding non-secret text', () => {
    const s = new SecretScanner();
    const input = 'prefix AKIAIOSFODNN7EXAMPLE suffix';
    const result = s.scan(input);
    expect(result.redacted).toContain('prefix');
    expect(result.redacted).toContain('suffix');
  });

  it('handles multiple different secrets in one text', () => {
    const s = new SecretScanner();
    const ghToken = 'ghp_' + 'z'.repeat(36);
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const input = `GitHub: ${ghToken}, AWS: ${awsKey}`;
    const result = s.scan(input);
    expect(result.clean).toBe(false);
    expect(result.redacted).not.toContain(ghToken);
    expect(result.redacted).not.toContain(awsKey);
  });
});

// ─── Custom extra patterns ────────────────────────────────────────────────────

describe('SecretScanner — custom patterns', () => {
  it('detects secrets matching a user-supplied pattern', () => {
    const custom: SecretPattern = {
      name: 'internal_service_key',
      pattern: /INTSVC-[A-Z0-9]{16}/,
      redact: () => 'INTSVC-[REDACTED]',
    };
    const s = new SecretScanner([custom]);
    const result = s.scan('Key: INTSVC-ABCD1234EFGH5678 used here.');
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.patternName === 'internal_service_key')).toBe(true);
    expect(result.redacted).toContain('INTSVC-[REDACTED]');
  });

  it('builtin patterns still work alongside custom patterns', () => {
    const custom: SecretPattern = {
      name: 'custom',
      pattern: /CUSTOM-[A-Z]{8}/,
      redact: () => '[CUSTOM REDACTED]',
    };
    const s = new SecretScanner([custom]);
    const result = s.scan('AWS: AKIAIOSFODNN7EXAMPLE and CUSTOM-ABCDEFGH');
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── findings metadata ────────────────────────────────────────────────────────

describe('SecretScanner — finding positions', () => {
  it('records correct start/end positions', () => {
    const s = new SecretScanner();
    const prefix = 'Token is ';
    const token = 'AKIAIOSFODNN7EXAMPLE';
    const result = s.scan(`${prefix}${token} end`);
    const f = result.findings.find((x) => x.patternName === 'aws_access_key_id');
    expect(f).toBeDefined();
    expect(f!.start).toBe(prefix.length);
    expect(f!.end).toBe(prefix.length + token.length);
  });
});
