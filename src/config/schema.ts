/**
 * Zod schema for `.maestro.yaml` and `~/.maestro/config.yaml`.
 *
 * All fields are optional at the schema level; required-ness is enforced by
 * the loader after layering, so a user config can supply the API key and a
 * repo config can supply everything else.
 */

import { z } from 'zod';

// ─── AI providers + routing ────────────────────────────────────────────────

const ModelTierSchema = z.enum(['cheap', 'strong', 'flagship']);

const AIProviderTypeSchema = z.enum(['claude', 'openai', 'google', 'local', 'custom']);

const ProviderConfigSchema = z
  .object({
    type: AIProviderTypeSchema,
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    models: z.record(ModelTierSchema, z.string()).optional(),
    defaultTier: ModelTierSchema.optional(),
    timeout: z.number().int().positive().optional(),
    retries: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const RoutingTargetSchema = z.object({
  provider: z.string().min(1),
  tier: ModelTierSchema.default('cheap'),
});

const RoutingSchema = z
  .object({
    commitMessage: RoutingTargetSchema.optional(),
    prBodyDraft: RoutingTargetSchema.optional(),
    classifyUnknown: RoutingTargetSchema.optional(),
    semanticDedup: RoutingTargetSchema.optional(),
    tasteDetection: RoutingTargetSchema.optional(),
    finalSummary: RoutingTargetSchema.optional(),
    fallback: RoutingTargetSchema.optional(),
  })
  .passthrough();

const AISchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  routing: RoutingSchema.default({}),
});

// ─── Platform ──────────────────────────────────────────────────────────────

const PlatformTypeSchema = z.enum(['github', 'gitlab', 'gitea', 'gitee']);

const PlatformAuthSchema = z.object({
  tokenEnv: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
});

const PlatformSchema = z.object({
  type: PlatformTypeSchema,
  auth: PlatformAuthSchema.default({}),
  baseUrl: z.string().url().optional(),
  owner: z.string().optional(),
  repo: z.string().optional(),
});

// ─── Bots ──────────────────────────────────────────────────────────────────

const BotTreatAsSchema = z.enum(['blocking', 'advisory']);

const BotRegistryEntrySchema = z.object({
  login: z.string().min(1),
  treatAs: BotTreatAsSchema.default('advisory'),
  severityMap: z.record(z.string(), z.string()).optional(),
});

const ConventionRuleSchema = z
  .object({
    loginContains: z.array(z.string()).optional(),
    appSlugContains: z.array(z.string()).optional(),
    commentBodyContains: z.array(z.string()).optional(),
  })
  .refine(
    (r) => Boolean(r.loginContains?.length || r.appSlugContains?.length || r.commentBodyContains?.length),
    { message: 'detection rule must specify at least one of loginContains, appSlugContains, commentBodyContains' },
  );

const BotsSchema = z.object({
  /** Bot logins maestro watches for reviews (used by `maestro bots setup`). */
  watch: z.array(z.string()).default([]),
  registry: z.array(BotRegistryEntrySchema).default([]),
  detectByConvention: z
    .object({
      enabled: z.boolean().default(true),
      rules: z.array(ConventionRuleSchema).default([]),
    })
    .default({ enabled: true, rules: [] }),
});

// ─── Stop conditions ───────────────────────────────────────────────────────

const StopConditionsSchema = z.object({
  /** Hard cap on rounds. Cannot exceed 5 even if user tries. */
  maxRounds: z.number().int().min(1).max(5).default(3),
  /** Jaccard similarity threshold; above = oscillation. */
  jaccardCeiling: z.number().min(0).max(1).default(0.7),
  /** After which round no new finding category may appear. */
  noNewCategoryAfterRound: z.number().int().min(1).default(2),
  duplicateFindingPolicy: z.enum(['pushback', 'escalate', 'accept']).default('pushback'),
  ciFail: z.enum(['exit', 'retry-with-fix']).default('exit'),
  idleTimeoutPolls: z.number().int().positive().default(20),
  quietPeriodSec: z.number().int().nonnegative().default(90),
  costBudgetUSD: z.number().nonnegative().default(5),
});

