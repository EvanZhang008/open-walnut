/**
 * Usage tracking barrel — singleton tracker and re-exports.
 */

import { UsageTracker } from './tracker.js';
import { USAGE_DB_FILE } from '../../constants.js';

export { UsageTracker } from './tracker.js';
export { computeCost, findPricing, DEFAULT_PRICING, PRICING_VERSION } from './pricing.js';
export type { PricingEntry } from './pricing.js';
export type {
  UsageRecord,
  UsageSummary,
  DailyCost,
  UsageByGroup,
  UsageSource,
  UsagePeriod,
  RecordParams,
} from './types.js';

/** Singleton usage tracker instance. */
export const usageTracker = new UsageTracker(USAGE_DB_FILE);
