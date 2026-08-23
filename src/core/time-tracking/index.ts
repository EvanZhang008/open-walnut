/**
 * Time tracking — public surface. Two clocks per task per day: HUMAN time
 * leased by real browser interaction, AGENT time derived from turn results.
 */

export { startAgentTimeCollector, stopAgentTimeCollector, withLedgerBackfill, agentMsFromResult } from './agent-time.js';
export { getIndex, hydrate, readDayRecords, recordTime, resetTimeStore, HYDRATE_DAYS } from './store.js';
export { dayBoundsMs, foldDayBlocks, foldDaySlices, MERGE_GAP_MS, MIN_BLOCK_MS, SLICE_JOIN_GAP_MS } from './blocks.js';
export {
  bucketKey, parseBucketKey, localDateKey, shiftDateKey, recentDateKeys,
  sanitizeSample, sanitizeSamples, addRecord, foldRecords, mergeIndex,
  datesWithAgentTime, summarize,
  MAX_SAMPLE_MS, MAX_SAMPLES_PER_REQUEST,
} from './rollup.js';
export type {
  TimeKind, HumanKind, HeartbeatSample, TimeRecord, RollupIndex,
  TaskDayTime, DayTime, TimeSummary,
} from './types.js';
export type { TimeBlock, DayBlocks, TaskTotal } from './blocks.js';
