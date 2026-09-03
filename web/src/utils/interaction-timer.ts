/**
 * Interaction timer: how long a click took to show up on screen.
 *
 * The gap this fills: on 2026-09-02 the user reported "I open the Files tab and
 * click outside to get out, and it takes like 3 seconds" and asked for the log.
 * There was none. The main-thread tracer sees the block but not what the user
 * asked for, the input-latency monitor only covers keystrokes, and a discrete
 * click (open a panel, close fullscreen) left no trace at all — so every report
 * of "this one action is slow" started from zero.
 *
 * `traceInteraction(name)` brackets one user action from the click to the FIRST
 * PAINTED FRAME after it (double requestAnimationFrame, so React's commit,
 * style, layout and paint are all inside the number). It also opens a tracer
 * phase, so a main-thread block during the interaction names it
 * (`activePhases: ["ui:fullscreen-exit(+2400ms)"]`) instead of being anonymous.
 *
 * Discrete by nature (a few per minute), so every interaction is logged: info
 * when it was fast, warn when the user would have felt it. Rate-limited anyway,
 * because a stuck UI is exactly when a logger must not become the load.
 *
 * ⚠️ A LARGE NUMBER HERE IS NOT AUTOMATICALLY A FREEZE, and the first version did
 * not say so. Waiting on requestAnimationFrame measures "time until the page next
 * painted", and a page stops painting whenever nobody is looking at it: in a
 * WKWebView, occluding the window (switching to another app) throttles rAF, so
 * clicking something and then switching apps reported 29,868ms for a close the
 * app had already done. That cost hours of chasing a phantom 30-second block.
 *
 * So every report now carries the evidence to tell the two apart:
 *  - `frames`  — rAF ticks seen while waiting. Zero means the page never painted.
 *  - `wakeups` — timer ticks seen while waiting. Timers are throttled in the
 *    background (to roughly 1/s) but NOT stopped, while a blocked main thread
 *    runs neither.
 *  - `stalledMs` — the longest stretch where NEITHER heartbeat ran. This, not the
 *    counters, is the discriminator. Counting zeroes was too crude: the real
 *    2,130ms block found by benchmarking the Files panel on 2026-09-03 still got 3
 *    frames and 1 wakeup in (an eternity of) 2.1s, because a block is a contiguous
 *    stretch of nothing rather than a total absence. An occluded page keeps a
 *    regular timer cadence, so its longest common gap stays small even when it
 *    paints nothing for 30s.
 *  - `verdict` — that judgement, spelled out, so nobody has to re-derive it.
 */
import { startPhase, endPhase } from './main-thread-tracer';
import { slowCallbacksSince } from './trace-dispatchers';

/** Above this the user notices; log it as a warning. */
const FELT_MS = 250;
const MAX_PER_MIN = 30;
/** Below this, frames vs wakeups cannot say anything useful — it was just fast. */
const VERDICT_FLOOR_MS = 1_000;
const TICK_MS = 250;
/** A stall shorter than this is ordinary scheduling, not a freeze. */
const STALL_MIN_MS = 500;
/** …and it has to account for most of the wait, or the page was merely busy. */
const STALL_SHARE = 0.5;

let windowStart = 0;
let countThisWindow = 0;

export interface InteractionDeps {
  now: () => number;
  raf: (cb: () => void) => void;
  /** Single-frame rAF, used only to count how often the page painted. */
  rafTick: (cb: () => void) => void;
  timer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  hidden: () => boolean;
  report: (level: 'info' | 'warn', payload: Record<string, unknown>) => void;
}

function defaults(): InteractionDeps {
  return {
    now: () => performance.now(),
    // Two frames: the first callback runs BEFORE the paint it belongs to, the
    // second runs after that paint has been committed.
    raf: (cb) => window.requestAnimationFrame(() => window.requestAnimationFrame(cb)),
    rafTick: (cb) => window.requestAnimationFrame(() => cb()),
    timer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    hidden: () => document.visibilityState === 'hidden',
    report: (level, payload) => {
      (level === 'warn' ? console.warn : console.info)('[perf] interaction', payload);
    },
  };
}