// ─── Preflight (local pre-push) ────────────────────────────────────────────

const PreflightStepSchema = z.enum(['selfReview', 'lint', 'typecheck', 'test']);

const PreflightSchema = z.object({
  enabled: z.boolean().default(true),
  steps: z.array(PreflightStepSchema).default(['selfReview', 'lint', 'typecheck', 'test']),
  blockOnSeverity: z.enum(['critical', 'high', 'medium']).default('critical'),
});

// ─── Language plugins ──────────────────────────────────────────────────────

const LanguagePluginSchema = z.object({
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  test: z.string().optional(),
  format: z.string().optional(),
});

const PluginsSchema = z.object({
  languages: z.record(z.string(), LanguagePluginSchema).default({}),
});

// ─── PR body template ──────────────────────────────────────────────────────

const PRBodySchema = z.object({
  marker: z
    .object({
      start: z.string().default('<!-- maestro:start -->'),
      end: z.string().default('<!-- maestro:end -->'),
    })
    .default({ start: '<!-- maestro:start -->', end: '<!-- maestro:end -->' }),
  template: z.string().optional(),
});

// ─── Security ──────────────────────────────────────────────────────────────

const SecuritySchema = z.object({
  scanOutgoing: z.boolean().default(true),
  redactPatterns: z
    .array(z.string())
    .default([
      '(?i)api[_-]?key',
      '(?i)secret',
      '(?i)password',
      '(?i)token',
      'ghp_[A-Za-z0-9]{20,}',
      'sk-[A-Za-z0-9]{20,}',
    ]),
});

// ─── Audit ─────────────────────────────────────────────────────────────────

const AuditSchema = z.object({
  enabled: z.boolean().default(true),
  dir: z.string().default('.maestro/audit'),
  shadowLogClassifications: z.boolean().default(true),
});

// ─── Logging ───────────────────────────────────────────────────────────────

const LoggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  format: z.enum(['text', 'jsonl']).default('jsonl'),
  eventStream: z.string().default('.maestro/events.jsonl'),
});

// ─── Advanced ──────────────────────────────────────────────────────────────

const AdvancedSchema = z.object({
  cacheProviders: z.boolean().default(true),
  retryStrategy: z
    .object({
      maxRetries: z.number().int().nonnegative().default(3),
      backoffMultiplier: z.number().positive().default(2),
    })
    .default({ maxRetries: 3, backoffMultiplier: 2 }),
  rateLimit: z
    .object({
      honorRemainingHeader: z.boolean().default(true),
      minInterRequestMs: z.number().int().nonnegative().default(100),
    })
    .default({ honorRemainingHeader: true, minInterRequestMs: 100 }),
});

// ─── Top-level ─────────────────────────────────────────────────────────────

export const MaestroConfigSchema = z.object({
  ai: AISchema.default({ providers: {}, routing: {} }),
  platform: PlatformSchema,
  bots: BotsSchema.default({ watch: [], registry: [], detectByConvention: { enabled: true, rules: [] } }),
  stopConditions: StopConditionsSchema.default({}),
  preflight: PreflightSchema.default({}),
  plugins: PluginsSchema.default({ languages: {} }),
  prBody: PRBodySchema.default({}),
  security: SecuritySchema.default({}),
  audit: AuditSchema.default({}),
  logging: LoggingSchema.default({}),
  advanced: AdvancedSchema.default({}),
});

export type MaestroConfig = z.infer<typeof MaestroConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
export type Routing = z.infer<typeof RoutingSchema>;
export type PlatformConfig = z.infer<typeof PlatformSchema>;
export type BotRegistryEntry = z.infer<typeof BotRegistryEntrySchema>;
export type StopConditions = z.infer<typeof StopConditionsSchema>;
export type Preflight = z.infer<typeof PreflightSchema>;
export type LanguagePlugin = z.infer<typeof LanguagePluginSchema>;
