/**
 * The text of one locked note while it shows (LockedNotePanel.tsx, docs/reference/locked-notes.md):
 * Show, the debounced sealed saves, the merge with another window's save, a conflict the person
 * settles, Hide and Remove lock.
 *
 * Rules every path here keeps:
 *  - An answer that comes back after the text hid (Hide, leaving the note, Passwords locking) is
 *    dropped: `epoch` counts every hide, and text is shown only while this window has an unlock.
 *  - Nothing typed is lost. Every save is written to locked-note-saves.ts before it goes, and what
 *    the editor holds when the panel goes is kept there too; both are saved, or put back on the
 *    next Show.
 *  - Another window's change reaches the open editor at once, in place (editor-merge.ts), so the
 *    next save carries it. Changes that cannot merge are a conflict the person settles: keep their
 *    own version, or take the other one.
 */
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { splitFrontmatter, joinFrontmatter } from './frontmatter';
import { markdownKeepingSource } from './editor-keep-source';
import { mergeIntoEditor, showInEditor } from './editor-merge';
import { isHiddenNote } from './locked-note';
import {
  MAX_MERGES, SHOW_SUB, holdSending, keepUnsavedEdit, mergeEdit, onLockedNotePathChange, releaseSending,
  sendLockedEdit, settleSending, takeUnsavedEdit, type LockedEdit,
} from './locked-note-saves';
import { withPasswordsUnlock } from '@/components/passwords/with-passwords-unlock';
import { SHEET_BUSY_WORDS, unlockSheetBusy } from '@/components/passwords/unlock-sheet-busy';
import { lockedNotesApi, type LockedNoteText } from '@/api/locked-notes';
import { onVaultSessionChange, vaultSession, VaultApiError } from '@/api/vault';
// A Lock anywhere (another window, the extension, Lock all) reaches this window at once.
import '@/api/vault-live';
import { useEvent } from '@/hooks/useWebSocket';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { noteDocKey, publishDocSaved } from '@/stores/file-save-signal';
import { holdUnsavedWork } from '@/utils/unsaved-work';
import { operationErrorWords } from '@/utils/operation-error-words';
import { log } from '@/utils/log';

const SAVE_DEBOUNCE_MS = 600;

export type LockedSaveStatus = 'saved' | 'saving' | 'error' | 'idle';

/** The note as the last read or save left it on disk: what the next save names. */
interface Disk {
  /** Its text, the base of a merge. */
  base: string;
  hash: string;
  /** The frontmatter of the text in the editor (kept out of it, put back on save). */
  frontmatter: string;
  /** The body the editor was given, whose own bytes a save keeps on lines not edited. */
  seed: string;
}

/** Another window's text that does not merge with the person's: they choose. `base`/`hash`: what theirs was made on. */
export interface LockedConflict { theirs: LockedNoteText; base: string; hash: string }

const words = (err: unknown) => operationErrorWords(err instanceof Error ? err.message : String(err));

