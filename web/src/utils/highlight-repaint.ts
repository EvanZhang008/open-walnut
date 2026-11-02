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
 */

const PATCHED = Symbol.for('walnut.highlightRepaint');

interface RegistryLike {
  get?(name: string): unknown;
  set(name: string, value: unknown): unknown;
  delete(name: string): boolean;
  clear?(): void;
  keys?(): IterableIterator<string>;
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
  const set = t.set;
  const del = t.delete;
  const clear = t.clear;
  if (typeof set !== 'function' || typeof del !== 'function') return;
  t.set = function (this: RegistryLike, name: string, value: unknown) {
    const old = this.get?.(name);
    if (old && old !== value) empty(old);
    return set.call(this, name, value);
  };
  t.delete = function (this: RegistryLike, name: string) {
    empty(this.get?.(name));
    return del.call(this, name);
  };
  if (typeof clear === 'function') {
    t.clear = function (this: RegistryLike) {
      for (const name of this.keys?.() ?? []) empty(this.get?.(name));
      return clear.call(this);
    };
  }
  t[PATCHED] = true;
}

/** The same for a window's registry (the app's, or a same-origin frame's). */
export function keepWindowHighlightRepaints(win: Window | null | undefined): void {
  keepHighlightRepaints((win as unknown as { CSS?: { highlights?: RegistryLike } } | null | undefined)?.CSS?.highlights);
}
