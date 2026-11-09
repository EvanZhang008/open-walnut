/**
 * CPU checkpoints for the stall flight recorder (stall-recorder.ts): a ring of
 * moments the event loop was free to run its own work, each with the loop
 * thread's CPU clock and the loop's idle time, so a hold is measured from the
 * last one before its deadline to the first one after it (pickHoldSpan in
 * stall-recorder-hold.ts).
 *
 * One source: a 100 ms timer, so a quiet loop has a recent checkpoint too.
 * Node also took one at the end of every loop iteration (an unref'd
 * setImmediate, at most every 5 ms), which kept a stop's catch-up out of the
 * hold; bun's loop does not wait in poll while an immediate is queued, so that
 * one spins the loop (bun 1.4.4: 2.4 million iterations and 46% of a core in
 * 2 s of an idle loop), and Walnut runs only on bun since 2026-10-23: a hold may
 * count a stop's catch-up, as it always could on bun.
 */

import { readLoopCpuUs, readLoopIdleMs, type CpuCheckpoint } from './stall-recorder-hold.js';

/** How often the timer reads the loop thread's CPU clock (and the loop's idle
 *  time). One threadCpuUsage and one eventLoopUtilization call per checkpoint. */
const CPU_CHECKPOINT_MS = 100;
/** Checkpoints kept: well past one probe interval. */
const CPU_CHECKPOINTS = 1024;

const monoMs = (): number => Number(process.hrtime.bigint()) / 1e6;

/** Ring of CPU checkpoints (pickHoldSpan), newest at cpHead - 1. */
const cpMono = new Float64Array(CPU_CHECKPOINTS);
const cpCpuUs = new Float64Array(CPU_CHECKPOINTS);
const cpIdleMs = new Float64Array(CPU_CHECKPOINTS);
let cpHead = 0;
let cpCount = 0;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
export function cpuCheckpoint(mono: number = monoMs(), cpuUs: number = readLoopCpuUs(), idleMs: number = readLoopIdleMs()): void {
  cpMono[cpHead] = mono;
  cpCpuUs[cpHead] = cpuUs;
  cpIdleMs[cpHead] = idleMs;
  cpHead = (cpHead + 1) % CPU_CHECKPOINTS;
  if (cpCount < CPU_CHECKPOINTS) cpCount += 1;
}
export function* cpuCheckpoints(): Generator<CpuCheckpoint> {
  for (let i = 0; i < cpCount; i++) yield { mono: cpMono[i], cpuUs: cpCpuUs[i], idleMs: cpIdleMs[i] };
}
/** Stop the timer and forget every checkpoint. */
export function stopCpuCheckpoints(): void {
  if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
  cpHead = 0; cpCount = 0;
}
/** Start the checkpoints: the 100 ms timer. */
export function startCpuCheckpoints(): void {
  stopCpuCheckpoints();
  checkpointTimer = setInterval(() => cpuCheckpoint(), CPU_CHECKPOINT_MS);
  checkpointTimer.unref?.();
}
