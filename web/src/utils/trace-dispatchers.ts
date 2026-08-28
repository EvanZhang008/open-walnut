/**
 * Slow-callback attribution — names the code behind otherwise-anonymous
 * main-thread blocks.
 *
 * The phase registry in main-thread-tracer only names blocks inside code that
 * brackets itself. The 2026-08-23 investigation had a page blocked ~900ms every
 * ~3s for FIVE HOURS with zero attribution — the culprit ran from a timer/WS
 * callback nothing had bracketed. So wrap the dispatchers themselves
 * (setTimeout, setInterval, rAF, WebSocket onmessage, MessagePort onmessage —
 * the last one is how React's scheduler flushes render work): time every
 * callback, remember the slow ones, and let the block report carry their names.
 * Overhead is two performance.now() calls per callback — noise next to any
 * callback worth reporting.
 *
 * ⚠️ Import-order sensitive: this module must be imported BEFORE react-dom
 * (main.tsx line 1) — React creates its scheduler MessageChannel at module-init
 * time, so a later patch misses it.
 */

const SLOW_CB_THRESHOLD_MS = 100;
const SLOW_CB_BUFFER = 8;

interface SlowCallback { name: string; dur: number; endedAt: number }

const recentSlowCallbacks: SlowCallback[] = [];

/** Slow callbacks that ENDED at/after the given performance.now() timestamp. */
export function slowCallbacksSince(t: number): string[] {
  return recentSlowCallbacks
    .filter((c) => c.endedAt >= t)
    .map((c) => `${c.name} (${c.dur}ms)`);
}

function describeFn(fn: unknown, kind: string): string {
  let name = '';
  try {
    const f = fn as { name?: string };
    name = f.name && f.name.length > 2 ? f.name : String(fn).replace(/\s+/g, ' ').slice(0, 70);
  } catch { name = '(unprintable)'; }
  return `${kind} ${name}`;
}

function wrapCallback<T extends (...args: never[]) => unknown>(cb: T, kind: string): T {
  const wrapped = function (this: unknown, ...args: never[]): unknown {
    const t0 = performance.now();
    try {
      return cb.apply(this, args);
    } finally {
      const dur = performance.now() - t0;
      if (dur >= SLOW_CB_THRESHOLD_MS) {
        recentSlowCallbacks.push({ name: describeFn(cb, kind), dur: Math.round(dur), endedAt: performance.now() });
        if (recentSlowCallbacks.length > SLOW_CB_BUFFER) recentSlowCallbacks.shift();
      }
    }
  };
  return wrapped as unknown as T;
}

let installed = false;

export function installCallbackTracing(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  try {
    const origSetTimeout = window.setTimeout.bind(window);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).setTimeout = (cb: unknown, delay?: number, ...args: unknown[]) =>
      typeof cb === 'function'
        ? origSetTimeout(wrapCallback(cb as () => void, `timeout(${delay ?? 0})`), delay, ...(args as []))
        : origSetTimeout(cb as TimerHandler, delay);
    const origSetInterval = window.setInterval.bind(window);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).setInterval = (cb: unknown, delay?: number, ...args: unknown[]) =>
      typeof cb === 'function'
        ? origSetInterval(wrapCallback(cb as () => void, `interval(${delay ?? 0})`), delay, ...(args as []))
        : origSetInterval(cb as TimerHandler, delay);
    const origRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => origRaf(wrapCallback(cb, 'raf'));
    // React's scheduler flushes render work through a MessageChannel — without
    // this, a 900ms render pass triggered from a WS delta shows up as nothing.
    const portDesc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    if (portDesc?.set && portDesc.get) {
      Object.defineProperty(MessagePort.prototype, 'onmessage', {
        configurable: true,
        get() { return portDesc.get!.call(this); },
        set(fn: unknown) {
          portDesc.set!.call(this, typeof fn === 'function' ? wrapCallback(fn as () => void, 'port:onmessage') : fn);
        },
      });
    }
    // WS deltas are the highest-volume silent entry point (per-message handlers
    // never bracket themselves). Cover both wiring styles.
    const onmessageDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    if (onmessageDesc?.set && onmessageDesc.get) {
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        configurable: true,
        get() { return onmessageDesc.get!.call(this); },
        set(fn: unknown) {
          onmessageDesc.set!.call(this, typeof fn === 'function' ? wrapCallback(fn as () => void, 'ws:onmessage') : fn);
        },
      });
    }
    // One wrapper per original listener, reused across calls. A fresh wrapper
    // per addEventListener would (a) defeat the platform's same-listener dedup
    // (double delivery on a repeated add) and (b) make removeEventListener a
    // silent no-op (the caller passes the ORIGINAL, which was never registered)
    // — a listener leak on every WS reconnect.
    const wsListenerWrappers = new WeakMap<object, EventListener>();
    const origAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function (this: WebSocket, type: string, listener: unknown, opts?: unknown) {
      let wrapped = listener;
      if (type === 'message' && typeof listener === 'function') {
        const existing = wsListenerWrappers.get(listener as object);
        if (existing) {
          wrapped = existing;
        } else {
          wrapped = wrapCallback(listener as () => void, 'ws:onmessage');
          wsListenerWrappers.set(listener as object, wrapped as EventListener);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origAddEventListener as any).call(this, type, wrapped, opts);
    } as typeof WebSocket.prototype.addEventListener;
    const origRemoveEventListener = WebSocket.prototype.removeEventListener;
    WebSocket.prototype.removeEventListener = function (this: WebSocket, type: string, listener: unknown, opts?: unknown) {
      const wrapped = type === 'message' && typeof listener === 'function'
        ? wsListenerWrappers.get(listener as object) ?? listener
        : listener;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (origRemoveEventListener as any).call(this, type, wrapped, opts);
    } as typeof WebSocket.prototype.removeEventListener;
  } catch { /* attribution is best-effort — never break the app for it */ }
}

// Self-install at import time — this module is imported first in main.tsx
// precisely so the patches land before react-dom's module init.
installCallbackTracing();
