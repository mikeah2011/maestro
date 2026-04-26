/**
 * FixEngine — the real onFix implementation for M6.
 *
 * For each classified finding:
 *   1. Read ±CONTEXT_LINES of file content around the finding's line.
 *   2. Build a structured prompt and call AIProvider.complete().
 *   3. Parse the JSON response into line replacements.
 *   4. Apply replacements bottom-to-top (preserves line numbers).
 *   5. Write the mutated file back to disk.
 *
 * The engine is stateless — it holds no mutable state between rounds.
 * All side effects (file I/O) are injected via the `readFile` / `writeFile`
 * options so tests can swap them out without touching the real filesystem.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AIProvider, ModelTier } from '../../ai/interfaces/AIProvider';
import type { Finding } from '../types/Finding';
import type { FixResult } from '../loop/LoopOrchestrator';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FixEngineOptions {
  provider: AIProvider;
  /** Repo root for resolving file paths. Defaults to process.cwd(). */
  repoRoot?: string;
  /** AI tier for fix generation. Default: 'strong'. */
  tier?: ModelTier;
  /** Max output tokens per fix call. Default: 2048. */
  maxTokens?: number;
  /** Minimum AI confidence to actually apply a fix. Default: 0.7. */
  minConfidence?: number;
  /** Injectable file reader — swap for tests. */
  readFile?: (path: string) => Promise<string>;
  /** Injectable file writer — swap for tests. */
  writeFile?: (path: string, content: string) => Promise<void>;
}

// ─── AI response schema ───────────────────────────────────────────────────────

interface LineReplacement {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Replacement text; lines joined with '\n'. */
  newContent: string;
}

interface FixResponse {
  canFix: boolean;
  /** 0–1 confidence; fixes below minConfidence are skipped. */
  confidence?: number;
  /** ≤72-char past-tense description, used as the commit line. */
  description?: string;
  replacements?: LineReplacement[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CONTEXT_LINES = 20;

// ─── FixEngine ────────────────────────────────────────────────────────────────

export class FixEngine {
  private readonly provider: AIProvider;
  private readonly repoRoot: string;
  private readonly tier: ModelTier;
  private readonly maxTokens: number;
  private readonly minConfidence: number;
  private readonly readFileFn: (path: string) => Promise<string>;
  private readonly writeFileFn: (path: string, content: string) => Promise<void>;

  constructor(opts: FixEngineOptions) {
    this.provider = opts.provider;
    this.repoRoot = opts.repoRoot ?? process.cwd();
    this.tier = opts.tier ?? 'strong';
    this.maxTokens = opts.maxTokens ?? 2048;
    this.minConfidence = opts.minConfidence ?? 0.7;
    this.readFileFn = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.writeFileFn = opts.writeFile ?? ((p, c) => fsWriteFile(p, c, 'utf8'));
  }

  /** Entry point — matches the LoopOrchestrator onFix signature. */
  async fix(findings: Finding[], _round: number): Promise<FixResult[]> {
    const results: FixResult[] = [];
    for (const finding of findings) {
      const result = await this.fixOne(finding);
      if (result) results.push(result);
    }
    return results;
  }

  private async fixOne(finding: Finding): Promise<FixResult | null> {
    const file = finding.location.file;
    if (!file) return null;

    // ── Read file ────────────────────────────────────────────────────────
    const absPath = resolve(this.repoRoot, file);
    let lines: string[];
    try {
      const content = await this.readFileFn(absPath);
      lines = content.split('\n');
    } catch {
      return null;
    }

    // ── Build context window ─────────────────────────────────────────────
    const startLine = finding.location.startLine ?? 1;
    const ctxStart = Math.max(1, startLine - CONTEXT_LINES);
    const ctxEnd = Math.min(lines.length, startLine + CONTEXT_LINES);

    const numberedContext = lines
      .slice(ctxStart - 1, ctxEnd)
      .map((l, i) => `${ctxStart + i}: ${l}`)
      .join('\n');

    // ── Call AI ──────────────────────────────────────────────────────────
    let fixResp: FixResponse;
    try {
      const completion = await this.provider.complete(
        buildPrompt(finding, numberedContext, ctxStart, ctxEnd),
        {
          tier: this.tier,
          maxTokens: this.maxTokens,
          temperature: 0,
          responseFormat: { type: 'json_object' },
          systemPrompt: SYSTEM_PROMPT,
          callerTag: 'fix_engine',
        },
      );
      fixResp = (completion.parsedJson as FixResponse | undefined) ?? { canFix: false };
    } catch {
      return null;
    }

    // ── Validate response ────────────────────────────────────────────────
    if (!fixResp.canFix) return null;
    if ((fixResp.confidence ?? 1) < this.minConfidence) return null;
    if (!fixResp.replacements?.length) return null;

    // ── Apply replacements bottom-to-top (preserves line numbers) ────────
    const sorted = [...fixResp.replacements].sort((a, b) => b.startLine - a.startLine);
    for (const rep of sorted) {
      const start = Math.max(0, rep.startLine - 1);
      const end = Math.min(lines.length, rep.endLine);
      lines.splice(start, end - start, ...rep.newContent.split('\n'));
    }

    // ── Write file ───────────────────────────────────────────────────────
    try {
      await this.writeFileFn(absPath, lines.join('\n'));
    } catch {
      return null;
    }

    return {
      findingHash: finding.hash,
      description: fixResp.description ?? `Fixed: ${finding.title}`.slice(0, 72),
      files: [file],
    };
  }
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a surgical code-fix assistant in an automated PR review loop.
Findings come from AI code reviewers (CodeRabbit, Copilot, Ellipsis).
Your job: produce minimal, targeted fixes — not refactors.
Apply only what is necessary to resolve this one finding.

Output valid JSON matching this schema exactly:
{
  "canFix": boolean,
  "confidence": number,
  "description": string,
  "replacements": [
    { "startLine": number, "endLine": number, "newContent": string }
  ]
}

Rules:
- Set canFix: false if broader context is needed; omit replacements.
- confidence: 0.0–1.0. Fixes below 0.7 are discarded automatically.
- description: ≤72 chars, past-tense imperative (e.g. "Added null guard before profile access").
- newContent: replacement lines joined with \\n. Preserve indentation and style.
- Never add imports unless strictly necessary.
- Fix one finding; multiple replacements only when they address the same root cause.`;

function buildPrompt(
  finding: Finding,
  numberedContext: string,
  ctxStart: number,
  ctxEnd: number,
): string {
  const lineRange = finding.location.endLine && finding.location.endLine !== finding.location.startLine
    ? `${finding.location.startLine ?? '?'}–${finding.location.endLine}`
    : String(finding.location.startLine ?? '?');

  return `FINDING
File:     ${finding.location.file}
Line:     ${lineRange}
Severity: ${finding.severity}
Title:    ${finding.title}

${finding.body}

FILE CONTEXT (lines ${ctxStart}–${ctxEnd})
\`\`\`
${numberedContext}
\`\`\`

Fix the finding above. Output JSON only.`;
}
