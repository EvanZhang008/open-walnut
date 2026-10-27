/**
 * A new-session draft column survives a reload and an app restart while its
 * composer holds words (2026-10-27, the user: "all the input boxes must save
 * permanently"). Before, every Home load swept `draft:new-session:*`, because a
 * draft's id is minted per page load and nothing could reach the old key again.
 *
 * Now each Home draft column's row (folder, host, project, model, task fields)
 * is kept beside its composer text under `draft:new-session-col:<id>`. At load a
 * column whose composer still has words comes back in its slot; one without
 * words is forgotten, row and key. A drawer's draft (`ask-object:…` ids, keyed by
 * the object it asks about) is reachable again by opening that object, so it is
 * never swept here.
 */
import { isDraftColumnId } from '@/utils/column-ids';
import type { DraftColumn } from './draft-column';
import { draftComposerKey } from './draft-column';

const COL_PREFIX = 'draft:new-session-col:';
const TEXT_PREFIX = draftComposerKey('');

export function draftColumnKey(id: string): string {
  return COL_PREFIX + id;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** JSON-safe: the AI-field set as an array, the picker nonce dropped (a signal, not state). */
export function serializeDraftColumn(d: DraftColumn): string {
  const { aiFields, openPickerNonce: _nonce, ...rest } = d;
  return JSON.stringify({ ...rest, ...(aiFields?.size ? { aiFields: [...aiFields] } : {}) });
}

export function parseDraftColumn(id: string, raw: string | null): DraftColumn | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || v.id !== id || typeof v.cwd !== 'string') return null;
    if (v.host !== null && typeof v.host !== 'string') return null;
    if (!v.meta || typeof v.meta !== 'object') return null;
    const aiFields = Array.isArray(v.aiFields) ? new Set(v.aiFields.filter((f) => typeof f === 'string')) : undefined;
    return { ...(v as unknown as DraftColumn), ...(aiFields ? { aiFields: aiFields as DraftColumn['aiFields'] } : {}) };
  } catch { return null; }
}

/**
 * The Home draft columns to bring back, oldest first, and the sweep of the ones
 * that hold no words. `fresh(id)` builds a row for words whose row was never
 * kept (an older build wrote only the text).
 */
export function restoreDraftColumns(fresh: (id: string) => DraftColumn, store: Store | undefined = safeLocalStorage(), now = Date.now()): DraftColumn[] {
  if (!store) return [];
  const textIds: string[] = [];
  const colIds: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k) continue;
      if (k.startsWith(COL_PREFIX)) colIds.push(k.slice(COL_PREFIX.length));
      else if (k.startsWith(TEXT_PREFIX)) textIds.push(k.slice(TEXT_PREFIX.length));
    }
  } catch { return []; }
  const out: DraftColumn[] = [];
  for (const id of new Set([...textIds, ...colIds])) {
    if (!isDraftColumnId(id)) continue;
    const text = store.getItem(draftComposerKey(id)) ?? '';
    if (!text.trim()) {
      // A row with no words may be another open window's column, still being
      // filled in: it is not brought back here, and goes only once it is a day old.
      if (now - openedAt(id) > ROW_KEEP_MS) {
        try { store.removeItem(draftColumnKey(id)); if (text) store.removeItem(draftComposerKey(id)); } catch { /* storage off */ }
      }
      continue;
    }
    out.push(parseDraftColumn(id, store.getItem(draftColumnKey(id))) ?? fresh(id));
  }
  // Ids are `draft:<ms>-<seq>`: oldest first, as the person opened them.
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Keep every live column's row; forget the rows of columns that are gone. */
export function saveDraftColumns(drafts: readonly DraftColumn[], kept: Set<string>, store: Store | undefined = safeLocalStorage()): void {
  if (!store) return;
  const live = new Set<string>();
  for (const d of drafts) {
    if (!isDraftColumnId(d.id)) continue;
    live.add(d.id);
    const text = serializeDraftColumn(d);
    try { if (store.getItem(draftColumnKey(d.id)) !== text) store.setItem(draftColumnKey(d.id), text); } catch { /* quota */ }
  }
  for (const id of kept) {
    if (live.has(id)) continue;
    try { store.removeItem(draftColumnKey(id)); } catch { /* storage off */ }
  }
  kept.clear();
  for (const id of live) kept.add(id);
}

const ROW_KEEP_MS = 24 * 3600_000;

/** When the column was opened: ids are `draft:<ms>-<seq>` (0 when unreadable, so it is swept). */
function openedAt(id: string): number {
  const ms = Number(/^draft:(\d+)-/.exec(id)?.[1]);
  return Number.isFinite(ms) ? ms : 0;
}

function safeLocalStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
