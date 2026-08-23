/**
 * Human time tracking — a LEASE, not a stopwatch.
 *
 * Any real interaction signal (pointerdown, keydown, wheel/scroll, text
 * selection, voice recording start) attributes the context under the cursor and
 * grants/renews a 60s lease. The clock runs only while a lease is valid, so a
 * parked cursor earns nothing. Exactly ONE context earns at any moment:
 * last-signal-wins, and the losing context is banked up to the switch instant,
 * so switching never double-counts.
 *
 * The state machine (everything above `installTimeTracker`) is PURE and unit
 * tested. The installer is the only impure part: ONE document-level listener per
 * event type, module-level mutable state, and NEVER a setState — an event that
 * re-rendered the tree is the whale-session render-lag incident all over again.
 * Samples are batched and posted every 30s (skipped while the tab is hidden),
 * plus on the visibilitychange and pagehide edges.
 */

import { resolveAttribution, sameContext, type TimeContext, type TimeKind } from './time-attribution';
import { visibleInterval } from './page-visibility';
import { subscribeVoiceStatus } from './voice-status';
import { log } from './log';

// ── Pure state machine ──

/** A signal earns this much runway. One click = one minute of attention. */
export const LEASE_MS = 60_000;
/** Fragments shorter than this are noise (a fast context switch), not work. */
export const MIN_SAMPLE_MS = 250;
export const FLUSH_INTERVAL_MS = 30_000;
/** Cap on a single POST body; older samples are dropped first if it overflows. */
export const MAX_BATCH = 200;
/** Re-resolving the DOM on every wheel tick is waste; renew instead. */
const RESOLVE_THROTTLE_MS = 200;

export interface TimeSample {
  /** ISO timestamp of the START of the counted window. */
  ts: string;
  durationMs: number;
  kind: TimeKind;
  taskId?: string;
  sessionId?: string;
}

export interface LeaseState {
  ctx: TimeContext | null;
  /** Start of the not-yet-banked window. */
  startedAt: number;
  /** Most recent signal — the lease runs LEASE_MS past this. */
  lastSignalAt: number;
}

export const IDLE_LEASE: LeaseState = { ctx: null, startedAt: 0, lastSignalAt: 0 };

/** The instant the lease stops earning if no further signal arrives. */
export function leaseExpiryAt(state: LeaseState): number {
  return state.lastSignalAt + LEASE_MS;
}

function bank(state: LeaseState, endMs: number): TimeSample | undefined {
  if (!state.ctx) return undefined;
  const durationMs = Math.round(endMs - state.startedAt);
  if (durationMs < MIN_SAMPLE_MS) return undefined;
  return {
    ts: new Date(state.startedAt).toISOString(),
    durationMs,
    kind: state.ctx.kind,
    ...(state.ctx.taskId ? { taskId: state.ctx.taskId } : {}),
    ...(state.ctx.sessionId ? { sessionId: state.ctx.sessionId } : {}),
  };
}

function started(ctx: TimeContext, now: number): LeaseState {
  return { ctx, startedAt: now, lastSignalAt: now };
}

/** A signal arrived for `ctx`. Grants, renews, or switches the lease. */
export function applySignal(
  state: LeaseState, ctx: TimeContext, now: number,
): { state: LeaseState; sample?: TimeSample } {
  if (!state.ctx) return { state: started(ctx, now) };

  if (now > leaseExpiryAt(state)) {
    // The old lease had already run out — it earned up to its expiry, no further.
    const sample = bank(state, leaseExpiryAt(state));
    return { state: started(ctx, now), ...(sample ? { sample } : {}) };
  }
  if (!sameContext(state.ctx, ctx)) {
    // last-signal-wins. The user was demonstrably engaged with the old context
    // until this instant, so it earns up to NOW and the new one starts here.
    const sample = bank(state, now);
    return { state: started(ctx, now), ...(sample ? { sample } : {}) };
  }
  return { state: { ...state, lastSignalAt: now } };
}

/** Close a lease whose runway has run out. No-op while it is still valid. */
export function applyExpiry(state: LeaseState, now: number): { state: LeaseState; sample?: TimeSample } {
  if (!state.ctx || now <= leaseExpiryAt(state)) return { state };
  const sample = bank(state, leaseExpiryAt(state));
  return { state: { ...IDLE_LEASE }, ...(sample ? { sample } : {}) };
}

/** Bank the elapsed part of a STILL-VALID lease without opening a gap. */
export function sliceLease(state: LeaseState, now: number): { state: LeaseState; sample?: TimeSample } {
  if (!state.ctx || now > leaseExpiryAt(state)) return { state };
  const sample = bank(state, now);
  if (!sample) return { state };
  return { state: { ...state, startedAt: now }, sample };
}

/** What a flush boundary owes: expire if due, otherwise slice. */
export function flushLease(state: LeaseState, now: number): { state: LeaseState; samples: TimeSample[] } {
  const expired = applyExpiry(state, now);
  if (!expired.state.ctx) return { state: expired.state, samples: expired.sample ? [expired.sample] : [] };
  const sliced = sliceLease(expired.state, now);
  return { state: sliced.state, samples: sliced.sample ? [sliced.sample] : [] };
}

/** Stop earning entirely (tab hidden / page unloading). Caps at the expiry. */
export function closeLease(state: LeaseState, now: number): { state: LeaseState; samples: TimeSample[] } {
  if (!state.ctx) return { state, samples: [] };
  const sample = bank(state, Math.min(now, leaseExpiryAt(state)));
  return { state: { ...IDLE_LEASE }, samples: sample ? [sample] : [] };
}

