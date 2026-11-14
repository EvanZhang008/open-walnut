/**
 * Input-latency monitor: measures what "typing feels laggy" actually is.
 *
 * For every keystroke into an editable element it records two numbers, both
 * anchored at the OS event time (`event.timeStamp` is the hardware timestamp
 * in WebKit and Chromium, so the UI-process → page-process hop the Mac app
 * adds is INSIDE the measurement, not hidden from it):
 *
 *   queueMs: OS event → our keydown handler ran (how long the key waited)
 *   paintMs: OS event → the next animation frame (when the glyph could show)
 *
 * Windows of 30s are summarised as p50/p95/max and the count of keystrokes over
 * FELT_MS, and logged through the standard forwarder as `[perf] input latency`
 * with `client: 'mac-app' | 'browser'`, so one grep compares the two clients
 * typing into the same server (`walnut-logs.sh desktop` prints both). A window
 * is logged when it is slow, and once every REPORT_QUIET_MS regardless, so a
 * healthy baseline is always on file to compare a bad one against.
 *
 * Why: on 2026-09-02 the Mac app felt laggy while Chrome on the same server
 * was smooth, and there was no number anywhere for either. Profiling the app
 * process caught it idle: passive sampling misses latency the user feels.
 */

const WINDOW_MS = 30_000;
/** Above this a keystroke is visibly late. */
const FELT_MS = 100;
/** Log a window as slow when its p95 passes this or any key passed FELT_MS×2. */
const SLOW_P95_MS = 50;
/** Always log at least one window per this interval when typing happened. */
const REPORT_QUIET_MS = 5 * 60_000;
const MIN_KEYS_FOR_REPORT = 5;

export type InputClient = 'mac-app' | 'browser';

/** The Mac app's WKWebView exposes its native bridges; a browser never does. */
export function detectInputClient(w: Window = window): InputClient {
  const handlers = (w as Window & {
    webkit?: { messageHandlers?: Record<string, unknown> };
  }).webkit?.messageHandlers;
  return handlers && ('walnutChrome' in handlers || 'walnutClipboard' in handlers) ? 'mac-app' : 'browser';
}

export interface LatencyWindow {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Keystrokes over FELT_MS. */
  slow: number;
  queueP95: number;
}

/** Pure aggregation, so the rule is testable without a DOM or a clock. */
export function summarize(paint: number[], queue: number[]): LatencyWindow {
  const sorted = [...paint].sort((a, b) => a - b);
  const q = [...queue].sort((a, b) => a - b);
  const pick = (arr: number[], p: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
  return {
    n: sorted.length,
    p50: Math.round(pick(sorted, 0.5)),
    p95: Math.round(pick(sorted, 0.95)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    slow: sorted.filter((v) => v > FELT_MS).length,
    queueP95: Math.round(pick(q, 0.95)),
  };
}

export function isSlowWindow(w: LatencyWindow): boolean {
  return w.p95 > SLOW_P95_MS || w.max > FELT_MS * 2;
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable === true;
}

export interface InputLatencyDeps {
  now: () => number;
  raf: (cb: () => void) => void;
  report: (summary: LatencyWindow & { client: InputClient; url: string; reason: 'slow' | 'periodic' }) => void;
  client: InputClient;
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>;
}

export function initInputLatencyMonitor(overrides: Partial<InputLatencyDeps> = {}): () => void {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return () => {};
  // Defaults resolved lazily: a test that injects every dep must not need a DOM.
  const deps: InputLatencyDeps = {
    now: overrides.now ?? (() => performance.now()),
    raf: overrides.raf ?? ((cb) => window.requestAnimationFrame(cb)),
    report: overrides.report ?? ((s) => {
      const { reason, ...rest } = s;
      // console.info → browser-logger → server log (subsystem=browser, [perf] prefix).
      (reason === 'slow' ? console.warn : console.info)('[perf] input latency', rest);
    }),
    client: overrides.client ?? detectInputClient(),
    target: overrides.target ?? document,
  };

  let paint: number[] = [];
  let queue: number[] = [];
  let windowStart = deps.now();
  let lastReport = deps.now();

  const flush = (t: number) => {
    if (paint.length >= MIN_KEYS_FOR_REPORT) {
      const summary = summarize(paint, queue);
      const slow = isSlowWindow(summary);
      if (slow || t - lastReport >= REPORT_QUIET_MS) {
        deps.report({ ...summary, client: deps.client, url: safePath(), reason: slow ? 'slow' : 'periodic' });
        lastReport = t;
      }
    }
    paint = [];
    queue = [];
    windowStart = t;
  };

  const onKeyDown = (e: Event) => {
    if (!isEditable(e.target)) return;
    const t0 = e.timeStamp;
    const handled = deps.now();
    // A timeStamp from a different clock (older engines) would produce garbage;
    // anything negative or over a minute is not a keystroke we can time.
    const q = handled - t0;
    if (!(q >= 0 && q < 60_000)) return;
    deps.raf(() => {
      const painted = deps.now();
      queue.push(q);
      paint.push(painted - t0);
      if (painted - windowStart >= WINDOW_MS) flush(painted);
    });
  };

  deps.target.addEventListener('keydown', onKeyDown, true);
  return () => deps.target.removeEventListener('keydown', onKeyDown, true);
}

function safePath(): string {
  try { return window.location.pathname; } catch { return ''; }
}