/** Blocked, background-throttled, or genuinely slow — stated, not implied. */
function verdictFor(
  ms: number,
  frames: number,
  everHidden: boolean,
  stalledMs: number,
): string | undefined {
  if (ms < VERDICT_FLOOR_MS) return undefined;
  // A freeze is a CONTIGUOUS stretch where both heartbeats stopped. Occlusion stops
  // only the painting one, so its longest common gap stays near the timer cadence.
  if (stalledMs >= STALL_MIN_MS && stalledMs >= ms * STALL_SHARE) return 'main-thread-blocked';
  if (frames === 0) return everHidden ? 'page-hidden' : 'not-painting';
  return 'slow-but-painting';
}

/**
 * Time one user action. Call it in the click handler, BEFORE the state update:
 * the measurement then covers the same span the user is waiting through.
 */
export function traceInteraction(
  name: string,
  meta: Record<string, unknown> = {},
  overrides: Partial<InteractionDeps> = {},
): void {
  const deps = { ...defaults(), ...overrides };
  const t0 = deps.now();
  if (t0 - windowStart > 60_000) { windowStart = t0; countThisWindow = 0; }
  if (countThisWindow >= MAX_PER_MIN) return;
  countThisWindow++;

  const phase = `ui:${name}`;
  startPhase(phase);

  // Two independent heartbeats, running until the paint lands. Neither is the
  // measurement; together they say WHY the measurement is what it is.
  let frames = 0;
  let wakeups = 0;
  let everHidden = deps.hidden();
  let done = false;
  let handle: unknown;
  // Not just how MANY beats arrived, but how long the longest silence was: that is
  // what separates a frozen thread from a page nobody is compositing.
  let lastFrameAt = t0;
  let lastWakeAt = t0;
  let worstFrameGap = 0;
  let worstWakeGap = 0;
  const beatFrames = () => {
    if (done) return;
    const at = deps.now();
    worstFrameGap = Math.max(worstFrameGap, at - lastFrameAt);
    lastFrameAt = at;
    frames++;
    deps.rafTick(beatFrames);
  };
  const beatTimer = () => {
    if (done) return;
    const at = deps.now();
    worstWakeGap = Math.max(worstWakeGap, at - lastWakeAt);
    lastWakeAt = at;
    wakeups++;
    if (deps.hidden()) everHidden = true;
    handle = deps.timer(beatTimer, TICK_MS);
  };
  deps.rafTick(beatFrames);
  handle = deps.timer(beatTimer, TICK_MS);

  deps.raf(() => {
    const end = deps.now();
    const ms = Math.round(end - t0);
    done = true;
    deps.clearTimer(handle);
    endPhase(phase);
    // The tail counts too: a block that never ends until the paint lands leaves its
    // silence in the trailing segment, with no beat afterwards to close the gap.
    const frameGap = Math.max(worstFrameGap, end - lastFrameAt);
    const wakeGap = Math.max(worstWakeGap, end - lastWakeAt);
    const stalledMs = Math.round(Math.min(frameGap, wakeGap));
    const slow = slowCallbacksSince(t0);
    const verdict = verdictFor(ms, frames, everHidden, stalledMs);
    deps.report(ms >= FELT_MS ? 'warn' : 'info', {
      name,
      ms,
      ...meta,
      ...(ms >= VERDICT_FLOOR_MS ? { frames, wakeups, stalledMs, hidden: everHidden } : {}),
      ...(verdict ? { verdict } : {}),
      ...(slow.length ? { slowCallbacks: slow } : {}),
    });
  });
}

/** Test seam: the per-minute cap is module state. */
export function _resetInteractionTimer(): void {
  windowStart = 0;
  countThisWindow = 0;
}
