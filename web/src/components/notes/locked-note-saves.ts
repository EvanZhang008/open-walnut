/**
 * Saving a locked note's text (docs/reference/locked-notes.md): sealed through
 * /api/v1/vault/notes/save, and never with the master password sheet. Only Show, Lock and Remove
 * lock ask for the password; a save made while this window has no Passwords unlock waits.
 *
 * An edit no open editor holds waits here, in this page's memory only (never storage):
 *  - one the panel could not save before it went (a note switch inside the save delay, Hide after
 *    a failed save, Passwords locking, a conflict the person has not settled), and
 *  - every save a panel sends, written here first and removed only once it is saved, so one that
 *    fails after the panel went is kept too.
 * A waiting edit is saved, merged three ways with the newest text, while this window has an
 * unlock: at once, and again whenever an unlock comes back. One that cannot merge waits for the
 * next Show, which shows it. A rename takes it along, a delete drops it, and a reload or a restart
 * asks first (holdUnsavedWork).
 */
import { threeWayMerge } from '@open-walnut/three-way-merge';
import { lockedNotesApi, type LockedNoteText } from '@/api/locked-notes';
import { VaultApiError, isLockedError, onVaultSessionChange, vaultSession } from '@/api/vault';
import { holdUnsavedWork } from '@/utils/unsaved-work';
import { operationErrorWords } from '@/utils/operation-error-words';
import { log } from '@/utils/log';

export const SHOW_SUB = 'Enter your master password to show this locked note. Walnut keeps its text encrypted, so agents cannot read it.';
export const CONFLICT_WORDS = 'This note changed in another window, and the two versions could not be merged. The editor shows yours.';

/** Merges in a row for one edit before it waits as a conflict. */
export const MAX_MERGES = 3;

/** An edit to save: the text, and the text and file hash it was made on (the merge base). */
export interface LockedEdit { text: string; base: string; hash: string }

/** How one save went. `stale`: another save came first (its text is read); `locked`: no unlock here. */
export type Sent =
  | { status: 'saved'; hash: string; updatedAt: string }
  | { status: 'stale'; theirs: LockedNoteText }
  | { status: 'locked' }
  | { status: 'error'; message: string };

const words = (err: unknown) => operationErrorWords(err instanceof Error ? err.message : String(err));

/** Send one save, sealed. Never shows the sheet. */
export async function sendLockedEdit(path: string, text: string, hash: string): Promise<Sent> {
  if (!vaultSession()) return { status: 'locked' };
  try {
    const r = await lockedNotesApi.save(path, text, hash);
    return { status: 'saved', hash: r.contentHash, updatedAt: r.updatedAt };
  } catch (err) {
    if (isLockedError(err)) return { status: 'locked' };
    if (!(err instanceof VaultApiError && err.status === 409 && err.code === 'conflict')) return { status: 'error', message: words(err) };
    try {
      return { status: 'stale', theirs: await lockedNotesApi.read(path) };
    } catch (e) {
      return isLockedError(e) ? { status: 'locked' } : { status: 'error', message: words(e) };
    }
  }
}

/** `edit` merged with `theirs` (made from the same base); null when the two change the same lines. */
export function mergeEdit(edit: LockedEdit, theirs: string): string | null {
  const m = threeWayMerge(edit.base, edit.text, theirs, { idFrom: 'theirs' });
  return m.ok ? m.merged : null;
}

/** Save an edit no editor holds, merged with the newest text when another save came first. */
async function saveDetached(path: string, edit: LockedEdit): Promise<'saved' | 'kept' | 'conflict'> {
  let cur = edit;
  for (let i = 0; i <= MAX_MERGES; i++) {
    const r = await sendLockedEdit(path, cur.text, cur.hash);
    if (r.status === 'saved') return 'saved';
    if (r.status !== 'stale') return 'kept';
    if (r.theirs.content === cur.text) return 'saved';
    const merged = mergeEdit(cur, r.theirs.content);
    if (merged == null) return 'conflict';
    cur = { text: merged, base: r.theirs.content, hash: r.theirs.contentHash };
  }
  return 'conflict';
}

/**
 * One waiting edit. `owner`: the open panel whose save this is, on its way (that panel's editor
 * still holds the text); null once no panel holds it. `conflict`: it met text it cannot merge
 * with, and waits for the next Show.
 */
