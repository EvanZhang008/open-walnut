/**
 * Stale-build recovery: the tab reloads when a chunk from a replaced build
 * fails, but never on top of text the user hasn't sent, and never in a loop.
 *
 * The bug this pins: a deploy wipes the hashed assets a live tab was built
 * against, so its next code-split import dies — and every such import has a
 * best-effort catch, so the user just sees a feature stop working (a .go file
 * rendering with no syntax colors) with nothing in any log.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordStaleReload, initStaleAssetRecovery, type StaleAssetDeps,
} from '../../web/src/utils/stale-assets';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

/** Minimal EventTarget stand-in — the node test tier has no DOM. */
class FakeTarget {
  listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, l: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: (e: Event) => void) {
    this.listeners.get(type)?.delete(l);
  }
  emit(type: string, payload?: unknown) {
    const e = { type, payload, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of this.listeners.get(type) ?? []) l(e as unknown as Event);
    return e;
  }
  count(type: string) { return this.listeners.get(type)?.size ?? 0; }
}

describe('stale-assets: reload rate limit', () => {
  let session: FakeStorage;
  let now: number;

  beforeEach(() => { session = new FakeStorage(); now = 1_000_000; });
  const deps = () => ({ session: session as unknown as Storage, now: () => now });

  it('allows three reloads, then gives up inside the window', () => {
    expect(recordStaleReload(deps())).toBe('reload');
    expect(recordStaleReload(deps())).toBe('reload');
    expect(recordStaleReload(deps())).toBe('reload');
    expect(recordStaleReload(deps())).toBe('give-up');
  });

  it('forgets old attempts, so the next deploy still heals', () => {
    for (let i = 0; i < 3; i++) recordStaleReload(deps());
    expect(recordStaleReload(deps())).toBe('give-up');
    now += 6 * 60_000;
    expect(recordStaleReload(deps())).toBe('reload');
  });

  it('survives a corrupt log', () => {
    session.setItem('open-walnut-stale-asset-reloads', '{not json');
    expect(recordStaleReload(deps())).toBe('reload');
  });
});

describe('stale-assets: initStaleAssetRecovery', () => {
  function harness(opts: { unsaved?: boolean } = {}) {
    const target = new FakeTarget();
    const session = new FakeStorage();
    let unsaved = opts.unsaved ?? false;
    let reloads = 0;
    let retryCheck: (() => void) | null = null;
    let retryCancelled = 0;
    const deps: Partial<StaleAssetDeps> = {
      session: session as unknown as Storage,
      now: () => 1_000_000,
      reload: () => { reloads++; },
      hasUnsaved: () => unsaved,
      target,
      retry: (check) => { retryCheck = check; return () => { retryCancelled++; retryCheck = null; }; },
    };
    const teardown = initStaleAssetRecovery(deps);
    return {
      target, teardown,
      fire: (msg = 'Failed to fetch dynamically imported module') => target.emit('vite:preloadError', new Error(msg)),
      reloads: () => reloads,
      setUnsaved: (v: boolean) => { unsaved = v; },
      runRetry: () => retryCheck?.(),
      hasRetry: () => retryCheck != null,
      retryCancelled: () => retryCancelled,
    };
  }

  it('reloads on a stale chunk when nothing is unsaved', () => {
    const h = harness();
    h.fire();
    expect(h.reloads()).toBe(1);
    h.teardown();
  });

  it('does not cancel the event — the failed import must still reject', () => {
    // Cancelling makes Vite RESOLVE the import with undefined, which turns a
    // caller's clean error path into a TypeError.
    const h = harness();
    const e = h.fire();
    expect(e.defaultPrevented).toBe(false);
    h.teardown();
  });

  it('defers while a message is half-typed, then heals at the next safe moment', () => {
    const h = harness({ unsaved: true });
    h.fire();
    expect(h.reloads()).toBe(0);
    expect(h.hasRetry()).toBe(true);

    h.runRetry();                 // still typing
    expect(h.reloads()).toBe(0);

    h.setUnsaved(false);          // draft sent / cleared
    h.runRetry();
    expect(h.reloads()).toBe(1);
    expect(h.retryCancelled()).toBe(1);
    h.teardown();
  });

  it('a deferred reload keeps ONE retry, not one per failed chunk', () => {
    const h = harness({ unsaved: true });
    h.fire();
    h.fire();
    h.fire();
    expect(h.reloads()).toBe(0);
    expect(h.retryCancelled()).toBe(0);
    h.setUnsaved(false);
    h.runRetry();
    expect(h.reloads()).toBe(1);
    h.teardown();
  });

  it('stops after the rate limit instead of spinning', () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.fire();
    expect(h.reloads()).toBe(3);
    h.teardown();
  });

  it('teardown detaches the listener and cancels a pending retry', () => {
    const h = harness({ unsaved: true });
    h.fire();
    expect(h.hasRetry()).toBe(true);
    h.teardown();
    expect(h.retryCancelled()).toBe(1);
    expect(h.target.count('vite:preloadError')).toBe(0);
    h.fire();
    expect(h.reloads()).toBe(0);
  });
});