/** Trim a batch to MAX_BATCH, dropping the OLDEST samples first. */
export function trimBatch(samples: TimeSample[]): TimeSample[] {
  return samples.length <= MAX_BATCH ? samples : samples.slice(samples.length - MAX_BATCH);
}

// ── Installer (impure) ──

export interface TrackerDeps {
  /** Current route — the fallback attribution for `/tasks/:id` page chrome. */
  getPathname: () => string;
  /** Injected in tests. Default posts to /api/time/heartbeats. */
  send?: (samples: TimeSample[], unloading: boolean) => void;
  now?: () => number;
}

// Deliberately NOT 'focusin': autofocus (a composer mounting, the sidebar
// trapping focus) fires it with no human involved, and a lease granted by the
// app to itself is exactly the over-count this model exists to avoid.
const SIGNAL_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;
const HEARTBEAT_PATH = '/api/time/heartbeats';

function defaultSend(samples: TimeSample[], unloading: boolean): void {
  const body = JSON.stringify({ samples });
  if (unloading) {
    try {
      if (navigator.sendBeacon(HEARTBEAT_PATH, new Blob([body], { type: 'application/json' }))) return;
    } catch { /* fall through to keepalive fetch */ }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    // Cloud mode requires the device token; on a trusted LAN none is stored.
    const token = localStorage.getItem('walnut.deviceToken');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch { /* storage unavailable */ }
  try {
    void fetch(HEARTBEAT_PATH, { method: 'POST', headers, body, keepalive: true })
      .catch(() => { /* server down — this window of time is lost, nothing to retry into */ });
  } catch { /* fetch unavailable */ }
}

let installed = false;

/**
 * Install the single set of document listeners. Idempotent; returns an
 * uninstaller. Safe to call from a React effect — it never touches state.
 */
export function installTimeTracker(deps: TrackerDeps): () => void {
  if (installed) return () => { /* another owner already installed it */ };
  installed = true;

  const clock = deps.now ?? (() => Date.now());
  const send = deps.send ?? defaultSend;

  let state: LeaseState = { ...IDLE_LEASE };
  let pending: TimeSample[] = [];
  let lastTarget: Element | null = null;
  let lastResolveAt = 0;

  const enqueue = (samples: TimeSample[]): void => {
    if (samples.length === 0) return;
    pending = trimBatch([...pending, ...samples]);
  };

  const post = (unloading: boolean): void => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      send(batch, unloading);
    } catch {
      // A send that throws synchronously must not stop the tracker.
    }
  };

  const onSignal = (target: Element | null): void => {
    const now = clock();
    if (target === lastTarget && now - lastResolveAt < RESOLVE_THROTTLE_MS) {
      // Same element within the throttle: renew without re-walking the DOM.
      if (state.ctx) state = { ...state, lastSignalAt: now };
      return;
    }
    lastTarget = target;
    lastResolveAt = now;
    const ctx = resolveAttribution(target, deps.getPathname());
    // Unattributable signal: neither extend nor switch. The expiry tick closes
    // the current lease on schedule, so nothing is billed to the wrong context.
    if (!ctx) return;
    const next = applySignal(state, ctx, now);
    state = next.state;
    if (next.sample) enqueue([next.sample]);
  };

  const handleEvent = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    onSignal(target);
  };

  const handleSelection = (): void => {
    try {
      const node = document.getSelection()?.anchorNode ?? null;
      if (!node) return;
      const el = node instanceof Element ? node : node.parentElement;
      onSignal(el);
    } catch { /* selection API unavailable */ }
  };

  for (const type of SIGNAL_EVENTS) {
    document.addEventListener(type, handleEvent, { capture: true, passive: true });
  }
  document.addEventListener('selectionchange', handleSelection, { passive: true });
  // Any surface can hand-fire a signal (voice, a future non-DOM interaction).
  document.addEventListener('walnut:time-signal', handleEvent, { capture: true, passive: true });

  // Voice recording start is a real interaction the DOM never reports.
  let wasTranscribing = false;
  const offVoice = subscribeVoiceStatus((status) => {
    if (status.transcribing && !wasTranscribing) onSignal(document.activeElement);
    wasTranscribing = status.transcribing;
  });

  const cancelInterval = visibleInterval(() => {
    const result = flushLease(state, clock());
    state = result.state;
    enqueue(result.samples);
    post(false);
  }, FLUSH_INTERVAL_MS);

  const handleVisibility = (): void => {
    if (document.visibilityState !== 'hidden') return;
    // A hidden tab earns nothing — close the lease and ship what it earned.
    const result = closeLease(state, clock());
    state = result.state;
    enqueue(result.samples);
    post(false);
  };
  const handlePageHide = (): void => {
    const result = closeLease(state, clock());
    state = result.state;
    enqueue(result.samples);
    post(true);
  };

  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('pagehide', handlePageHide);

  log.info('time-tracking', 'lease tracker installed', { leaseMs: LEASE_MS, flushMs: FLUSH_INTERVAL_MS });

  return () => {
    installed = false;
    for (const type of SIGNAL_EVENTS) {
      document.removeEventListener(type, handleEvent, { capture: true });
    }
    document.removeEventListener('selectionchange', handleSelection);
    document.removeEventListener('walnut:time-signal', handleEvent, { capture: true });
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('pagehide', handlePageHide);
    offVoice();
    cancelInterval();
    handlePageHide();
  };
}

/** Fire a signal for the current context from code (e.g. a non-DOM interaction). */
export function reportTimeSignal(target?: Element | null): void {
  try {
    (target ?? document.body)?.dispatchEvent(
      new CustomEvent('walnut:time-signal', { bubbles: true }),
    );
  } catch { /* no DOM */ }
}