interface Waiting { edit: LockedEdit; owner: symbol | null; busy: boolean; conflict: boolean }

const waiting = new Map<string, Waiting>();

/** Where `entry` waits now (a rename moves it), or null once it is saved, taken or dropped. */
function pathOf(entry: Waiting): string | null {
  for (const [p, e] of waiting) if (e === entry) return p;
  return null;
}

let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  // An unlock came back (here, or in another window of this browser): what waits is saved now.
  onVaultSessionChange(() => { if (vaultSession()) flushUnsavedEdits(); });
  // Only in this page's memory: a reload, a restart or a closing window asks first.
  holdUnsavedWork(() => {
    const n = waiting.size;
    if (n === 0) return null;
    return { what: n === 1 ? 'A change to a locked note, not saved yet' : `${n} changes to locked notes, not saved yet`, where: 'Notes', lostOn: 'both' };
  });
}

/** Keep `edit` for `path` until it is saved (it replaces an older one, made before it), and try now. */
export function keepUnsavedEdit(path: string, edit: LockedEdit): void {
  wire();
  waiting.set(path, { edit, owner: null, busy: false, conflict: false });
  flushUnsavedEdits();
}

/** A panel's save about to go out, written here first; `settleSending` gets its answer. */
export function holdSending(path: string, edit: LockedEdit, owner: symbol): object {
  wire();
  const entry: Waiting = { edit, owner, busy: true, conflict: false };
  waiting.set(path, entry);
  return entry;
}

/**
 * A panel's save answered. Saved, or not saved while its panel is still open (the editor keeps
 * the text): it goes from here. Not saved after the panel went: it stays and is tried again.
 */
export function settleSending(token: object, saved: boolean): void {
  const entry = token as Waiting;
  entry.busy = false;
  const path = pathOf(entry);
  if (path == null) return;
  if (saved || entry.owner) { waiting.delete(path); return; }
  flushUnsavedEdits();
}

/** The panel went (Hide, a note switch, Passwords locking): its saves on their way stay here if they fail. */
export function releaseSending(owner: symbol): void {
  for (const e of waiting.values()) if (e.owner === owner) e.owner = null;
}

/** The edit still waiting for `path`, taken: the caller shows it again and saves it. */
export function takeUnsavedEdit(path: string): LockedEdit | null {
  const e = waiting.get(path);
  if (!e || e.owner) return null;
  waiting.delete(path);
  return e.edit;
}

/** Save every waiting edit no panel holds, while this window has an unlock. Never a sheet. */
export function flushUnsavedEdits(): void {
  if (!vaultSession()) return;
  for (const [path, e] of [...waiting]) {
    if (e.owner || e.busy || e.conflict) continue;
    e.busy = true;
    void saveDetached(path, e.edit).then((how) => {
      e.busy = false;
      const at = pathOf(e);
      if (at == null) return;
      if (how === 'saved') waiting.delete(at);
      else if (how === 'conflict') {
        e.conflict = true;
        log.info('notes', 'a kept change to a locked note met a newer one; it shows on the next Show', { path: at });
      }
    });
  }
}

/** A note path changed under its waiting edits and open panels: moved to `to`, or deleted (`to` null). */
export interface LockedPathChange { match: (path: string) => boolean; to: string | null }
const pathListeners = new Set<(change: LockedPathChange) => void>();

/** An open panel follows its note: a rename saves at the new path, a delete keeps nothing. */
export function onLockedNotePathChange(fn: (change: LockedPathChange) => void): () => void {
  pathListeners.add(fn);
  return () => { pathListeners.delete(fn); };
}

/** A note renamed or moved: its waiting edit goes with it, and its open panel saves there. */
export function moveUnsavedEdits(from: string, to: string): void {
  const e = waiting.get(from);
  if (e) { waiting.delete(from); waiting.set(to, e); }
  for (const fn of [...pathListeners]) fn({ match: (p) => p === from, to });
}

/** Notes deleted: their waiting edits go too, and their open panels keep nothing more. */
export function dropUnsavedEdits(match: (path: string) => boolean): void {
  for (const p of [...waiting.keys()]) if (match(p)) waiting.delete(p);
  for (const fn of [...pathListeners]) fn({ match, to: null });
}

/** Test hook. */
export function resetLockedNoteSavesForTest(): void {
  waiting.clear();
  pathListeners.clear();
}
