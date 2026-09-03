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
 */
import { startPhase, endPhase } from './main-thread-tracer';
import { slowCallbacksSince } from './trace-dispatchers';

/** Above this the user notices; log it as a warning. */
const FELT_MS = 250;
const MAX_PER_MIN = 30;

let windowStart = 0;
let countThisWindow = 0;

export interface InteractionDeps {
  now: () => number;
  raf: (cb: () => void) => void;
  report: (level: 'info' | 'warn', payload: Record<string, unknown>) => void;
}

function defaults(): InteractionDeps {
  return {
    now: () => performance.now(),
    // Two frames: the first callback runs BEFORE the paint it belongs to, the
    // second runs after that paint has been committed.
    raf: (cb) => window.requestAnimationFrame(() => window.requestAnimationFrame(cb)),
    report: (level, payload) => {
      (level === 'warn' ? console.warn : console.info)('[perf] interaction', payload);
    },
  };
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
  deps.raf(() => {
    const ms = Math.round(deps.now() - t0);
    endPhase(phase);
    const slow = slowCallbacksSince(t0);
    deps.report(ms >= FELT_MS ? 'warn' : 'info', {
      name,
      ms,
      ...meta,
      ...(slow.length ? { slowCallbacks: slow } : {}),
    });
  });
}

/** Test seam: the per-minute cap is module state. */
export function _resetInteractionTimer(): void {
  windowStart = 0;
  countThisWindow = 0;
}
