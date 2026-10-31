/**
 * The layout record: what Home and Org show, kept on disk by the server.
 *
 * 2026-10-31, the user: "every time the Mac app restarts everything is gone ... these states
 * should be permanent, on disk". The session columns (which are open, which are locked, their
 * order), the focused task and the chat slot's ask lived in sessionStorage, and the Mac app's
 * web view drops sessionStorage on every relaunch and page-process recycle.
 *
 * Every field is one localStorage key under `open-walnut-layout:`, so ui-prefs-sync mirrors it
 * to WALNUT_HOME/config/share/ui-prefs.json and merges it back BEFORE the first render (the
 * components read these fields in useState initializers). localStorage is only the cache: a
 * browser that lost it adopts the server's copy at boot. Writes are debounced by the mirror and
 * flushed on pagehide. Two windows at once: the last writer wins, per field.
 *
 * Each value is versioned (`{ v: 1, value }`), so a later shape can read an older one. A tab
 * that still holds the pre-record sessionStorage key (it was open across the upgrade) adopts it
 * once; an older Walnut never reads these keys and keeps its own sessionStorage.
 *
 * What a restart (a relaunch, a reload, a deploy, a crash heal) brings back on Home and Org:
 *   restore:  the session columns and their locks (these fields), the Org side panels and their
 *             locks (these fields), the focused task as a highlighted row (this field and the
 *             URL's `?task=`), the chat slot's ask and agent (these fields), panel visibility,
 *             column widths and new-session drafts with words (their own mirrored keys), the
 *             panel count (server config), the Org page's place (this device, org-place.ts).
 *   never:    every passing overlay: the full-screen task detail (a load focuses the task
 *             without it; 2026-10-31, "every time walnut restarts it always shows some task in
 *             full screen"), a fullscreen session panel, the session finder, the chat slot's
 *             drawer, menus and popups. These start closed on every load.
 * tests/web/layout-state-on-disk-guard.test.ts holds both lists to the source.
 */

import { isPlaceholderColumnId } from './column-ids';

/** A column of a strip (the same shape as pages/sessionColumns.ts's LayoutSlot; utils/ never imports pages/). */
export interface LayoutSlot {
  id: string;
  locked: boolean;
}

export const LAYOUT_PREFIX = 'open-walnut-layout:';
export const LAYOUT_VERSION = 1;

/** Every field of the record. A new piece of Home or Org state that must survive a restart is a field here. */
export const LAYOUT_FIELDS = {
  /** The Home session columns on a desktop-width window: ids, locks, order. */
  homeColumns: `${LAYOUT_PREFIX}home-columns`,
  /** The same on a phone-width window (its own strip: one column shows at a time). */
  phoneColumns: `${LAYOUT_PREFIX}phone-columns`,
  /** The panels opened beside the Org page (`task:<id>` / `session:<id>`), locks and order. */
  orgColumns: `${LAYOUT_PREFIX}org-columns`,
  /** The task focused on Home. */
  homeFocusedTask: `${LAYOUT_PREFIX}home-focused-task`,
  /** Which ask the chat slot shows (a task id, or Main's pick). */
  askSelected: `${LAYOUT_PREFIX}ask-selected`,
  /** Which agent the chat slot's drawer is on. */
  askAgent: `${LAYOUT_PREFIX}ask-agent`,
} as const;

export type LayoutField = keyof typeof LAYOUT_FIELDS;

/** The column fields: their locked slots are what crash recovery keeps. */
export const COLUMN_FIELDS: readonly LayoutField[] = ['homeColumns', 'phoneColumns', 'orgColumns'];

/**
 * The sessionStorage key an older bundle kept the field in, adopted once by a tab open across
 * the upgrade. The two strips share one: the old bundle kept a single strip, and a page reads
 * only the strip of its own width.
 */
const LEGACY_SESSION_KEYS: Partial<Record<LayoutField, string>> = {
  homeColumns: 'open-walnut-home-session-columns',
  phoneColumns: 'open-walnut-home-session-columns',
  homeFocusedTask: 'open-walnut-home-focused-task',
  askSelected: 'walnut:ask-slot:selected',
  askAgent: 'walnut:ask-slot:agent',
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): Store | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function session(): Store | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

export function encodeField(value: unknown): string {
  return JSON.stringify({ v: LAYOUT_VERSION, value });
}

/** The stored value, or undefined when the key holds nothing this version can read. */
export function decodeField(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && 'v' in parsed && typeof (parsed as { v: unknown }).v === 'number') {
      return (parsed as { value?: unknown }).value;
    }
  } catch { /* not ours */ }
  return undefined;
}

/** A legacy sessionStorage value in the record's shape (the old keys held bare strings or a JSON array). */
function legacyValue(field: LayoutField, raw: string): unknown {
  if (COLUMN_FIELDS.includes(field)) {
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  }
  return raw;
}

/** The stores a read uses; tests pass their own, the page the window's. */
export interface LayoutStores { local?: Store | null; session?: Store | null }

/**
 * Read a field. A tab still holding the pre-record sessionStorage key moves it into the record
 * first: it is what that tab showed until the upgrade reloaded it.
 */
