/**
 * An html-app island keeps its state and hands a result back
 * (web/src/components/chat/island-runtime.ts + island-store.ts).
 *
 * 2026-10-27: a 15-question quiz in a reply went back to question 1 halfway through,
 * because the island's frame was built again and a sandboxed frame has no storage of
 * its own. The runtime gives the page a `localStorage` seeded from what the parent
 * saved, and `walnut.report` to offer a result the user may send.
 *
 * The runtime is run here as the frame would run it (a fresh global, its own
 * `parent.postMessage`), so these cases grade the shipped script, not a copy of it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import vm from 'node:vm';
import {
  islandRuntimeScript, readResultMessage, readStateMessage, cleanResultText, isCommandLike,
  ISLAND_RESULT_MSG, ISLAND_STATE_MSG,
} from '../../web/src/components/chat/island-runtime';

interface Frame {
  run: (code: string) => unknown;
  posts: unknown[];
  fire: (type: string) => void;
}

function frame(key: string, seed: Record<string, string>): Frame {
  const posts: unknown[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const ctx: Record<string, unknown> = {
    setTimeout, clearTimeout,
    parent: { postMessage: (m: unknown) => { posts.push(JSON.parse(JSON.stringify(m))); } },
    addEventListener: (t: string, f: () => void) => { listeners.set(t, [...(listeners.get(t) ?? []), f]); },
    document: { visibilityState: 'visible', addEventListener: () => {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const html = islandRuntimeScript(key, seed);
  const body = /^<script>([\s\S]*)<\/script>$/.exec(html)?.[1];
  if (!body) throw new Error('runtime is not one script element');
  vm.runInContext(body, ctx);
  return {
    run: (code) => vm.runInContext(code, ctx),
    posts,
    fire: (t) => { for (const f of listeners.get(t) ?? []) f(); },
  };
}

const flushTimers = () => new Promise((r) => setTimeout(r, 200));

describe('island runtime', () => {
  it('a page reads its saved state on its first line', () => {
    const f = frame('k1', { q: '7', score: '5' });
    expect(f.run('localStorage.getItem("q")')).toBe('7');
    expect(f.run('localStorage.length')).toBe(2);
    expect(f.run('sessionStorage.getItem("score")')).toBe('5');
    expect(f.run('localStorage.getItem("missing")')).toBeNull();
  });

  it('writes reach the parent once, coalesced, with the whole store', async () => {
    const f = frame('k2', {});
    f.run('localStorage.setItem("q", 1); localStorage.setItem("q", 2); localStorage.setItem("picked", JSON.stringify(["B"]))');
    expect(f.posts).toHaveLength(0);
    await flushTimers();
    expect(f.posts).toEqual([{ t: ISLAND_STATE_MSG, k: 'k2', items: { q: '2', picked: '["B"]' } }]);
  });

  it('leaving the page flushes a pending write at once', () => {
    const f = frame('k3', {});
    f.run('localStorage.setItem("q", "4")');
    f.fire('pagehide');
    expect(f.posts).toEqual([{ t: ISLAND_STATE_MSG, k: 'k3', items: { q: '4' } }]);
  });

  it('property access works as on a real page, and clear() empties the store', async () => {
    const f = frame('k4', { a: '1' });
    expect(f.run('localStorage.a')).toBe('1');
    f.run('localStorage.b = 2; delete localStorage.a');
    await flushTimers();
    expect(f.posts.at(-1)).toEqual({ t: ISLAND_STATE_MSG, k: 'k4', items: { b: '2' } });
    expect(f.run('Object.keys(localStorage).join(",")')).toBe('b');
    f.run('localStorage.clear()');
    await flushTimers();
    expect(f.posts.at(-1)).toEqual({ t: ISLAND_STATE_MSG, k: 'k4', items: {} });
  });

  it('walnut.report posts a string as written and anything else as pretty JSON', () => {
    const f = frame('k5', {});
    f.run('walnut.report("Score 11/15")');
    f.run('walnut.report({ score: 11, wrong: [3] })');
    expect(f.posts).toEqual([
      { t: ISLAND_RESULT_MSG, k: 'k5', text: 'Score 11/15' },
      { t: ISLAND_RESULT_MSG, k: 'k5', text: '{\n  "score": 11,\n  "wrong": [\n    3\n  ]\n}' },
    ]);
  });

  it('a saved value cannot end the script element it is seeded into', () => {
    const evil = '</script><script>parent.postMessage("escaped","*")</script> ';
    const html = islandRuntimeScript('k6', { x: evil });
    expect(html.indexOf('</script>')).toBe(html.length - '</script>'.length);
    const f = frame('k6', { x: evil });
    expect(f.run('localStorage.getItem("x")')).toBe(evil);
    expect(f.posts).toHaveLength(0);
  });
});

describe('island messages', () => {
  it('only a well-formed message for this frame is taken', () => {
    expect(readStateMessage({ t: ISLAND_STATE_MSG, k: 'a', items: { q: '1', n: 2 } }, 'a')).toEqual({ q: '1' });
    expect(readStateMessage({ t: ISLAND_STATE_MSG, k: 'b', items: {} }, 'a')).toBeNull();
    expect(readStateMessage({ t: ISLAND_STATE_MSG, k: 'a', items: ['x'] }, 'a')).toBeNull();
    expect(readResultMessage({ t: ISLAND_RESULT_MSG, k: 'a', text: 'hi' }, 'a')).toBe('hi');
    expect(readResultMessage({ t: ISLAND_RESULT_MSG, k: 'a', text: 3 }, 'a')).toBeNull();
    expect(readResultMessage(null, 'a')).toBeNull();
  });

  it('a result keeps no invisible character, so what is read is what is sent', () => {
    // RIGHT-TO-LEFT OVERRIDE, a zero-width space and a BOM vanish; ZWJ inside an emoji stays.
    expect(cleanResultText('Score \u202E51/11\u200B\uFEFF')).toBe('Score 51/11');
    expect(cleanResultText('\u{1F469}\u200D\u{1F4BB}')).toBe('\u{1F469}\u200D\u{1F4BB}');
    expect(readResultMessage({ t: ISLAND_RESULT_MSG, k: 'a', text: 'a\u2066b' }, 'a')).toBe('ab');
  });

  it('a result that would run as a slash command is recognised', () => {
    expect(isCommandLike('/clear')).toBe(true);
    expect(isCommandLike('  /compact now')).toBe(true);
    expect(isCommandLike('Score 3/5')).toBe(false);
  });
});

describe('island store', () => {
  beforeEach(async () => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return m.size; },
      key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); },
      clear: () => m.clear(),
    });
    const store = await import('../../web/src/components/chat/island-store');
    store.resetIslandMemory();
  });

  it('names an island by its session, its message and its html, never by a React key', async () => {
    const { islandStoreKey } = await import('../../web/src/components/chat/island-store');
    expect(islandStoreKey('<b>quiz</b>', 's1')).toBe(islandStoreKey('<b>quiz</b>', 's1'));
    expect(islandStoreKey('<b>quiz</b>', 's1', 'msg-1')).toBe(islandStoreKey('<b>quiz</b>', 's1', 'msg-1'));
    // The same quiz asked for again in a new reply starts fresh.
    expect(islandStoreKey('<b>quiz</b>', 's1', 'msg-1')).not.toBe(islandStoreKey('<b>quiz</b>', 's1', 'msg-2'));
    expect(islandStoreKey('<b>quiz</b>', 's1')).not.toBe(islandStoreKey('<b>quiz</b>', 's2'));
    expect(islandStoreKey('<b>quiz</b>', 's1')).not.toBe(islandStoreKey('<b>quiz 2</b>', 's1'));
    expect(islandStoreKey('<b>quiz</b>', 's1').startsWith('draft:island:s1:')).toBe(true);
  });

  it('state survives a fresh window (a reload) through the draft store', async () => {
    const s = await import('../../web/src/components/chat/island-store');
    const key = s.islandStoreKey('<p>x</p>', 's1');
    expect(s.saveIslandItems(key, { q: '9' })).toBe(true);
    // Coalesced: readable at once, stored when flushed (timer, frame gone, page hidden).
    expect(s.readIsland(key).items).toEqual({ q: '9' });
    expect(localStorage.getItem(key)).toBeNull();
    s.flushIslands();
    s.resetIslandMemory();
    expect(s.readIsland(key).items).toEqual({ q: '9' });
    // A page that clears its storage leaves no draft behind.
    s.saveIslandItems(key, {});
    s.flushIslands();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('an island outside a session keeps its state for the window only', async () => {
    const s = await import('../../web/src/components/chat/island-store');
    const key = s.islandStoreKey('<p>x</p>', null);
    s.saveIslandItems(key, { q: '2' });
    expect(s.readIsland(key).items).toEqual({ q: '2' });
    expect(localStorage.length).toBe(0);
  });

  it('a store past the cap is refused and the old one kept', async () => {
    const s = await import('../../web/src/components/chat/island-store');
    const key = s.islandStoreKey('<p>x</p>', 's1');
    s.saveIslandItems(key, { q: '1' });
    expect(s.saveIslandItems(key, { big: 'x'.repeat(60 * 1024) })).toBe(false);
    expect(s.readIsland(key).items).toEqual({ q: '1' });
  });

  it('a result sent once is not offered again; a new result is', async () => {
    const s = await import('../../web/src/components/chat/island-store');
    const key = s.islandStoreKey('<p>quiz</p>', 's1');
    expect(s.offerIslandResult(key, 'Score 11/15')).toEqual({ text: 'Score 11/15', sent: false });
    s.markIslandResultSent(key, 'Score 11/15');
    s.resetIslandMemory();
    expect(s.offerIslandResult(key, 'Score 11/15')).toEqual({ text: 'Score 11/15', sent: true });
    expect(s.offerIslandResult(key, 'Score 15/15')).toEqual({ text: 'Score 15/15', sent: false });
    // Marking a text that is no longer the offer changes nothing.
    s.markIslandResultSent(key, 'Score 11/15');
    expect(s.readIsland(key).result).toEqual({ text: 'Score 15/15', sent: false });
    s.dismissIslandResult(key);
    expect(s.readIsland(key).result).toEqual({ text: 'Score 15/15', sent: false, dismissed: true });
    // Reported again on the next load: still dismissed. A new result shows again.
    expect(s.offerIslandResult(key, 'Score 15/15').dismissed).toBe(true);
    expect(s.offerIslandResult(key, 'Score 14/15')).toEqual({ text: 'Score 14/15', sent: false });
  });

  it('keeps at most MAX_ISLANDS islands, the least recently written going first', async () => {
    const s = await import('../../web/src/components/chat/island-store');
    vi.useFakeTimers();
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.MAX_ISLANDS + 5; i++) {
        vi.setSystemTime(1_000_000 + i * 1000);
        const key = s.islandStoreKey(`<p>${i}</p>`, 's1', 'm');
        keys.push(key);
        s.saveIslandItems(key, { i: String(i) });
        s.flushIslands();
      }
      const kept = keys.filter((k) => localStorage.getItem(k) !== null);
      expect(kept).toHaveLength(s.MAX_ISLANDS);
      expect(kept[0]).toBe(keys[5]);
      expect(localStorage.getItem(keys.at(-1)!)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
