/**
 * CPU checkpoints for the stall flight recorder (stall-recorder.ts): a ring of
 * moments the event loop was free to run its own work, each with the loop
 * thread's CPU clock and the loop's idle time, so a hold is measured from the
 * last one before its deadline to the first one after it (pickHoldSpan in
 * stall-recorder-hold.ts).
 *
 * Two sources. A 100 ms timer, so a quiet loop has a recent checkpoint too.
 * And one at the end of every loop iteration, at most every 5 ms (an unref'd
 * setImmediate, which runs in the check phase, right after poll): after a
 * stop, or a stretch the machine did not run the process, the loop comes back
 * through poll, so this checkpoint runs before any timer that came due
 * meanwhile catches up. A timer cannot promise that: Node runs due timer
 * lists in the order they expire, so any list due between two runs of the
 * recorder's timer goes first, every timer of it that came due back to back.
 * Measured 2026-10-05 (SIGSTOP 1.5 to 3 s): with a timer every 5 ms while the
 * loop was busy, up to 3 stops in 13 of a loop of 25 timers every 900 ms
 * counted their catch-up in the hold; with only the 100 ms one, 1 to 3 stops
 * in 11 of a loop of 20 timers every 5 s. In a bare loop, a batch of timers
 * that came due in a stop ran before the 100 ms timer in 3 of 4 stops, and
 * after the end-of-iteration checkpoint in 4 of 4.
 */

import { readLoopCpuUs, readLoopIdleMs, type CpuCheckpoint } from './stall-recorder-hold.js';

/** How often the timer reads the loop thread's CPU clock (and the loop's idle
 *  time). One threadCpuUsage and one eventLoopUtilization call per checkpoint. */
const CPU_CHECKPOINT_MS = 100;
/** The check-phase checkpoint is skipped when the last one is this recent, so
 *  a loop running thousands of iterations a second pays one clock read per
 *  iteration and at most 200 CPU reads a second (round 7's busy cadence, at
 *  its most). The cost: a hold may start up to this much before its deadline.
 *  A stop or a block is always longer, so the checkpoint right after one is
 *  never skipped. Measured 2026-10-05 at load 40 to 60: a loop of 1 ms timers
 *  (300 to 500 iterations a second) spent about 27 us more loop thread CPU per
 *  iteration with a checkpoint at the end of each. */
const CHECK_MIN_GAP_MS = 5;
/** Checkpoints kept: over 5 s at the busiest (one per CHECK_MIN_GAP_MS), well
 *  past one probe interval when the loop is quieter. */
const CPU_CHECKPOINTS = 1024;

const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6;

/** Ring of CPU checkpoints (pickHoldSpan), newest at cpHead - 1. */
const cpMono = new Float64Array(CPU_CHECKPOINTS);
const cpCpuUs = new Float64Array(CPU_CHECKPOINTS);
const cpIdleMs = new Float64Array(CPU_CHECKPOINTS);
let cpHead = 0;
let cpCount = 0;
let lastMono = -Infinity;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
let checkImmediate: ReturnType<typeof setImmediate> | null = null;
export function cpuCheckpoint(mono: number = monoMs(), cpuUs: number = readLoopCpuUs(), idleMs: number = readLoopIdleMs()): void {
  cpMono[cpHead] = mono;
  cpCpuUs[cpHead] = cpuUs;
  cpIdleMs[cpHead] = idleMs;
  cpHead = (cpHead + 1) % CPU_CHECKPOINTS;
  if (cpCount < CPU_CHECKPOINTS) cpCount += 1;
  lastMono = mono;
}
export function* cpuCheckpoints(): Generator<CpuCheckpoint> {
  for (let i = 0; i < cpCount; i++) yield { mono: cpMono[i], cpuUs: cpCpuUs[i], idleMs: cpIdleMs[i] };
}
/** Queue the next check-phase checkpoint. Unref'd, so it never keeps poll
 *  from blocking: it runs once per iteration, whatever woke the loop. */
function armCheck(): void {
  checkImmediate = setImmediate(checkCheckpoint);
  checkImmediate.unref?.();
}
function checkCheckpoint(): void {
  const mono = monoMs();
  if (mono - lastMono >= CHECK_MIN_GAP_MS) cpuCheckpoint(mono);
  armCheck();
}
/** Stop both sources and forget every checkpoint. */
export function stopCpuCheckpoints(): void {
  if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
  if (checkImmediate) { clearImmediate(checkImmediate); checkImmediate = null; }
  cpHead = 0; cpCount = 0; lastMono = -Infinity;
}
/** Start the checkpoints: the 100 ms timer and the one at the end of every iteration. */
export function startCpuCheckpoints(): void {
  stopCpuCheckpoints();
  checkpointTimer = setInterval(() => cpuCheckpoint(), CPU_CHECKPOINT_MS);
  checkpointTimer.unref?.();
  armCheck();
}
