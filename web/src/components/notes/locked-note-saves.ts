/**
 * Saving a locked note's text (docs/reference/locked-notes.md): sealed through
 * /api/v1/vault/notes/save, merged three ways when another window saved it meanwhile, and never
 * lost when the panel goes away first. An edit the panel could not save before it went (a note
 * switch inside the save delay, Passwords locking, an unlock the person cancelled) waits here, in
 * this page's memory only (never storage), and the next Show of that note puts it back and saves it.
 */
import { threeWayMerge } from '@open-walnut/three-way-merge';
import { lockedNotesApi } from '@/api/locked-notes';
import { VaultApiError } from '@/api/vault';
import { withPasswordsUnlock } from '@/components/passwords/with-passwords-unlock';
import { log } from '@/utils/log';

export const SHOW_SUB = 'Enter your master password to show this locked note. Walnut keeps its text encrypted, so agents cannot read it.';
export const SAVE_SUB = 'Enter your master password to save your change to this locked note.';
export const CONFLICT_WORDS = 'This note changed in another window and the two could not be merged. Copy your last change, then Hide and Show it again to read the newest text.';

/** An edit to save: the text, and the text and file hash it was made on (the merge base). */
export interface LockedEdit { text: string; base: string; hash: string }

export type SaveResult =
  | { status: 'saved'; text: string; hash: string; updatedAt: string; merged: boolean }
  | { status: 'cancelled' }
  | { status: 'conflict' }
  | { status: 'error'; message: string };

/** Save `edit` sealed; on a conflict merge with the newest text and save the merge. */
export async function saveLockedEdit(path: string, edit: LockedEdit): Promise<SaveResult> {
  try {
    const r = await withPasswordsUnlock(SAVE_SUB, () => lockedNotesApi.save(path, edit.text, edit.hash));
    if (!r) return { status: 'cancelled' };
    return { status: 'saved', text: edit.text, hash: r.contentHash, updatedAt: r.updatedAt, merged: false };
  } catch (err) {
    if (!(err instanceof VaultApiError && err.status === 409 && err.code === 'conflict')) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    const theirs = await lockedNotesApi.read(path).catch(() => null);
    const merge = theirs ? threeWayMerge(edit.base, edit.text, theirs.content, { idFrom: 'theirs' }) : null;
    if (theirs && merge?.ok) {
      const r = await lockedNotesApi.save(path, merge.merged, theirs.contentHash).catch(() => null);
      if (r) return { status: 'saved', text: merge.merged, hash: r.contentHash, updatedAt: r.updatedAt, merged: true };
    }
    log.warn('notes', 'locked note save conflict did not merge', { path });
    return { status: 'conflict' };
  }
}

/** Edits whose panel went before they were saved, by note path: this page's memory only. */
const unsaved = new Map<string, LockedEdit>();

/** Keep `edit` until it is saved, and try to save it now. */
export function keepUnsavedEdit(path: string, edit: LockedEdit): void {
  unsaved.set(path, edit);
  void saveLockedEdit(path, edit).then((r) => {
    if (r.status === 'saved' && unsaved.get(path) === edit) unsaved.delete(path);
  });
}

/** The edit still waiting for `path` (taken: the caller puts it back in the editor and saves it). */
export function takeUnsavedEdit(path: string): LockedEdit | null {
  const e = unsaved.get(path) ?? null;
  unsaved.delete(path);
  return e;
}
