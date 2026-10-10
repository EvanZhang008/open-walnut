/**
 * GC ring for the stall flight recorder (stall-recorder-hold.ts): the start
 * (performance ms), duration and kind of the last 1024 GC entries, and the GC
 * time inside a span. Moved out of stall-recorder-hold.ts unchanged.
 */

import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';

// The ring: start (performance ms), duration, kind.
const GC_RING = 1024;
const gcStart = new Float64Array(GC_RING);
const gcDur = new Float64Array(GC_RING);
const gcKind = new Uint8Array(GC_RING);
let gcHead = 0;
let gcFilled = 0;
const GC_MAJOR = perfConstants.NODE_PERFORMANCE_GC_MAJOR;

export function gcWithin(fromPerfMs: number, toPerfMs: number): { ms: number; count: number; maxMs: number; major: number; majorMs: number } {
  let ms = 0, count = 0, maxMs = 0, major = 0, majorMs = 0;
  for (let i = 0; i < gcFilled; i++) {
    const s = gcStart[i];
    const d = gcDur[i];
    if (s + d < fromPerfMs || s > toPerfMs) continue;
    const overlap = Math.min(s + d, toPerfMs) - Math.max(s, fromPerfMs);
    if (overlap <= 0) continue;
    ms += overlap; count += 1;
    if (d > maxMs) maxMs = d;
    if (gcKind[i] === GC_MAJOR) { major += 1; majorMs += overlap; }
  }
  return { ms: Math.round(ms), count, maxMs: Math.round(maxMs), major, majorMs: Math.round(majorMs) };
}

let gcObserver: PerformanceObserver | null = null;

/** Start recording GC entries into the ring (idempotent). */
export function startGcRing(): void {
  if (gcObserver) return;
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gcStart[gcHead] = e.startTime;
        gcDur[gcHead] = e.duration;
        gcKind[gcHead] = ((e as unknown as { detail?: { kind?: number } }).detail?.kind ?? 0) & 0xff;
        gcHead = (gcHead + 1) % GC_RING;
        if (gcFilled < GC_RING) gcFilled += 1;
      }
    });
    gcObserver.observe({ entryTypes: ['gc'] });
  } catch { gcObserver = null; }
}

export function stopGcRing(): void {
  if (gcObserver) { gcObserver.disconnect(); gcObserver = null; }
  gcHead = 0; gcFilled = 0;
}
