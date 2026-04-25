/**
 * SecretScanner — scans every outgoing string (reply text, PR body update)
 * for secrets before the platform adapter writes it.
 *
 * Bot quotes can paste secrets they found in diffs. Our echo must not
 * re-persist them to the PR thread or PR body.
 *
 * Built-in patterns cover the most common secret formats. Callers can extend
 * with extra patterns via the constructor.
 */

export interface SecretPattern {
  /** Human-readable name shown in findings and audit events. */
  name: string;
  /**
   * Regex to match. Must NOT use the /g flag — the scanner clones patterns
   * with /g internally for correct multi-match iteration.
   */
  pattern: RegExp;
  /** How to replace a match in the redacted output. */
  redact: (match: string) => string;
}

export interface SecretFinding {
  patternName: string;
  /** Start index of the match in the original text. */
  start: number;
  /** End index (exclusive) in the original text. */
  end: number;
  /** Safe representation of what was found (already redacted). */
  redacted: string;
}

export interface SecretScanResult {
  clean: boolean;
  /** Input text with all secrets replaced. Equal to input when clean. */
  redacted: string;
  findings: SecretFinding[];
}

const BUILTIN_PATTERNS: ReadonlyArray<SecretPattern> = [
  {
    name: 'aws_access_key_id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    redact: () => 'AKIA[REDACTED]',
  },
  {
    name: 'aws_secret_access_key',
    pattern: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/,
    redact: (m) => m.replace(/[A-Za-z0-9/+=]{40}/, '[REDACTED]'),
  },
  {
    name: 'github_token',
    pattern: /\b(ghp_|ghs_|gho_|ghr_|github_pat_)[A-Za-z0-9_]{36,}\b/,
    redact: (m) => `${m.slice(0, 8)}[REDACTED]`,
  },
  {
    name: 'private_key_pem',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    redact: () => '[PRIVATE KEY REDACTED]',
  },
  {
    name: 'jwt',
    // Match three base64url segments separated by dots. Min lengths guard
    // against false-positives on short base64 fragments.
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    redact: (m) => `${m.slice(0, 10)}…[JWT REDACTED]`,
  },
  {
    name: 'stripe_key',
    pattern: /\b(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{20,}\b/,
    redact: (m) => `${m.slice(0, 12)}[REDACTED]`,
  },
  {
    name: 'slack_token',
    pattern: /\bxox[baprs]-(?:[0-9a-zA-Z]{10,}-){1,3}[0-9a-zA-Z]{10,}\b/,
    redact: (m) => `${m.slice(0, 12)}[REDACTED]`,
  },
  {
    name: 'generic_api_key',
    pattern: /(?:api[_-]?key|apikey|access[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-.]{20,})["']?/i,
    redact: (m) => m.replace(/([A-Za-z0-9_\-.]{20,})/, '[REDACTED]'),
  },
];

export class SecretScanner {
  private readonly patterns: ReadonlyArray<SecretPattern>;

  constructor(extraPatterns: ReadonlyArray<SecretPattern> = []) {
    this.patterns = [...BUILTIN_PATTERNS, ...extraPatterns];
  }

  scan(text: string): SecretScanResult {
    const findings: SecretFinding[] = [];
    let redacted = text;
    // Track offset between original and redacted string positions
    let offset = 0;

    for (const p of this.patterns) {
      // Clone with /g so we can iterate all matches
      const global = new RegExp(p.pattern.source, `g${p.pattern.flags.replace('g', '')}`);
      let match: RegExpExecArray | null;
      // Re-run against the *original* text so positions are stable
      const original = text;
      global.lastIndex = 0;

      while ((match = global.exec(original)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const replacement = p.redact(match[0]);

        findings.push({
          patternName: p.name,
          start,
          end,
          redacted: replacement,
        });

        // Apply replacement to the working redacted string (adjusting for offset)
        const rStart = start + offset;
        const rEnd = end + offset;
        redacted = redacted.slice(0, rStart) + replacement + redacted.slice(rEnd);
        offset += replacement.length - (end - start);
      }
    }

    // Sort findings by start position for deterministic output
    findings.sort((a, b) => a.start - b.start);

    return {
      clean: findings.length === 0,
      redacted: findings.length === 0 ? text : redacted,
      findings,
    };
  }
}
