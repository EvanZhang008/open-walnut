/**
 * The header's Lock control on the open note (docs/reference/locked-notes.md): Encrypt (lock it
 * with the Passwords master password, after a confirm), Hide from AI (plain text no agent tool
 * reads, no password) and Unhide. Each saves what was typed first and keeps the editor read-only
 * while it runs (`locking`), so nothing typed meanwhile meets a refused save. Once done, the page's
 * cached copy goes and the editor reads the note again at once (the stub of a locked note, the
 * covered text of a hidden one), without waiting for the change event.
 */
import { useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useAlert, useConfirm } from '@/hooks/useConfirm';
import { withPasswordsUnlock } from '@/components/passwords/with-passwords-unlock';
import { SHEET_BUSY_WORDS, unlockSheetBusy } from '@/components/passwords/unlock-sheet-busy';
import { hiddenNotesApi, lockedNotesApi } from '@/api/locked-notes';
import { dropCachedNote, loadNoteIntoCache } from '@/stores/note-content-cache';
import { noteDocKey, publishDocSaved } from '@/stores/file-save-signal';
import type { NoteProtectAction } from './NoteProtectMenu';

const LOCK_SUB = 'Enter your master password to lock this note. Walnut keeps its text encrypted, so agents cannot read it.';

/** Notes Walnut writes itself, which the server refuses to lock or hide (core/notes/vault-files.ts walnutOwnedNote). */
export function isLockablePath(path: string): boolean {
  return !/(^|\/)global-notes\.md$/i.test(path) && !/^(projects\/[^/]+\/)?(memory|skills)\//.test(path);
}

/** The alert title when an action did not happen. */
const NOT_DONE: Record<NoteProtectAction, string> = { lock: 'Not locked', hide: 'Not hidden', unhide: 'Still hidden' };

export function useLockNote(saveState: { unsaved: () => boolean; status: string }) {
  const alert = useAlert();
  const confirm = useConfirm();
  const stateRef = useRef(saveState);
  stateRef.current = saveState;
  /** The path whose protection is changing now: its editor is read-only until the change answers. */
  const [locking, setLocking] = useState<string | null>(null);

  const asked = async (action: NoteProtectAction) => {
    if (action === 'lock') {
      return confirm({
        title: 'Lock this note?',
        message: 'Its text is encrypted with your Passwords master password. Agents, search and sync see only that it is locked, and the note opens hidden: you press Show and enter the master password to read it.\n\nText saved before the lock stays in your data\'s history, so lock a note before you write private text in it.',
        confirmLabel: 'Lock',
      });
    }
    if (action === 'unhide') {
      return confirm({
        title: 'Unhide this note?',
        message: 'Agents, search and the index can read its text again, and it opens without Show.',
        confirmLabel: 'Unhide',
      });
    }
    return true;
  };

  const run = useLeanCallback(async (action: NoteProtectAction, path: string) => {
    const notSavedYet = () => stateRef.current.unsaved() || stateRef.current.status === 'saving';
    if (!(await asked(action))) return;
    setLocking(path);
    try {
      // What was typed reaches the file first: a save after the change could be refused.
      for (let i = 0; i < 50 && notSavedYet(); i++) await new Promise((r) => setTimeout(r, 100));
      if (notSavedYet()) { await alert({ title: NOT_DONE[action], message: 'The last change is not saved yet. Try again in a moment.' }); return; }
      const r = action === 'lock'
        ? await withPasswordsUnlock(LOCK_SUB, () => lockedNotesApi.lock(path))
        : await (action === 'hide' ? hiddenNotesApi.hide(path) : hiddenNotesApi.unhide(path));
      if (!r) { if (unlockSheetBusy()) await alert({ title: NOT_DONE[action], message: SHEET_BUSY_WORDS }); return; }
      // The page's copy is read again and handed to the editor in the same tick the editor stops
      // being read-only: a locked note's plain text leaves the page, a hidden note is covered.
      dropCachedNote(path);
      const fresh = await loadNoteIntoCache(path).catch(() => null);
      const same = fresh?.contentHash === r.contentHash ? fresh : null;
      publishDocSaved({ key: noteDocKey(path), contentHash: r.contentHash, ...(same ? { content: same.content } : {}), origin: 'locked-note' });
    } catch (err) {
      await alert({ title: NOT_DONE[action], message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLocking(null);
    }
  }, [alert, confirm]);

  return { run, locking };
}
