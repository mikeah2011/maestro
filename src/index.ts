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
