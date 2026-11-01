/**
 * Where a recording's audio went missing, second by second.
 *
 * 2026-11-01: dictations in the Mac app held seconds less audio than they ran,
 * and the level meter read zeros mid-speech. Each layer has its own clock: the
 * sampler's timer (the page's main thread), the Web Audio clock (the render
 * thread), the side capture's sample count (the ScriptProcessor, delivered on
 * the main thread), the analyser's level (the capture's samples reaching the
 * graph) and the recorder's chunks. A gap in one and not the others names the
 * layer that stopped. Pure: the hook feeds it one sample per tick.
 */

export interface CaptureSample {
  /** Wall ms since the recorder started. */
  wallMs: number;
  /** Audio ms the side capture holds. */
  pcmMs: number;
  /** Web Audio clock, ms since the recording's context started. */
  ctxMs: number;
  /** The analyser read digital zero this tick. */
  zero: boolean;
  /** MediaRecorder bytes so far. */
  recBytes: number;
}

export interface CaptureSecond {
  /** Second index from the start. */
  s: number;
  /** Sampler ticks that ran in it (10 when the main thread kept up). */
  ticks: number;
  zeroTicks: number;
  pcmMs: number;
  ctxMs: number;
  recBytes: number;
}

/** Folds samples into whole seconds: how much each clock advanced in each. */
export function captureSeconds(samples: readonly CaptureSample[]): CaptureSecond[] {
  const out: CaptureSecond[] = [];
  let prev: CaptureSample | null = null;
  for (const x of samples) {
    const s = Math.floor(x.wallMs / 1000);
    while (out.length <= s) out.push({ s: out.length, ticks: 0, zeroTicks: 0, pcmMs: 0, ctxMs: 0, recBytes: 0 });
    const b = out[s];
    b.ticks++;
    if (x.zero) b.zeroTicks++;
    if (prev) {
      b.pcmMs += Math.max(0, x.pcmMs - prev.pcmMs);
      b.ctxMs += Math.max(0, x.ctxMs - prev.ctxMs);
      b.recBytes += Math.max(0, x.recBytes - prev.recBytes);
    }
    prev = x;
  }
  return out;
}

/** True when a second lost audio or level: a clock that fell well behind the wall. */
export function secondIsShort(b: CaptureSecond): boolean {
  return b.ticks < 7 || b.zeroTicks >= 5 || b.pcmMs < 700 || b.ctxMs < 700;
}

/**
 * One compact log line for the seconds that went wrong, with one second of
 * context either side: `s=12 t10 z10 pcm0 ctx1000 rec120`. The seconds before
 * the capture first ran clean are its start, which the hook logs on its own
 * ("mic delivered sound … after the click"), so they are left out.
 */
export function describeShortSeconds(seconds: readonly CaptureSecond[]): string {
  const keep = new Set<number>();
  const firstClean = seconds.findIndex((b) => !secondIsShort(b));
  if (firstClean < 0) return '';
  seconds.forEach((b, i) => {
    // The last second is partial by construction.
    if (i === seconds.length - 1 || i < firstClean) return;
    if (!secondIsShort(b)) return;
    for (const j of [i - 1, i, i + 1]) if (j >= firstClean && j < seconds.length - 1) keep.add(j);
  });
  const kept = [...keep].sort((a, b) => a - b);
  // A throttled sampler (hidden window) makes every second short: keep the
  // line bounded and say how many were left out.
  const shown = kept.slice(0, MAX_DESCRIBED_SECONDS)
    .map((i) => {
      const b = seconds[i];
      return `s=${b.s} t${b.ticks} z${b.zeroTicks} pcm${Math.round(b.pcmMs)} ctx${Math.round(b.ctxMs)} rec${b.recBytes}`;
    })
    .join(' | ');
  return kept.length > MAX_DESCRIBED_SECONDS ? `${shown} | +${kept.length - MAX_DESCRIBED_SECONDS} more seconds` : shown;
}

/** At most this many seconds in one log line. */
export const MAX_DESCRIBED_SECONDS = 30;
