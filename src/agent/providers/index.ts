/**
 * Multi-provider system — barrel export.
 *
 * Only exports what external consumers need. Internal modules
 * import directly from their source files.
 */
export type {
  ApiProtocol,
  ProtocolAdapter,
  ProviderConfig,
  ModelEntry,
  ModelCompat,
  AdapterCallOptions,
  ModelResult,
  UsageStats,
} from './types.js';

export {
  resolveProvider,
  buildProviderMap,
  synthesizeFromLegacy,
  resetAllAdapters,
} from './registry.js';
export type { ResolvedProvider } from './registry.js';

export { resolveProviderSecrets } from './secret.js';

export {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT,
} from './defaults.js';
