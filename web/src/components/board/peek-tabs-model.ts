/**
 * The tabs of a session panel's chat column: the panel's own chat first, then one
 * tab per task opened beside it (a Board chip, or a task clicked in the chat while
 * the panel is full screen). Like a browser's tabs: opening a task that already has
 * a tab switches to it, closing the active tab moves to its right-hand neighbour
 * (else the left one, else the own chat), and the set is remembered per panel task
 * in this browser, so leaving the Board, the full screen or the page and coming
 * back shows the same tabs on the same one.
 *
 * Pure: unit-pinned in tests/web/peek-tabs-model.test.ts.
 */

export interface PeekTabs {
  /** Task ids, in tab order. The own chat is not in the list: it is always first. */
  tabs: string[];
  /** The tab on screen; null = the panel's own chat. */
  active: string | null;
}

export const NO_PEEK_TABS: PeekTabs = { tabs: [], active: null };

/** A stored set is cut to this many tabs (the newest kept): a sanity bound, not a design limit. */
export const PEEK_TABS_STORED_MAX = 100;
const ID_MAX = 128;

/** Open `id` (the own task opens the own chat): a known tab is switched to, a new one goes last. */
export function openPeekTab(s: PeekTabs, id: string, ownTaskId?: string): PeekTabs {
  if (!id || id === ownTaskId) return activatePeekTab(s, null);
  if (s.tabs.includes(id)) return s.active === id ? s : { ...s, active: id };
  return { tabs: [...s.tabs, id], active: id };
}

/** Switch tabs; an id with no tab is ignored. */
export function activatePeekTab(s: PeekTabs, id: string | null): PeekTabs {
  if (id !== null && !s.tabs.includes(id)) return s;
  return s.active === id ? s : { ...s, active: id };
}

/** Close one tab. The active one hands over to its right-hand neighbour, else the left, else the own chat. */
export function closePeekTab(s: PeekTabs, id: string): PeekTabs {
  const at = s.tabs.indexOf(id);
  if (at < 0) return s;
  const tabs = s.tabs.filter((t) => t !== id);
  if (s.active !== id) return { tabs, active: s.active };
  return { tabs, active: tabs[at] ?? tabs[at - 1] ?? null };
}

/** Keep `id` (and the own chat), close the rest; `id` becomes active. */
export function closeOtherPeekTabs(s: PeekTabs, id: string): PeekTabs {
  if (!s.tabs.includes(id)) return s;
  return { tabs: [id], active: id };
}

export function closeAllPeekTabs(): PeekTabs {
  return NO_PEEK_TABS;
}

/** The tab `delta` places from the active one, the own chat included, wrapping at the ends. */
export function stepPeekTab(s: PeekTabs, delta: number): string | null {
  const order: Array<string | null> = [null, ...s.tabs];
  const at = Math.max(0, order.indexOf(s.active));
  const n = order.length;
  return order[(((at + delta) % n) + n) % n] ?? null;
}

// ── Storage (per panel task, local to this browser; not a synced ui-pref) ──

export const PEEK_TABS_PREFIX = 'walnut:peek-tabs.v1:';

/** The panel's task, else its session: the tabs belong to the work, not to one column. */
export function peekTabsKey(ownTaskId: string | undefined, sessionId: string): string {
  return ownTaskId ? `task:${ownTaskId}` : sessionId ? `session:${sessionId}` : '';
}

export function parsePeekTabs(raw: string | null | undefined): PeekTabs {
  if (!raw) return NO_PEEK_TABS;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return NO_PEEK_TABS; }
  if (!v || typeof v !== 'object') return NO_PEEK_TABS;
  const o = v as { tabs?: unknown; active?: unknown };
  const seen = new Set<string>();
  const tabs = (Array.isArray(o.tabs) ? o.tabs : [])
    .filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= ID_MAX)
    .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
    .slice(-PEEK_TABS_STORED_MAX);
  const active = typeof o.active === 'string' && tabs.includes(o.active) ? o.active : null;
  return { tabs, active };
}

type ReadStore = Pick<Storage, 'getItem'>;
type WriteStore = Pick<Storage, 'setItem' | 'removeItem'>;

export function readPeekTabs(storage: ReadStore | null | undefined, key: string): PeekTabs {
  if (!storage || !key) return NO_PEEK_TABS;
  try { return parsePeekTabs(storage.getItem(PEEK_TABS_PREFIX + key)); } catch { return NO_PEEK_TABS; }
}

export function writePeekTabs(storage: WriteStore | null | undefined, key: string, s: PeekTabs): void {
  if (!storage || !key) return;
  try {
    if (!s.tabs.length) storage.removeItem(PEEK_TABS_PREFIX + key);
    else storage.setItem(PEEK_TABS_PREFIX + key, JSON.stringify({ tabs: s.tabs.slice(-PEEK_TABS_STORED_MAX), active: s.active }));
  } catch { /* storage full or blocked: the tabs last this page */ }
}
