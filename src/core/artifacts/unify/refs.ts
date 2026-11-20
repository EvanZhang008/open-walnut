/**
 * What names a note by its path, carried along when the notes move into one tree (or back):
 * the Notes index and its attachment text rows, the search index's note docs (absolute paths),
 * the bookmarks (config favorites.notes), each replica's notes_exclude, the search's left-out
 * folders (search.excluded_folders), and each project's
 * tracking note. Re-pointed, never re-read: a doc keeps its id, so its vectors stay.
 *
 * Paths a user typed elsewhere (a task's description, a message) are not rewritten: an old
 * vault path still opens through the map (note-path-moves.ts).
 */
import path from 'node:path';
import { log } from '../../../logging/index.js';
import { modifyConfigDoc } from '../../config-store.js';
import { renameIndexedPaths } from '../../notes-index.js';

export interface RefsReport { index: { notes: number; attachments: number }; search: number; config: number; tracking: number }

/** The settings lists that name notes, by key: favorites, host:<name> (its notes_exclude), cloud_bridge, search (excluded_folders). */
export type ConfigLists = Record<string, string[]>;

/**
 * One way of the move: each old vault-relative path to its new one, the two roots, how any other
 * path finds its new place (`remap`, for the tracking notes), and the settings lists' new values
 * from their values now (`config`). Both are asked again on a resumed boot.
 */
export interface RefMove {
  pairs: ReadonlyArray<readonly [string, string]>; fromRoot: string; toRoot: string
  remap: (rel: string) => string; config: (now: ConfigLists) => ConfigLists
}

async function rewriteSearch(move: RefMove): Promise<number> {
  const { searchV2IndexPath } = await import('../../search/wiring.js');
  const { openSearchDb } = await import('../../../lib/hybrid-search/db.js');
  const opened = openSearchDb({ dbPath: searchV2IndexPath() } as Parameters<typeof openSearchDb>[0]);
  type Stmt = { run(...a: unknown[]): { changes: number }; all(...a: unknown[]): Array<{ id: number; ref: string }> };
  const db = opened.db as unknown as { prepare(sql: string): Stmt; transaction(fn: () => void): () => void; close(): void };
  try {
    // One pass over the docs under the old root, then each by its id (the table's own key): a
    // lookup by ref alone has no index (UNIQUE(kind, ref)), and one per moved file scanned the
    // whole table each time (2026-11-20: 110 s with the server's thread held).
    const want = new Map(move.pairs.map(([from, to]) => [path.join(move.fromRoot, from), path.join(move.toRoot, to)]));
    const prefix = move.fromRoot.endsWith(path.sep) ? move.fromRoot : move.fromRoot + path.sep;
    const rows = db.prepare("SELECT id, ref FROM doc WHERE substr(ref, 1, ?) = ?").all(prefix.length, prefix).filter((r) => want.has(r.ref));
    const up = db.prepare('UPDATE OR IGNORE doc SET ref=? WHERE id=?');
    let n = 0;
    // In batches, the event loop let through between them: a move of every note is tens of thousands.
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      db.transaction(() => { for (const r of batch) n += up.run(want.get(r.ref), r.id).changes; })();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return n;
  } finally {
    db.close();
  }
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : null);

type Doc = Record<string, unknown>;
const hostsOf = (doc: Doc): Record<string, { keep?: { notes_exclude?: unknown } }> =>
  (doc.hosts && typeof doc.hosts === 'object' ? doc.hosts : {}) as Record<string, { keep?: { notes_exclude?: unknown } }>;

function listsOf(doc: Doc): ConfigLists {
  const out: ConfigLists = {};
  const fav = strings((doc.favorites as { notes?: unknown } | undefined)?.notes); if (fav) out.favorites = fav;
  for (const [name, h] of Object.entries(hostsOf(doc))) { const ex = strings(h?.keep?.notes_exclude); if (ex) out[`host:${name}`] = ex; }
  const cb = strings((doc.cloud_bridge as { keep?: { notes_exclude?: unknown } } | undefined)?.keep?.notes_exclude); if (cb) out.cloud_bridge = cb;
  const se = strings((doc.search as { excluded_folders?: unknown } | undefined)?.excluded_folders); if (se) out.search = se;
  return out;
}

function putLists(doc: Doc, lists: ConfigLists): void {
  for (const [key, list] of Object.entries(lists)) {
    if (key === 'favorites') (doc.favorites as { notes?: unknown }).notes = list;
    else if (key === 'cloud_bridge') ((doc.cloud_bridge as { keep: { notes_exclude?: unknown } }).keep).notes_exclude = list;
    else if (key === 'search') (doc.search as { excluded_folders?: unknown }).excluded_folders = list;
    else if (key.startsWith('host:')) { const h = hostsOf(doc)[key.slice(5)]; if (h?.keep) h.keep.notes_exclude = list; }
  }
}

/** The settings lists as they are now. */
export async function readConfigLists(): Promise<ConfigLists> {
  return modifyConfigDoc((doc) => ({ write: false, result: listsOf(doc as Doc) }));
}

/** Bookmarks, what each replica leaves out, what search leaves out: each list as the move says. */
async function rewriteConfig(move: RefMove): Promise<number> {
  return modifyConfigDoc((doc) => {
    const now = listsOf(doc as Doc);
    const next = move.config(now);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(now[k]));
    if (changed.length) putLists(doc as Doc, Object.fromEntries(changed.map((k) => [k, next[k]!])));
    return { write: changed.length > 0, result: changed.length };
  });
}

async function rewriteTracking(remap: (rel: string) => string): Promise<number> {
  const { getStoreProjects, setProjectMetadata } = await import('../../task-manager.js');
  let n = 0;
  for (const [name, rec] of Object.entries(await getStoreProjects())) {
    const note = (rec as { metadata?: { tracking_note?: unknown } }).metadata?.tracking_note;
    if (typeof note !== 'string' || !note) continue;
    const next = remap(note);
    if (next !== note) { await setProjectMetadata(name, { tracking_note: next }); n++; }
  }
  return n;
}

/** Re-point every path-keyed record of the move. Each part on its own: one that fails is logged, the rest still run. */
export async function rewriteNoteRefs(move: RefMove): Promise<RefsReport> {
  const report: RefsReport = { index: { notes: 0, attachments: 0 }, search: 0, config: 0, tracking: 0 };
  const step = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try { await run(); } catch (err) { log.memory.warn(`one tree: ${name} not re-pointed`, { error: err instanceof Error ? err.message : String(err) }); }
  };
  await step('the Notes index', () => { report.index = renameIndexedPaths(move.pairs); });
  await step('the search index', async () => { report.search = await rewriteSearch(move); });
  await step('the bookmarks and left-out folders', async () => { report.config = await rewriteConfig(move); });
  await step('the projects\' tracking notes', async () => { report.tracking = await rewriteTracking(move.remap); });
  return report;
}
