/**
 * Public entry for the config module.
 */

export {
  loadConfig,
  deepMerge,
  ConfigError,
  type LoadConfigOptions,
} from './load';

export {
  MaestroConfigSchema,
  type MaestroConfig,
  type ProviderConfig,
  type RoutingTarget,
  type Routing,
  type PlatformConfig,
  type BotRegistryEntry,
  type StopConditions,
  type Preflight,
  type LanguagePlugin,
} from './schema';

export { expandString, expandValue, EnvExpansionError } from './expand';
