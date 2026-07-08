/**
 * Per-document scroll memory for the markdown editor shell (Obsidian parity).
 *
 * Stores the scroll position as a 0..1 FRACTION of the scrollable range, not an
 * absolute scrollTop — a fraction is mode-agnostic, so the same memory restores
 * the rendered view, the raw (CodeMirror) view, and survives width-mode changes
 * where pixel offsets would drift.
 *
 * Keyed by the editor doc key (vault path / "notes/global" / task field id).
 * The in-memory Map covers route switches (home ↔ notes) within the SPA; the
 * debounced localStorage write-through covers a full refresh. Bounded by
 * last-used timestamp so the store never grows unbounded across a big vault.
 */

const LS_KEY = 'open-walnut-notes-scroll-v1';
const MAX_ENTRIES = 200;
const PERSIST_DEBOUNCE_MS = 400;

interface Entry {
  frac: number; // 0..1 of (scrollHeight - clientHeight)
  at: number;   // last-used epoch ms — prune key
}

let mem: Map<string, Entry> | null = null;

function load(): Map<string, Entry> {
  if (mem) return mem;
  mem = new Map();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, Entry>;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v.frac === 'number' && typeof v.at === 'number') mem.set(k, v);
      }
    }
  } catch { /* corrupted / disabled storage → start empty */ }
  return mem;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function persistSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const m = load();
    if (m.size > MAX_ENTRIES) {
      const newest = [...m.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
      mem = new Map(newest);
    }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(load())));
    } catch { /* quota / disabled — memory-only fallback still works */ }
  }, PERSIST_DEBOUNCE_MS);
}

export function rememberScrollFraction(key: string, frac: number): void {
  load().set(key, { frac: Math.max(0, Math.min(1, frac)), at: Date.now() });
  persistSoon();
}

/** Saved scroll fraction for a doc, or undefined if never scrolled/visited. */
export function recallScrollFraction(key: string): number | undefined {
  return load().get(key)?.frac;
}

/** scrollTop as a 0..1 fraction of the scrollable range (0 when nothing scrolls). */
export function scrollFraction(el: HTMLElement): number {
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? el.scrollTop / max : 0;
}

/** Apply a saved fraction to an element's scrollTop (no-op when nothing scrolls). */
export function applyScrollFraction(el: HTMLElement, frac: number): void {
  const max = el.scrollHeight - el.clientHeight;
  if (max > 0) el.scrollTop = frac * max;
}
