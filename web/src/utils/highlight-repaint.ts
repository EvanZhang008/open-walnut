/**
 * WebKit (Safari, the Mac app's window) does not repaint the words of a Highlight
 * that is taken out of the registry, or replaced by another one under the same
 * name: they stay painted on screen until something else repaints them. Measured
 * 2026-11-02 in macOS WebKit 26: a doc comment's paint stayed on its words after
 * Esc gave the draft up, while the registry already held nothing (a screenshot,
 * which renders afresh, showed them clean; the screen did not). Emptying the old
 * Highlight first repaints them, so every registry Walnut paints in (the app's,
 * at boot; a preview frame's, when it is first painted in) is patched once here and
 * no call site has to remember it. tests/web/highlight-repaint-guard.test.ts lists
 * every file that paints and the registry it paints in.
 *
 * The same patch keeps words under `visibility: hidden` out of the registry,
 * because WebKit paints them onto the next words it renders (highlight-visibility.ts).
 */

import { registerVisibilityRefresher, sameRanges, visibleHighlight } from './highlight-visibility';

const PATCHED = Symbol.for('walnut.highlightRepaint');

interface RegistryLike {
  get?(name: string): unknown;
  set(name: string, value: unknown): unknown;
  delete(name: string): boolean;
  clear?(): void;
  keys?(): IterableIterator<string>;
}

function rangesOf(highlight: unknown): unknown[] | null {
  const h = highlight as { forEach?: (cb: (r: unknown) => void) => void } | null;
  if (typeof h?.forEach !== 'function') return null;
  const out: unknown[] = [];
  h.forEach((r) => out.push(r));
  return out;
}

function restore(highlight: unknown, ranges: unknown[]): void {
  const h = highlight as { add?: (r: unknown) => void };
  if (typeof h.add === 'function') for (const r of ranges) h.add(r);
}

function empty(highlight: unknown): void {
  const h = highlight as { clear?: () => void } | null | undefined;
  if (typeof h?.clear !== 'function') return;
  try { h.clear(); } catch { /* not a Highlight */ }
}

/**
 * Patch a registry's methods (on its prototype by default: WebKit hands out a new
 * wrapper for `CSS.highlights` when no script holds it, which drops a patch on the
 * instance) so a Highlight leaving it is emptied first. Idempotent per target.
 */
export function keepHighlightRepaints(
  registry: RegistryLike | null | undefined,
  target: object | null = registry ? Object.getPrototypeOf(registry) as object : null,
): void {
  if (!registry || !target) return;
  // Never a shared built-in (a test's Map stands in for the registry): emptying the
  // values of every Map in the page is not this patch's business.
  if (target === Map.prototype || target === Object.prototype) return;
  const t = target as RegistryLike & { [PATCHED]?: true };
  if (t[PATCHED]) return;
  const get = t.get;
  const set = t.set;
  const del = t.delete;
  const clear = t.clear;
  if (typeof set !== 'function' || typeof del !== 'function' || typeof get !== 'function') return;
  // What each painter set, by name: `get` answers it (painters compare by
  // identity), while the registry may hold a copy without the ranges whose
  // words `visibility: hidden` hides (highlight-visibility.ts).
  const own = new Map<string, unknown>();
  let owner: RegistryLike | null = registry;
  const dropBoth = (self: RegistryLike, name: string) => {
    const held = get.call(self, name);
    const mine = own.get(name);
    if (held) empty(held);
    if (mine && mine !== held) empty(mine);
  };
  t.get = function (this: RegistryLike, name: string) {
    return own.has(name) ? own.get(name) : get.call(this, name);
  };
  t.set = function (this: RegistryLike, name: string, value: unknown) {
    owner = this;
    const shown = visibleHighlight(value);
    const held = get.call(this, name);
    const mine = own.get(name);
    if (held && held !== shown && held !== value) empty(held);
    if (mine && mine !== value && mine !== held) empty(mine);
    own.set(name, value);
    return set.call(this, name, shown);
  };
  t.delete = function (this: RegistryLike, name: string) {
    dropBoth(this, name);
    own.delete(name);
    return del.call(this, name);
  };
  if (typeof clear === 'function') {
    t.clear = function (this: RegistryLike) {
      for (const name of [...(this.keys?.() ?? [])]) dropBoth(this, name);
      own.clear();
      return clear.call(this);
    };
  }
  // A surface hidden or shown again: register each name's ranges as they are now.
  registerVisibilityRefresher(t, () => {
    const self = owner;
    if (!self) return;
    for (const [name, value] of own) {
      const held = get.call(self, name);
      const shown = visibleHighlight(value);
      if (sameRanges(held, shown)) continue;
      // Empty what is painted so WebKit repaints those words; the painter's own
      // Highlight gets its ranges back once it is no longer the registered one.
      const back = held === value ? rangesOf(value) : null;
      if (held) empty(held);
      set.call(self, name, shown);
      if (back) restore(value, back);
    }
  });
  t[PATCHED] = true;
}

/** The same for a window's registry (the app's, or a same-origin frame's). */
export function keepWindowHighlightRepaints(win: Window | null | undefined): void {
  keepHighlightRepaints((win as unknown as { CSS?: { highlights?: RegistryLike } } | null | undefined)?.CSS?.highlights);
}