export function useLockedNoteEditor(notePath: string) {
  /** The body the editor mounts with, and its remount key (null: hidden). */
  const [editorDoc, setEditorDoc] = useState<{ body: string; gen: number } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Show found the key gone from Passwords: its backup can bring it back (LockedNoteKeyRestore). */
  const [keyMissing, setKeyMissing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<LockedSaveStatus>('idle');
  const [conflict, setConflictState] = useState<LockedConflict | null>(null);

  const owner = useState(() => Symbol('locked-note-panel'))[0];
  /** Where saves go: the note's path, moved by a rename, null once it is deleted. */
  const pathRef = useRef<string | null>(notePath);
  const diskRef = useRef<Disk | null>(null);
  const conflictRef = useRef<LockedConflict | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const watchedRef = useRef<Editor | null>(null);
  /** The full text the editor was mounted with, while it has not reported an edit yet. */
  const loadedRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const epochRef = useRef(0);
  const genRef = useRef(0);
  const mergesRef = useRef(0);

  const setConflict = (c: LockedConflict | null) => { conflictRef.current = c; setConflictState(c); };
  /** Still showing what `epoch` showed, with an unlock in this window. */
  const live = (epoch: number) => epoch === epochRef.current && !!diskRef.current && !!vaultSession();
  const busy = () => dirtyRef.current || !!timerRef.current || !!savingRef.current || !!conflictRef.current;

  /** Mount the editor on `text`, `disk` being the note as read. */
  const mount = (text: string, disk: { content: string; contentHash: string; updatedAt: string }) => {
    const { frontmatter, body } = splitFrontmatter(text);
    diskRef.current = { base: disk.content, hash: disk.contentHash, frontmatter, seed: body };
    loadedRef.current = text;
    editorRef.current = null;
    dirtyRef.current = false;
    setConflict(null);
    setUpdatedAt(disk.updatedAt);
    setSaveStatus('idle');
    setEditorDoc({ body, gen: ++genRef.current });
  };

  /** What to save now, or null when nothing changed. Synchronous: read before the editor goes. */
  const takeEdit = (editor: Editor | null = editorRef.current): LockedEdit | null => {
    const disk = diskRef.current;
    if (!disk || !dirtyRef.current) return null;
    let text: string;
    if (editor && !editor.isDestroyed) text = joinFrontmatter(disk.frontmatter, markdownKeepingSource(editor, disk.seed));
    else if (!editor && loadedRef.current != null) text = loadedRef.current; // not touched since it mounted
    else return null;
    dirtyRef.current = false;
    const c = conflictRef.current;
    // Unsettled, it is still made on what theirs was made on: saved later, it meets theirs again.
    if (c) return { text, base: c.base, hash: c.hash };
    return text === disk.base ? null : { text, base: disk.base, hash: disk.hash };
  };

  const keep = (edit: LockedEdit | null) => {
    const path = pathRef.current;
    if (edit && path != null) keepUnsavedEdit(path, edit);
  };

  const enterConflict = (c: LockedConflict) => {
    log.warn('notes', 'a locked note changed in another window and did not merge', { path: pathRef.current });
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setConflict(c);
    dirtyRef.current = true;
    setSaveStatus('idle');
  };

  /** The text goes from the page; an edit not saved yet is kept and saved (locked-note-saves.ts). */
  const hide = useLeanCallback(() => {
    epochRef.current++;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    keep(takeEdit());
    releaseSending(owner);
    diskRef.current = null;
    editorRef.current = null;
    loadedRef.current = null;
    setConflict(null);
    setEditorDoc(null);
    setUpdatedAt(null);
    setSaveStatus('idle');
  }, []);

  /** Another save came first: merge with the editor as it is now, shown at once, and save that. */
  const mergeTheirs = useLeanCallback(async (edit: LockedEdit, theirs: LockedNoteText): Promise<boolean> => {
    const disk = diskRef.current!;
    const editor = editorRef.current && !editorRef.current.isDestroyed ? editorRef.current : null;
    const ours = editor ? joinFrontmatter(disk.frontmatter, markdownKeepingSource(editor, disk.seed)) : (loadedRef.current ?? edit.text);
    const m = mergesRef.current++ < MAX_MERGES ? mergeIntoEditor(editor, edit.base, ours, theirs.content) : null;
    if (!m?.ok) { enterConflict({ theirs, base: edit.base, hash: edit.hash }); return false; }
    diskRef.current = { base: theirs.content, hash: theirs.contentHash, frontmatter: m.frontmatter, seed: m.body };
    if (!editor) { loadedRef.current = m.merged; setEditorDoc({ body: m.body, gen: ++genRef.current }); }
    setUpdatedAt(theirs.updatedAt);
    dirtyRef.current = m.merged !== theirs.content;
    if (!dirtyRef.current) { setSaveStatus('idle'); return true; }
    return save();
  }, []);

  /** Save the editor's text now (or `explicit`), sealed. True when nothing is left unsaved. */
  const save = useLeanCallback(async (explicit?: LockedEdit): Promise<boolean> => {
    const path = pathRef.current;
    if (path == null) return true; // deleted
    if (conflictRef.current) return false; // waits for the person's choice
    const edit = explicit ?? takeEdit();
    if (!edit) return !dirtyRef.current;
    const epoch = epochRef.current;
    setSaveStatus('saving');
    const held = holdSending(path, edit, owner);
    const r = await sendLockedEdit(path, edit.text, edit.hash);
    // Hidden meanwhile: the editor no longer holds this text, so a failed save stays kept.
    const shown = live(epoch);
    if (!shown) releaseSending(owner);
    settleSending(held, r.status === 'saved');
    if (!shown) return r.status === 'saved';
    if (r.status === 'saved') {
      diskRef.current = { ...diskRef.current!, base: edit.text, hash: r.hash };
      mergesRef.current = 0;
      setUpdatedAt(r.updatedAt);
      setSaveStatus(dirtyRef.current ? 'idle' : 'saved');
      return true;
    }
    if (r.status === 'stale') return mergeTheirs(edit, r.theirs);
    dirtyRef.current = true;
    setSaveStatus('error');
    setError(r.status === 'locked' ? 'Passwords is locked in this window. Your change is kept and saved once you unlock.' : r.message);
    return false;
  }, []);

  /** Saves run one after another; the answer of this one says whether anything is left unsaved. */
  const flush = useLeanCallback((explicit?: LockedEdit): Promise<boolean> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const run = (savingRef.current ?? Promise.resolve(true)).then(() => save(explicit)).catch((err) => {
      log.warn('notes', 'locked note save failed', { path: pathRef.current, error: words(err) });
      dirtyRef.current = true;
      return false;
    });
    savingRef.current = run;
    void run.finally(() => { if (savingRef.current === run) savingRef.current = null; });
    return run;
  }, []);

  /** Show the text: an edit that waited for this note comes back in the editor, merged, and is saved. */
  const show = useLeanCallback(async () => {
    const path = pathRef.current;
    if (path == null) return;
    const epoch = epochRef.current;
    setError(null);
    setKeyMissing(false);
    setOpening(true);
    try {
      const r = await withPasswordsUnlock(SHOW_SUB, () => lockedNotesApi.read(path));
      if (!r) { if (unlockSheetBusy()) setError(SHEET_BUSY_WORDS); return; }
      if (epoch !== epochRef.current || pathRef.current !== path || !vaultSession()) return;
      mergesRef.current = 0;
      const waiting = takeUnsavedEdit(path);
      if (!waiting || waiting.text === r.content) { mount(r.content, r); return; }
      const merged = mergeEdit(waiting, r.content);
      if (merged == null) {
        // The person's version, unsaved, with the choice: theirs did not merge with it.
        mount(waiting.text, r);
        enterConflict({ theirs: r, base: waiting.base, hash: waiting.hash });
        return;
      }
      mount(merged, r);
      if (merged !== r.content) void flush({ text: merged, base: r.content, hash: r.contentHash });
    } catch (err) {
      if (err instanceof VaultApiError && err.code === 'locked_key_missing') { setKeyMissing(true); return; }
      setError(words(err));
    } finally {
      setOpening(false);
    }
  }, []);

  const onEditorUpdate = useLeanCallback((editor: Editor) => {
    if (!diskRef.current) return;
    editorRef.current = editor;
    loadedRef.current = null;
    if (watchedRef.current !== editor) {
      watchedRef.current = editor;
      // The editor goes (a note switch, a rename, the page closing) before a save ran: its text is
      // read now, while it still exists, and kept until it is saved.
      editor.on('destroy', () => keep(takeEdit(editor)));
    }
    dirtyRef.current = true;
    setSaveStatus('idle');
    if (conflictRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { timerRef.current = null; void flush(); }, SAVE_DEBOUNCE_MS);
  }, []);

  /** Settle a conflict: keep the person's version (saved over theirs), or take theirs. */
  const keepMine = useLeanCallback(() => {
    const c = conflictRef.current;
    const disk = diskRef.current;
    if (!c || !disk) return;
    diskRef.current = { ...disk, base: c.theirs.content, hash: c.theirs.contentHash };
    setConflict(null);
    mergesRef.current = 0;
    dirtyRef.current = true;
    void flush();
  }, []);
  const takeTheirs = useLeanCallback(() => {
    const c = conflictRef.current;
    if (c) mount(c.theirs.content, c.theirs);
  }, []);

  /** Hide once everything is saved; false when something is not (the caller asks the person). */
  const hideIfSaved = useLeanCallback(async (): Promise<boolean> => {
    if (!(await flush())) return false;
    hide();
    return true;
  }, []);

  /** Remove the lock. The editor is read-only from the confirm on, so nothing typed meanwhile is lost. */
  const removeLock = useLeanCallback(async () => {
    const path = pathRef.current;
    if (path == null) return;
    setRemoving(true);
    try {
      if (!(await flush())) { setError('Your last change is not saved yet, so the lock stays. Try again in a moment.'); return; }
      const r = await withPasswordsUnlock(SHOW_SUB, () => lockedNotesApi.removeLock(path, diskRef.current?.hash));
      if (!r) { if (unlockSheetBusy()) setError(SHEET_BUSY_WORDS); return; }
      epochRef.current++;
      diskRef.current = null;
      editorRef.current = null;
      loadedRef.current = null;
      setEditorDoc(null);
      // The page's editor takes the plain text at once, not when the change event comes.
      publishDocSaved({ key: noteDocKey(path), contentHash: r.contentHash, content: r.content, origin: 'locked-note' });
    } catch (err) {
      setError(words(err));
    } finally {
      setRemoving(false);
    }
  }, []);

  // Another window saved this note: an editor with nothing unsaved takes the new text in place.
  useEvent('notes:updated', (data: unknown) => {
    const d = data as { source?: string; contentHash?: string } | null;
    const path = pathRef.current;
    const disk = diskRef.current;
    if (!disk || path == null || d?.source !== `notes/${path.replace(/\.md$/, '')}` || d.contentHash === disk.hash) return;
    if (busy()) return; // the next save merges
    const epoch = epochRef.current;
    void lockedNotesApi.read(path).then((r) => {
      if (!live(epoch) || pathRef.current !== path || busy() || r.contentHash === diskRef.current!.hash) return;
      const editor = editorRef.current;
      if (!editor || editor.isDestroyed) { mount(r.content, r); return; }
      const { frontmatter, body } = splitFrontmatter(r.content);
      showInEditor(editor, body);
      diskRef.current = { base: r.content, hash: r.contentHash, frontmatter, seed: body };
      setUpdatedAt(r.updatedAt);
    }).catch(() => undefined);
  });

  // Passwords locked (Lock, another window, Lock all, the unlock running out): hidden at once.
  useEffect(() => onVaultSessionChange(() => {
    if (vaultSession()) return;
    setKeyMissing(false); // the key's restore needs an unlock too: back to Show
    if (diskRef.current) hide();
  }), [hide]);
  // Renamed or moved: saves go to the new path. Deleted: nothing more is kept.
  useEffect(() => onLockedNotePathChange((c) => {
    const p = pathRef.current;
    if (p != null && c.match(p)) pathRef.current = c.to;
  }), []);
  // Typed and not sent yet: a reload or a restart asks first.
  useEffect(() => holdUnsavedWork(() => (diskRef.current && (dirtyRef.current || timerRef.current)
    ? { what: 'A change to a locked note, not saved yet', where: 'Notes', lostOn: 'both' } : null)), []);
  // Leaving the note: what the editor holds is kept, and saves still on their way stay kept if they fail.
  useEffect(() => () => {
    epochRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    keep(takeEdit());
    releaseSending(owner);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** The text shown was hidden before its lock, so Remove lock gives a hidden note back. */
  const comesBackHidden = () => isHiddenNote(diskRef.current?.frontmatter);

  return {
    editorDoc, updatedAt, opening, removing, error, setError, keyMissing, saveStatus, conflict,
    show, hide, hideIfSaved, removeLock, onEditorUpdate, keepMine, takeTheirs, comesBackHidden,
  };
}
