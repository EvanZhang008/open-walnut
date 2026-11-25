/**
 * Lock the open plain note from its header (docs/reference/locked-notes.md): a confirm, what was
 * typed saved first, then sealed with the Passwords master password. While it runs the editor is
 * read-only (`locking`), so nothing typed meanwhile meets a refused save; the page then reads the
 * note again from its change event and shows it hidden.
 */
import { useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { useAlert, useConfirm } from '@/hooks/useConfirm';
import { withPasswordsUnlock } from '@/components/passwords/with-passwords-unlock';
import { lockedNotesApi } from '@/api/locked-notes';

const LOCK_SUB = 'Enter your master password to lock this note. Walnut keeps its text encrypted, so agents cannot read it.';

/** Notes Walnut writes itself, which the server refuses to lock (core/notes/vault-files.ts walnutOwnedNote). */
export function isLockablePath(path: string): boolean {
  return !/(^|\/)global-notes\.md$/i.test(path) && !/^(projects\/[^/]+\/)?(memory|skills)\//.test(path);
}

export function useLockNote(saveState: { unsaved: () => boolean; status: string }) {
  const alert = useAlert();
  const confirm = useConfirm();
  const stateRef = useRef(saveState);
  stateRef.current = saveState;
  /** The path being locked now: its editor is read-only until the lock answers. */
  const [locking, setLocking] = useState<string | null>(null);

  const lock = useLeanCallback(async (path: string) => {
    const notSavedYet = () => stateRef.current.unsaved() || stateRef.current.status === 'saving';
    const ok = await confirm({
      title: 'Lock this note?',
      message: 'Its text is encrypted with your Passwords master password. Agents, search and sync see only that it is locked, and the note opens hidden: you press Show and enter the master password to read it.',
      confirmLabel: 'Lock',
    });
    if (!ok) return;
    setLocking(path);
    try {
      // What was typed reaches the file first: a save after the lock would be refused.
      for (let i = 0; i < 50 && notSavedYet(); i++) await new Promise((r) => setTimeout(r, 100));
      if (notSavedYet()) { await alert({ title: 'Not locked', message: 'The last change is not saved yet. Try again in a moment.' }); return; }
      await withPasswordsUnlock(LOCK_SUB, () => lockedNotesApi.lock(path));
    } catch (err) {
      await alert({ title: 'Not locked', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLocking(null);
    }
  }, [alert, confirm]);

  return { lock, locking };
}
