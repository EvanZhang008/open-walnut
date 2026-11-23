/**
 * How many sessions' liveness one scan asks at once (session-tracker.ts livenessOfAll, the health
 * monitor's prefetchLiveness). A remote session's answer is one daemon `status` round trip: asked
 * one after another, ~125 sessions cost a health tick 0.5 to 1.8 s (2026-11-13), and 38 running
 * sessions on a busy host link held GET /hosts/load past 10 s and task starts up to two minutes
 * (2026-11-23). Read-only, so a few at once changes no outcome.
 */
export const LIVENESS_PROBE_CONCURRENCY = 8
