/**
 * Public library entry. Re-exports the interfaces and types that consumers
 * (CI scripts, tests, future plugins) need to import.
 *
 * Concrete implementations are wired via the registry pattern; consumers
 * import the registries they need, not individual provider classes.
 */

// AI provider abstractions
export type {
  AIProviderType,
  AIProviderConfig,
  CompletionOptions,
  CompletionResult,
  CompletionUsage,
  FinishReason,
  ModelTier,
  ResponseFormat,
} from './ai/interfaces/AIProvider';
export { AIProvider } from './ai/interfaces/AIProvider';

// Git platform abstractions
export type {
  PlatformType,
  GitPlatformConfig,
  PlatformCapabilities,
  RateLimitInfo,
} from './platforms/interfaces/GitPlatform';
export { GitPlatform } from './platforms/interfaces/GitPlatform';

// Orchestrator domain types
export type {
  Severity,
  FindingCategory,
  FindingLocation,
  BotIdentity,
  Finding,
  FindingClassification,
  BotReview,
  ReviewThread,
  ThreadComment,
} from './core/types/Finding';

export type { CICheckState, CICheck, CIStatus } from './core/types/CI';

export type {
  PullRequestState,
  PullRequest,
  PullRequestDiff,
  PullRequestDiffFile,
} from './core/types/PullRequest';

// Loop primitives (M2 — Loop port)
export type {
  MaestroEvent,
  EventSink,
  EventHandler,
  EventEmitterOptions,
} from './core/events/EventEmitter';
export {
  EventEmitter,
  toLine,
  streamSink,
  stdoutSink,
} from './core/events/EventEmitter';

export type {
  RoundBudgetInvariant,
  RoundBudgetSnapshot,
} from './core/round/RoundBudget';
export { RoundBudget, RoundBudgetViolation } from './core/round/RoundBudget';

export type { PendingFix, RoundCommit } from './core/round/CommitThrottle';
export { CommitThrottle, CommitThrottleError } from './core/round/CommitThrottle';

export type { LoopState, StateMachineOptions } from './core/state/StateMachine';
export { StateMachine, StateTransitionError } from './core/state/StateMachine';

// Convergence primitives (M3)
export type {
  ConvergenceStatus,
  ConvergenceResult,
} from './core/convergence/ConvergenceMonitor';
export {
  ConvergenceMonitor,
  computeContentHash,
  computeFindingHash,
  lineBucket,
} from './core/convergence/ConvergenceMonitor';

// Classifier (M3)
export type {
  ClassifierAuditEntry,
  ClassifierOptions,
} from './core/classify/Classifier';
export { Classifier } from './core/classify/Classifier';

// Deduplication (M3)
export type {
  DedupTierStats,
  DedupResult,
  DedupOptions,
} from './core/dedup/Dedup';
export { Dedup, levenshtein, normalizedSimilarity } from './core/dedup/Dedup';

// Secret scanner (M3)
export type {
  SecretPattern,
  SecretFinding,
  SecretScanResult,
} from './core/security/SecretScanner';
export { SecretScanner } from './core/security/SecretScanner';

// GitHub platform (M4)
export type { GraphQLClient, GitHubClients } from './platforms/github/GitHubPlatform';
export { GitHubPlatform } from './platforms/github/GitHubPlatform';
export type {
  GHPullRequest,
  GHDiffFile,
  GHReview,
  GHGraphQLThread,
  GHCheckRun,
  GHRateLimit,
} from './platforms/github/mappers';
export {
  mapPullRequest,
  mapDiffFiles,
  mapReview,
  mapGraphQLThread,
  mapCheckRuns,
  mapRateLimit,
} from './platforms/github/mappers';
