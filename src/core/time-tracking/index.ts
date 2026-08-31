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
export {
  isOutsideCollectorRunning, outsideHelperReason, startOutsideCollector, stopOutsideCollector,
} from './outside-collector.js';
export type { HelperUnavailable } from './outside-collector.js';
export { hydrateOutside, outsideDayRecords, outsideDayRows, recordOutside, resetOutsideStore } from './outside-store.js';
export { foldOutsideApps, foldOutsideTimeline, walnutHostsFromConfig } from './outside-view.js';
export type { OutsideRecord, OutsideRow } from './outside-store.js';
export type {
  OutsideApp, OutsideAppTimeline, OutsideBlock, OutsideDayFold, OutsideSite, OutsideTimelineFold,
} from './outside-view.js';
export { getIndex, hydrate, readDayRecords, recordTime, resetTimeStore } from './store.js';
export { dayBoundsMs, foldDayBlocks, foldDaySlices } from './blocks.js';
export { localDateKey, recentDateKeys, sanitizeSamples, summarize } from './rollup.js';
// Ingest: the phone/relay path (bank + dedupe + durability) and the one piece the
// browser's fire-and-forget route shares. See the header of ingest.ts for the split.
export {
  attachTaskIdsBounded, bankHeartbeatSamples, narrowRelaySamples, resetHeartbeatDedupe,
} from './ingest.js';
export type { BankOutcome } from './ingest.js';
export { TIME_KINDS, TIME_SOURCES } from './types.js';
export type { TimeKind, TimeRecord, TimeSource, RollupIndex, TimeSummary } from './types.js';
export type { DayBlocks } from './blocks.js';
