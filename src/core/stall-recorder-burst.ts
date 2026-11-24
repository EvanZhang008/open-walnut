/**
 * What ran while memory rose: the stall recorder's rolling CPU profile (stall-recorder.ts) is kept
 * for a memory burst too, not only for a stall. 2026-11-24: the server's live heap grew from 2.7 to
 * 4.7 GB in 36 s about five minutes after a restart with no stall, so no profile was kept, and the
 * burst line's in-flight requests and file reads named nothing that size. Allocation is work: the
 * code on the CPU while the footprint rose is the code that built it.
 *
 * Pure parts here; the recorder keeps the windows and writes the file.
 */
import type { CpuProfile } from './stall-recorder-profiler.js';

/** At most one burst profile per this long (a climb logs several burst lines). */
export const BURST_KEEP_EVERY_MS = 10 * 60_000;

interface ProfileNode {
  id: number;
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  children?: number[];
}

const IDLE = /^\((idle|program|root|garbage collector)\)$/;

/**
 * The functions the samples spent their time in: `self` (on top of the stack) and `total`
 * (anywhere on it), each the share of the samples, top `n`. Names as `name:line`.
 */
export function profileTopFrames(profile: CpuProfile, n = 8): { samples: number; self: Array<[string, number]>; total: Array<[string, number]> } {
  const nodes = profile.nodes as ProfileNode[];
  const byId = new Map(nodes.map((x) => [x.id, x] as const));
  const parent = new Map<number, number>();
  for (const x of nodes) for (const c of x.children ?? []) parent.set(c, x.id);
  const name = (x: ProfileNode) => `${x.callFrame.functionName || '(anonymous)'}:${(x.callFrame.lineNumber ?? -1) + 1}`;
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const samples = profile.samples ?? [];
  for (const id of samples) {
    const top = byId.get(id);
    if (!top) continue;
    if (!IDLE.test(top.callFrame.functionName ?? '')) self.set(name(top), (self.get(name(top)) ?? 0) + 1);
    const seen = new Set<string>();
    for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
      const x = byId.get(cur);
      if (!x || IDLE.test(x.callFrame.functionName ?? '')) continue;
      const k = name(x);
      if (seen.has(k)) continue;
      seen.add(k);
      total.set(k, (total.get(k) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => [k, Math.round((1000 * v) / Math.max(1, samples.length)) / 1000] as [string, number]);
  return { samples: samples.length, self: top(self), total: top(total) };
}
