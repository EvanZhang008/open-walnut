/**
 * Per-file "Viewed" marks of the Changed tab (React-free, unit-tested).
 *
 * A mark records WHICH version of a file's change the reader ticked off: a
 * signature of the change, taken when the box was ticked. When the file's
 * change differs later (the agent edited it again, the working tree moved),
 * the signature no longer matches and the file reads as "Changed since
 * viewed" instead of Viewed, until it is ticked again.
 *
 * Marks belong to one comparison of one session ("What this session changed",
 * "Branch vs origin/main", one commit ...): each comparison shows a different
 * change of the same file, so a tick in one says nothing about another.
 *
 * Storage: localStorage, one key per session, under a prefix the ui-prefs
 * mirror does NOT sync (utils/ui-prefs-sync.ts syncs open-walnut-*): the marks
 * are keyed by absolute file paths of this machine's repos. The oldest
 * sessions' marks are dropped past MAX_SESSIONS, a session's oldest
 * comparisons past MAX_COMPARISONS_PER_SESSION.
 */
import type { SessionDiffCompare, SessionFileChange } from '@/api/session-changes';

export const VIEWED_STORAGE_PREFIX = 'walnut-diff-viewed:';
const MAX_SESSIONS = 150;
const MAX_FILES_PER_COMPARISON = 5000;
/** Comparisons kept per session (each commit looked at is one): the newest. */
const MAX_COMPARISONS_PER_SESSION = 30;

/** filePath → the change signature it was ticked at. */
export type ViewedMarks = Record<string, string>;

export type ViewedState = 'viewed' | 'changed' | 'unviewed';

interface StoredMarks {
  /** Last write, ms: the pruning order. */
  at: number;
  /** compareKey → marks. */
  marks: Record<string, ViewedMarks>;
}

/** The comparison a mark belongs to. */
export function compareKey(c: SessionDiffCompare): string {
  if (c.base === 'branch') return `branch:${c.ref ?? ''}`;
  if (c.base === 'commit') return `commit:${c.commit ?? ''}`;
  return c.base;
}

/** FNV-1a over the string, hex: cheap, stable, enough to tell two versions apart. */
function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * The signature of a file's change as the list shows it, or null when the
 * list row cannot say (a light row whose content is not loaded and that
 * carries no other signal: never happens for the bases below, kept for safety).
 *  - names-only git rows (branch, commit) carry the working-tree blob id: `sig`;
 *  - the session base lists light rows: the number of edits the session made
 *    to the file (one more edit = a new version) plus its status;
 *  - the other git bases ship content: a digest of both sides.
 */
export function changeSignature(change: SessionFileChange, light: boolean): string | null {
  if (change.sig !== undefined) return `g:${change.sig}:${change.status}`;
  // The session's list: a new edit adds an op; an edit from outside the session makes the row partial.
  if (light) return `o:${change.ops}:${change.status}${change.partial ? ':p' : ''}`;
  return `h:${digest(change.before)}:${digest(change.after)}:${change.status}`;
}

export function viewedState(marks: ViewedMarks, filePath: string, sig: string | null): ViewedState {
  const at = marks[filePath];
  if (at === undefined) return 'unviewed';
  // A row that cannot be signed keeps its tick: never flip a file to Changed on no evidence.
  if (sig === null || at === sig) return 'viewed';
  return 'changed';
}

function read(sessionId: string): StoredMarks | null {
  try {
    const raw = localStorage.getItem(VIEWED_STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredMarks;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.marks !== 'object' || !parsed.marks) return null;
    return parsed;
  } catch { return null; }
}

export function loadViewedMarks(sessionId: string, key: string): ViewedMarks {
  const stored = read(sessionId)?.marks[key];
  if (!stored || typeof stored !== 'object') return {};
  const out: ViewedMarks = {};
  for (const [p, sig] of Object.entries(stored)) if (typeof sig === 'string') out[p] = sig;
  return out;
}

/** Drop the oldest sessions' marks past `max` (one scan of the storage keys). */
function prune(keep: string, max = MAX_SESSIONS): void {
  const entries: Array<{ key: string; at: number }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(VIEWED_STORAGE_PREFIX) || k === keep) continue;
    let at = 0;
    try { at = Number((JSON.parse(localStorage.getItem(k) ?? '{}') as Partial<StoredMarks>).at) || 0; } catch { /* unreadable: oldest */ }
    entries.push({ key: k, at });
  }
  if (entries.length < max) return;
  entries.sort((a, b) => a.at - b.at);
  for (const e of entries.slice(0, entries.length - max + 1)) localStorage.removeItem(e.key);
}

export function saveViewedMarks(sessionId: string, key: string, marks: ViewedMarks): void {
  try {
    const storageKey = VIEWED_STORAGE_PREFIX + sessionId;
    const stored = read(sessionId) ?? { at: 0, marks: {} };
    const paths = Object.keys(marks);
    // Re-inserted last: key order is the comparisons' recency.
    delete stored.marks[key];
    if (paths.length > 0) {
      stored.marks[key] = paths.length > MAX_FILES_PER_COMPARISON
        ? Object.fromEntries(paths.slice(-MAX_FILES_PER_COMPARISON).map((p) => [p, marks[p]!]))
        : marks;
    }
    const keys = Object.keys(stored.marks);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_COMPARISONS_PER_SESSION))) delete stored.marks[old];
    if (keys.length === 0) { localStorage.removeItem(storageKey); return; }
    stored.at = Date.now();
    const isNew = localStorage.getItem(storageKey) === null;
    const body = JSON.stringify(stored);
    try {
      localStorage.setItem(storageKey, body);
    } catch {
      // Full: drop the older half of the other sessions' marks, then try once more.
      prune(storageKey, Math.floor(MAX_SESSIONS / 2));
      localStorage.setItem(storageKey, body);
    }
    if (isNew) prune(storageKey);
  } catch { /* storage still full or blocked: the marks last this view */ }
}
