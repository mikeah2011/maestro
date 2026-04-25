/**
 * Fenced Classifier — deterministic rules short-circuit before any LLM call.
 *
 * Rule priority (first match wins):
 *   1. Critical raw severity  → bug (confidence 1.0)
 *   2. Critical normalized severity → bug (confidence 1.0)
 *   3. Sensitive path match   → bug (confidence 0.95)
 *   4. Bug keyword in title/body → bug (confidence 0.90)
 *   5. Taste keyword          → taste (confidence 0.85)
 *   6. No rule fired          → call llmClassify or return 'unknown'
 *
 * Every classification (including LLM results) is shadow-logged via onAudit
 * so the full decision trail is available for audit without blocking the loop.
 */

import type { Finding, FindingCategory, FindingClassification } from '../types/Finding';

export interface ClassifierAuditEntry {
  findingHash: string;
  category: FindingCategory;
  confidence: number;
  viaFence: boolean;
  fenceRule?: string;
  model?: string;
}

export interface ClassifierOptions {
  /** Injectable LLM resolver for findings that fall through all fence rules. */
  llmClassify?: (finding: Finding) => Promise<FindingClassification>;
  /** Called synchronously after every classify() resolution. */
  onAudit?: (entry: ClassifierAuditEntry) => void;
}

const CRITICAL_RAW_SEVERITIES: ReadonlySet<string> = new Set([
  'critical',
  'blocker',
  'error',
  'fatal',
]);

const BUG_KEYWORDS: ReadonlyArray<string> = [
  'null pointer', 'nullpointerexception', 'npe',
  'use after free', 'use-after-free',
  'buffer overflow', 'heap overflow', 'stack overflow',
  'memory leak', 'memory corruption',
  'race condition', 'data race',
  'integer overflow', 'integer underflow',
  'divide by zero', 'division by zero',
  'off-by-one', 'off by one',
  'sql injection', 'sqli',
  'cross-site scripting', 'xss',
  'csrf', 'cross-site request forgery',
  'injection attack', 'command injection', 'code injection',
  'path traversal', 'directory traversal',
  'deserialization', 'unsafe deserialization',
  'authentication bypass', 'auth bypass',
  'privilege escalation',
  'infinite loop',
  'deadlock', 'livelock',
  'format string vulnerability',
  'out of bounds', 'array index out of bounds',
  'type confusion', 'type mismatch',
];

const TASTE_KEYWORDS: ReadonlyArray<string> = [
  'nitpick:', 'nit:', 'nit -',
  'consider renaming',
  'cosmetic', 'purely cosmetic',
  'style preference', 'personal preference',
  'minor style',
  'just a suggestion',
  'you might want to', 'you could',
  'optionally,', 'optional:',
];

const SENSITIVE_PATH_PREFIXES: ReadonlyArray<string> = [
  '/auth/', '/authenticate/', '/authorization/', '/oauth/', '/saml/', '/sso/',
  '/crypto/', '/encryption/', '/decryption/', '/cipher/',
  '/payment/', '/billing/', '/checkout/', '/stripe/', '/paypal/',
  '/security/', '/secret/', '/token/', '/credential/', '/password/',
  '/jwt/', '/session/',
];

export class Classifier {
  private readonly options: ClassifierOptions;

  constructor(options: ClassifierOptions = {}) {
    this.options = options;
  }

  async classify(finding: Finding): Promise<FindingClassification> {
    const fenceResult = this.runFence(finding);

    if (fenceResult !== null) {
      this.emitAudit(finding.hash, fenceResult);
      return fenceResult;
    }

    if (this.options.llmClassify) {
      const llmResult = await this.options.llmClassify(finding);
      this.emitAudit(finding.hash, llmResult);
      return llmResult;
    }

    const unknown: FindingClassification = { category: 'unknown', confidence: 0, viaFence: false };
    this.emitAudit(finding.hash, unknown);
    return unknown;
  }

  /**
   * Run the deterministic fence. Returns a classification if a rule fires,
   * null if no rule matches (meaning the LLM should be consulted).
   */
  runFence(finding: Finding): FindingClassification | null {
    // Rule 1: bot-assigned raw severity is critical
    if (
      finding.rawSeverity !== undefined &&
      CRITICAL_RAW_SEVERITIES.has(finding.rawSeverity.toLowerCase())
    ) {
      return {
        category: 'bug',
        confidence: 1,
        viaFence: true,
        fenceRule: 'critical_raw_severity',
      };
    }

    // Rule 2: our normalized severity ladder says critical
    if (finding.severity === 'critical') {
      return {
        category: 'bug',
        confidence: 1,
        viaFence: true,
        fenceRule: 'critical_severity',
      };
    }

    // Rule 3: file lives in a sensitive path
    const fileLower = finding.location.file.toLowerCase();
    for (const prefix of SENSITIVE_PATH_PREFIXES) {
      if (fileLower.includes(prefix)) {
        return {
          category: 'bug',
          confidence: 0.95,
          viaFence: true,
          fenceRule: `sensitive_path:${prefix}`,
        };
      }
    }

    // Rule 4: bug keyword in title or body
    const searchText = `${finding.title} ${finding.body}`.toLowerCase();
    for (const kw of BUG_KEYWORDS) {
      if (searchText.includes(kw)) {
        return {
          category: 'bug',
          confidence: 0.9,
          viaFence: true,
          fenceRule: `bug_keyword:${kw}`,
        };
      }
    }

    // Rule 5: taste keyword in title or body
    const titleLower = finding.title.toLowerCase();
    const bodyLower = finding.body.toLowerCase();
    for (const kw of TASTE_KEYWORDS) {
      if (titleLower.includes(kw) || bodyLower.includes(kw)) {
        return {
          category: 'taste',
          confidence: 0.85,
          viaFence: true,
          fenceRule: `taste_keyword:${kw}`,
        };
      }
    }

    return null;
  }

  private emitAudit(findingHash: string, result: FindingClassification): void {
    this.options.onAudit?.({
      findingHash,
      category: result.category,
      confidence: result.confidence,
      viaFence: result.viaFence,
      fenceRule: result.fenceRule,
      model: result.model,
    });
  }
}