export function readLayoutField(field: LayoutField, stores: LayoutStores = {}): unknown {
  const ls = stores.local === undefined ? local() : stores.local;
  const ss = stores.session === undefined ? session() : stores.session;
  const legacyKey = LEGACY_SESSION_KEYS[field];
  if (legacyKey && ss) {
    let raw: string | null = null;
    try { raw = ss.getItem(legacyKey); } catch { /* storage off */ }
    if (raw !== null) {
      const value = legacyValue(field, raw);
      try { ss.removeItem(legacyKey); } catch { /* storage off */ }
      if (value !== undefined) {
        try { ls?.setItem(LAYOUT_FIELDS[field], encodeField(value)); } catch { /* quota */ }
        return value;
      }
    }
  }
  if (!ls) return undefined;
  try { return decodeField(ls.getItem(LAYOUT_FIELDS[field])); } catch { return undefined; }
}

/**
 * Write a field; `null`/`undefined` clears it. A clear is written as a cleared value, never a
 * removed key: the boot merge takes the server's copy whenever the key is MISSING here, so a
 * removal whose PUT had not landed yet (a quit within the mirror's 800 ms, a deploy, a crash
 * heal's reload) brought the closed column back. A key this browser never had stays missing.
 * Never throws (storage off: the page still works).
 */
export function writeLayoutField(field: LayoutField, value: unknown, store: Store | null = local()): void {
  if (!store) return;
  const key = LAYOUT_FIELDS[field];
  try {
    const current = store.getItem(key);
    if ((value === null || value === undefined) && current === null) return;
    const next = encodeField(value ?? null);
    if (current !== next) store.setItem(key, next);
  } catch { /* quota */ }
}

/** Slots from any stored shape: the record's, or the legacy string[] / {id, locked}[]. */
export function parseSlots(value: unknown): LayoutSlot[] {
  if (!Array.isArray(value)) return [];
  const out: LayoutSlot[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry) out.push({ id: entry, locked: false });
    else if (entry && typeof entry === 'object' && typeof (entry as LayoutSlot).id === 'string' && (entry as LayoutSlot).id) {
      out.push({ id: (entry as LayoutSlot).id, locked: !!(entry as LayoutSlot).locked });
    }
  }
  return out;
}

export function readColumns(field: LayoutField, stores: LayoutStores = {}): LayoutSlot[] {
  return parseSlots(readLayoutField(field, stores));
}

/** Persist a strip. Placeholders (`draft:`/`pending:`) resolve to nothing after a reload and are left out. */
export function writeColumns(field: LayoutField, cols: readonly LayoutSlot[], store: Store | null = local()): void {
  const persistable = cols.filter((s) => !isPlaceholderColumnId(s.id)).map((s) => ({ id: s.id, locked: s.locked }));
  writeLayoutField(field, persistable.length > 0 ? persistable : null, store);
}

export function readString(field: LayoutField, stores: LayoutStores = {}): string | null {
  const v = readLayoutField(field, stores);
  return typeof v === 'string' && v ? v : null;
}

/** Drop one column from a saved strip (a panel that crashed, closed before its host could persist). */
export function dropSavedColumn(field: LayoutField, id: string, store: Store | null = local()): void {
  const cols = readColumns(field, { local: store });
  if (cols.some((c) => c.id === id)) writeColumns(field, cols.filter((c) => c.id !== id), store);
}

/**
 * A strip writer for one window. It writes the window's strip, plus every pin another window
 * saved that this one does not show and never let go of: with two windows open (the Mac app
 * and a browser tab, two tabs), the one written last used to replace the other's pins. A pin
 * this window unlocked or closed is released, and stays released.
 */
export function createStripWriter(field: LayoutField): (cols: readonly LayoutSlot[], store?: Store | null) => void {
  let prevLocked = new Set<string>();
  const released = new Set<string>();
  return (cols, store = local()) => {
    const locked = new Set(cols.filter((c) => c.locked).map((c) => c.id));
    for (const id of prevLocked) if (!locked.has(id)) released.add(id);
    for (const id of locked) released.delete(id);
    prevLocked = locked;
    const shown = new Set(cols.map((c) => c.id));
    const kept = readColumns(field, { local: store, session: null })
      .filter((s) => s.locked && !shown.has(s.id) && !released.has(s.id));
    writeColumns(field, kept.length > 0 ? [...cols, ...kept] : cols, store);
  };
}

/**
 * The value a crash heal leaves a layout key: on the soft heal the locked slots of a column
 * field (a pin is the user's "keep this panel"), else a cleared value (written, never removed,
 * for the reason in writeLayoutField).
 */
export function healedLayoutValue(key: string, raw: string | null, keepPins: boolean): string {
  const field = (Object.keys(LAYOUT_FIELDS) as LayoutField[]).find((f) => LAYOUT_FIELDS[f] === key);
  const locked = keepPins && field && COLUMN_FIELDS.includes(field) ? parseSlots(decodeField(raw)).filter((s) => s.locked) : [];
  return encodeField(locked.length > 0 ? locked : null);
}

/**
 * Under browser automation (Playwright), the fixture server's record is shared by every spec,
 * so adopting it would hand one spec the columns another left open. A spec about the record
 * opts in with this localStorage key (never mirrored: it has no synced prefix).
 */
export const E2E_LAYOUT_OPT_IN = 'walnut-e2e-layout-record';

export function adoptsServerLayout(): boolean {
  try {
    if (typeof navigator === 'undefined' || !navigator.webdriver) return true;
    return local()?.getItem(E2E_LAYOUT_OPT_IN) === '1';
  } catch { return true; }
}
