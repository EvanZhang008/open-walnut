/**
 * The CPU profiler behind the stall flight recorder (stall-recorder.ts), as
 * titled profiles that may overlap so a rotation never leaves V8's profiler
 * idle (see the recorder's header for the measured cost of an idle restart),
 * and what a kept profile saw inside one hold (profileHoldShare, stallViews).
 */

import type { StallReport } from './event-loop-monitor.js';

/**
 * Titled profiles that may overlap. begin() of a second title while one is
 * running is cheap; end() returns that title's samples only.
 */
export interface ProfilerDriver {
  begin(title: string): Promise<void>;
  end(title: string): Promise<CpuProfile>;
  close(): Promise<void>;
}

export interface CpuProfile {
  nodes: unknown[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** What the kept CPU profile saw inside one hold (stall-recorder.ts). */
export interface ProfileHold {
  /** Samples inside the hold window. */
  samples: number;
  /** Share of the hold the samples stand for: each counts for at most two
   *  sampling intervals, so a sampler that ran late covers little. Low coverage
   *  says the sampler fell behind, not the loop thread: measured 2026-10-03, a
   *  2.6 s hot loop at load 11 in the utility band got 50 samples (in catch-up
   *  bursts, then one per 50 to 170 ms) while the thread ran 2.25 s of CPU. */
  coverage: number;
  /** Share of the sampled time with a code frame on top (JavaScript or a
   *  native call made from it, running or preempted while running). Time no
   *  sample stands for counts as neither code nor idle. The other shares and
   *  `top` are of the sampled time too. */
  codeShare: number;
  idleShare: number;
  gcShare: number;
  /** The heaviest self frames inside the hold, `name url:line`. */
  top: { frame: string; share: number }[];
}

interface ProfileNode { id: number; callFrame?: { functionName?: string; url?: string; lineNumber?: number } }

const NOT_CODE = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

/** The profile's own sampling interval, when the caller does not know it. */
function medianDeltaUs(deltas: number[]): number {
  const d = deltas.filter((x) => x > 0).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 20_000;
}

/**
 * Who was on the loop thread during [startMono, endMono], from a kept profile.
 * Profile time (us) = monotonic ms * 1000 + offsetUs. Each sample stands for
 * the time until the next one, clipped to the window and to two sampling
 * intervals: a longer gap is time the sampler did not see, which counts as
 * neither code nor idle. Crediting the whole gap to the sample before it made a
 * 3 s SIGSTOP read 84% code (measured 2026-10-03). Shares are of the sampled
 * time, so a sampler that fell behind still reports what it saw; `coverage`
 * says how much that was, and only the thread's own CPU says whether it ran
 * (holdVerdict). Null when the window holds too few samples to say anything.
 */
export function profileHoldShare(
  profile: { nodes: unknown[]; startTime: number; samples?: number[]; timeDeltas?: number[] },
  offsetUs: number, startMono: number, endMono: number, intervalUs?: number,
): ProfileHold | null {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  if (samples.length === 0 || deltas.length !== samples.length) return null;
  const byId = new Map<number, ProfileNode>();
  for (const n of profile.nodes as ProfileNode[]) byId.set(n.id, n);
  const from = startMono * 1000 + offsetUs;
  const to = endMono * 1000 + offsetUs;
  const span = to - from;
  const cap = 2 * (intervalUs && intervalUs > 0 ? intervalUs : medianDeltaUs(deltas));
  let t = profile.startTime;
  let total = 0, code = 0, idle = 0, gc = 0, count = 0;
  const self = new Map<string, number>();
  for (let i = 0; i < samples.length; i++) {
    t += deltas[i];
    const next = i + 1 < deltas.length ? t + deltas[i + 1] : t;
    const w = Math.min(next, t + cap, to) - Math.max(t, from);
    if (w <= 0) continue;
    count += 1;
    total += w;
    const cf = byId.get(samples[i])?.callFrame;
    const name = cf?.functionName || '(anonymous)';
    if (name === '(idle)') idle += w;
    else if (name === '(garbage collector)') gc += w;
    if (NOT_CODE.has(name)) continue;
    code += w;
    const frame = `${name} ${cf?.url ? `${cf.url.replace(/^file:\/\//, '')}:${(cf.lineNumber ?? 0) + 1}` : '(native)'}`;
    self.set(frame, (self.get(frame) ?? 0) + w);
  }
  if (count < 5 || total <= 0 || span <= 0) return null;
  const r = (x: number, of = total): number => Math.round((x / of) * 100) / 100;
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([frame, w]) => ({ frame, share: r(w) }));
  return { samples: count, coverage: r(total, span), codeShare: r(code), idleShare: r(idle), gcShare: r(gc), top };
}

/** The hold proper (captureHold's holdFromMs/holdToMs around the deadline), else the whole probe window. */
function holdSpanMono(s: StallReport): [number, number] {
  const h = s.hold as { holdFromMs?: unknown; holdToMs?: unknown } | undefined;
  if (typeof h?.holdFromMs === 'number' && typeof h.holdToMs === 'number' && h.holdToMs > h.holdFromMs) {
    return [Math.max(s.holdStartMono, s.dueMono + h.holdFromMs), Math.min(s.holdEndMono, s.dueMono + h.holdToMs)];
  }
  return [s.holdStartMono, s.holdEndMono];
}

/**
 * What a kept profile saw of one stall: the hold proper (`hold`, the flight
 * record's `profileHold`), and the part after it up to the probe (`after`,
 * `profileAfter`) when the thread ran at least `afterMinMs` of CPU there: the
 * code a stop's backlog ran, or a block that started behind the recorder's
 * checkpoint, which the hold's own view does not cover.
 */
export function stallViews(
  profile: CpuProfile, offsetUs: number, s: StallReport, intervalUs: number, afterMinMs: number,
): { hold: ProfileHold | null; after: ProfileHold | null } {
  const [from, to] = holdSpanMono(s);
  let hold: ProfileHold | null = null, after: ProfileHold | null = null;
  try { hold = profileHoldShare(profile, offsetUs, from, to, intervalUs); } catch { /* none */ }
  const busyAfter = (s.hold as { afterHoldCpuMs?: unknown } | undefined)?.afterHoldCpuMs;
  if (typeof busyAfter === 'number' && busyAfter >= afterMinMs && to < s.holdEndMono) {
    try { after = profileHoldShare(profile, offsetUs, to, s.holdEndMono, intervalUs); } catch { /* none */ }
  }
  return { hold, after };
}

/**
 * The in-process inspector as a ProfilerDriver. Titled profiles come from the
 * V8 console's profile()/profileEnd() (inspector.console, so a patched global
 * console cannot interfere); each arrives as Profiler.consoleProfileFinished on
 * this session. A titled profile only starts in a session whose Profiler domain
 * is enabled, which is why the session enables it first.
 */
export async function connectInspectorDriver(intervalUs: number): Promise<ProfilerDriver | null> {
  type V8Console = { profile?: (title: string) => void; profileEnd?: (title: string) => void };
  const inspector = await import('node:inspector');
  const vc = (inspector as unknown as { console?: V8Console }).console;
  if (typeof vc?.profile !== 'function' || typeof vc?.profileEnd !== 'function') return null;
  const s = new inspector.Session();
  s.connect();
  const post = (method: string, params?: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
    s.post(method, params ?? {}, (err: Error | null) => (err ? reject(err) : resolve()));
  });
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: intervalUs });
  } catch (err) {
    try { s.disconnect(); } catch { /* gone */ }
    throw err;
  }
  const waiting = new Map<string, (profile: CpuProfile) => void>();
  s.on('Profiler.consoleProfileFinished', (msg: { params?: { title?: string; profile?: CpuProfile } }) => {
    const title = msg.params?.title;
    const done = title ? waiting.get(title) : undefined;
    if (done && msg.params?.profile) { waiting.delete(title!); done(msg.params.profile); }
  });
  return {
    begin: async (title) => { vc.profile!(title); },
    end: (title) => new Promise<CpuProfile>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(title); reject(new Error('profile end timed out')); }, 10_000);
      timer.unref?.();
      waiting.set(title, (p) => { clearTimeout(timer); resolve(p); });
      vc.profileEnd!(title);
    }),
    close: async () => {
      waiting.clear();
      try { await post('Profiler.disable'); } catch { /* not enabled */ }
      try { s.disconnect(); } catch { /* already gone */ }
    },
  };
}
