/**
 * Time tracking — public surface. Two clocks per task per day: HUMAN time
 * leased by real browser interaction, AGENT time derived from turn results.
 *
 * This is what the ROUTES need (src/web/routes/time.ts). Everything else in
 * these four modules is internal or test-facing, and tests import the module
 * file directly — so a name here means "an outside caller uses it", not "it
 * happens to be exported".
 */

export { startAgentTimeCollector, stopAgentTimeCollector, withLedgerBackfill } from './agent-time.js';
export { getIndex, hydrate, readDayRecords, recordTime, resetTimeStore } from './store.js';
export { dayBoundsMs, foldDayBlocks, foldDaySlices } from './blocks.js';
export { localDateKey, recentDateKeys, sanitizeSamples, summarize } from './rollup.js';
export { TIME_KINDS } from './types.js';
export type { TimeKind, TimeRecord, RollupIndex, TimeSummary } from './types.js';
export type { DayBlocks } from './blocks.js';
