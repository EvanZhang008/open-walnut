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
import { parseHTML } from 'linkedom';
import {
  isUnsaved, readUnsavedSnapshot, recordStaleReload, initStaleAssetRecovery, type StaleAssetDeps,
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

describe('stale-assets: is a reload safe?', () => {
  const clean = { dirtyEditor: false, drafts: ['', '   '], focusedText: '' };

  it('a clean page is safe', () => {
    expect(isUnsaved(clean)).toBe(false);
  });

  it('a half-typed message defers the reload', () => {
    expect(isUnsaved({ ...clean, drafts: ['', 'half a thought'] })).toBe(true);
  });

  it('a dirty file editor defers the reload even with no text anywhere', () => {
    expect(isUnsaved({ ...clean, dirtyEditor: true, drafts: [] })).toBe(true);
  });

  it('the field being typed in right now defers the reload', () => {
    expect(isUnsaved({ ...clean, focusedText: 'infor' })).toBe(true);
  });

  it('an unfocused search box does NOT block forever', () => {
    // readUnsavedSnapshot reports only the FOCUSED single-line field, so a
    // filter left with text in it cannot wedge recovery.
    expect(isUnsaved({ dirtyEditor: false, drafts: [], focusedText: '' })).toBe(false);
  });

  it('an OPEN file is not unsaved work', () => {
    // Regression: the CodeMirror content div is contenteditable and holds the
    // whole file, so scanning contenteditables for text deferred the reload for
    // as long as any file was open. Dirtiness comes from the dirty dot instead.
    expect(isUnsaved({ dirtyEditor: false, drafts: [''], focusedText: '' })).toBe(false);
  });
});

describe('stale-assets: readUnsavedSnapshot (real DOM shapes)', () => {
  /** The Files panel as it actually renders: a CodeMirror editor holding a file. */
  const FILE_OPEN = `
    <div class="file-content-view">
      <div class="cm-editor"><div class="cm-content" contenteditable="true">package informers\nfunc F() {}</div></div>
    </div>
    <textarea class="composer"></textarea>`;

  function snap(html: string, activeSelector?: string) {
    const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
    const active = activeSelector ? document.querySelector(activeSelector) : null;
    return readUnsavedSnapshot(document as unknown as Document, active as unknown as Element | null);
  }

  it('an open file with an empty composer is safe to reload', () => {
    // THE regression: .cm-content is contenteditable and holds the whole file,
    // so a naive contenteditable scan called this "unsaved" and the tab never
    // healed (observed live: a JSON grammar 404ing with deferred:true forever).
    expect(isUnsaved(snap(FILE_OPEN))).toBe(false);
  });

  it('a focused code editor is still not unsaved work', () => {
    expect(isUnsaved(snap(FILE_OPEN, '.cm-content'))).toBe(false);
  });

  it('the dirty dot next to Save does count', () => {
    expect(isUnsaved(snap(`${FILE_OPEN}<span class="fv-dirty-dot">●</span>`))).toBe(true);
  });

  it('a composer draft counts even without focus', () => {
    const { document } = parseHTML('<!DOCTYPE html><html><body><textarea>half a thought</textarea></body></html>');
    expect(isUnsaved(readUnsavedSnapshot(document as unknown as Document, null))).toBe(true);
  });

  it('a task title being edited inline counts', () => {
    expect(isUnsaved(snap('<div class="todo-title" contenteditable="true">renaming this</div>', '.todo-title'))).toBe(true);
  });

  it('a search box with text but no focus does not', () => {
    expect(isUnsaved(snap('<input type="search" value="SetTransform">'))).toBe(false);
  });

  it('the search box being typed in right now does', () => {
    const { document } = parseHTML('<!DOCTYPE html><html><body><input id="q" type="search"></body></html>');
    const input = document.querySelector('#q')!;
    (input as unknown as HTMLInputElement).value = 'SetTrans';
    expect(isUnsaved(readUnsavedSnapshot(document as unknown as Document, input as unknown as Element))).toBe(true);
  });

  it('a checkbox is never unsaved typing', () => {
    expect(isUnsaved(snap('<input id="c" type="checkbox" value="on">', '#c'))).toBe(false);
  });
});

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
