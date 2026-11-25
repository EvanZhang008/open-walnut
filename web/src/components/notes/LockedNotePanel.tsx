import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import { splitFrontmatter, joinFrontmatter } from './frontmatter';
import { markdownKeepingSource } from './editor-keep-source';
import { CONFLICT_WORDS, SHOW_SUB, keepUnsavedEdit, saveLockedEdit, takeUnsavedEdit, type LockedEdit } from './locked-note-saves';
import { withPasswordsUnlock } from '@/components/passwords/with-passwords-unlock';
import { lockedNotesApi } from '@/api/locked-notes';
import { onVaultSessionChange, vaultSession } from '@/api/vault';
// A Lock anywhere (another window, the extension, Lock all) reaches this window at once.
import '@/api/vault-live';
import { useEvent } from '@/hooks/useWebSocket';
import { useConfirm } from '@/hooks/useConfirm';
import { ICON_EYE_OFF, ICON_LOCK, ICON_UNLOCK } from '@/components/common/Icons';
import { EmptyState } from '@/components/common/EmptyState';
import { NoticeCard } from '@/components/common/NoticeCard';

/**
 * A locked note on the Notes page (docs/reference/locked-notes.md). Hidden by default: the file is
 * in the tree, but its text shows only after Show, which needs this window's Passwords unlock (the
 * master password). Hide, leaving the note, or Passwords locking hides it again, and the text is
 * dropped from the page. It is never cached, kept in storage, sent to a chat or put in an
 * attachment: saves go sealed (locked-note-saves.ts), and the editor has no Ask, raw view or images.
 * An edit not saved when the text hides is kept in memory and saved; the next Show puts it back.
 */

const SAVE_DEBOUNCE_MS = 600;

const noteName = (p: string) => p.replace(/\.md$/i, '').split('/').pop() || p;

interface Shown {
  /** The note's text as last read or saved (frontmatter + body): the base of a merge. */
  base: string;
  frontmatter: string;
  body: string;
  hash: string;
  updatedAt: string;
}

export interface LockedNotePanelProps {
  notePath: string;
  onNavigate: (path: string) => void;
  onLocate?: () => void;
  onBreadcrumbNavigate?: (folderPath: string) => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  readOnly?: boolean;
}

export function LockedNotePanel({ notePath, onNavigate, onLocate, onBreadcrumbNavigate, isFavorite, onToggleFavorite, readOnly = false }: LockedNotePanelProps) {
  const confirm = useConfirm();
  const [shown, setShownState] = useState<Shown | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');
  /** Bumped to rebuild the editor from new text (a merge, another window's save). */
  const [gen, setGen] = useState(0);
  /** What is shown, kept in step at once (a save queued right after another reads the new hash). */
  const shownRef = useRef<Shown | null>(null);
  const setShown = useCallback((next: Shown | null) => { shownRef.current = next; setShownState(next); }, []);
  const editorRef = useRef<Editor | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef<Promise<boolean> | null>(null);
  const dirtyRef = useRef(false);
  const pathRef = useRef(notePath);
  pathRef.current = notePath;

  /** The editor's text as an edit to save, or null when nothing changed. Synchronous: read before the editor goes. */
  const takeEdit = useCallback((editor: Editor | null = editorRef.current): LockedEdit | null => {
    const cur = shownRef.current;
    if (!cur || !editor || editor.isDestroyed || !dirtyRef.current) return null;
    dirtyRef.current = false;
    const text = joinFrontmatter(cur.frontmatter, markdownKeepingSource(editor, cur.body));
    return text === cur.base ? null : { text, base: cur.base, hash: cur.hash };
  }, []);

  /** The text goes from the page; an edit still unsaved is kept and saved (locked-note-saves.ts). */
  const hide = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const edit = takeEdit();
    if (edit) keepUnsavedEdit(pathRef.current, edit);
    editorRef.current = null;
    setShown(null);
    setSaveStatus('idle');
  }, [setShown, takeEdit]);

  const adopt = useCallback((text: string, hash: string, updatedAt: string) => {
    const { frontmatter, body } = splitFrontmatter(text);
    setShown({ base: text, frontmatter, body, hash, updatedAt });
    setGen((g) => g + 1);
  }, [setShown]);

  const show = useCallback(async () => {
    setError(null);
    setOpening(true);
    try {
      const r = await withPasswordsUnlock(SHOW_SUB, () => lockedNotesApi.read(notePath));
      if (!r || pathRef.current !== notePath) return;
      const waiting = takeUnsavedEdit(notePath);
      if (!waiting) { adopt(r.content, r.contentHash, r.updatedAt); return; }
      // An edit that did not save when the text last hid: back in the editor, and saved now.
      const saved = await saveLockedEdit(notePath, waiting);
      if (saved.status === 'saved') adopt(saved.text, saved.hash, saved.updatedAt);
      else {
        adopt(r.content, r.contentHash, r.updatedAt);
        keepUnsavedEdit(notePath, waiting);
        setError(saved.status === 'conflict' ? CONFLICT_WORDS : 'Your last change to this note is not saved yet. Show it again to save it.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [adopt, notePath]);

  /** Save the editor's text now (sealed). True when nothing is left unsaved. */
  const save = useCallback(async (): Promise<boolean> => {
    const edit = takeEdit();
    if (!edit) return !dirtyRef.current;
    const path = pathRef.current;
    setSaveStatus('saving');
    const r = await saveLockedEdit(path, edit);
    if (pathRef.current !== path) return r.status === 'saved';
    if (r.status === 'saved') {
      const cur = shownRef.current;
      if (r.merged) {
        // Another window's change came in: shown as merged, unless more was typed meanwhile (the next save merges that).
        if (!dirtyRef.current) adopt(r.text, r.hash, r.updatedAt);
        else if (cur) setShown({ ...cur, base: r.text, hash: r.hash, updatedAt: r.updatedAt });
      } else if (cur) setShown({ ...cur, base: r.text, hash: r.hash, updatedAt: r.updatedAt });
      setSaveStatus(dirtyRef.current ? 'idle' : 'saved');
      return true;
    }
    dirtyRef.current = true;
    setSaveStatus('error');
    if (r.status === 'conflict') setError(CONFLICT_WORDS);
    else if (r.status === 'error') setError(r.message);
    return false;
  }, [adopt, setShown, takeEdit]);

  const flush = useCallback((): Promise<boolean> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const run = (savingRef.current ?? Promise.resolve(true)).then(() => save());
    savingRef.current = run;
    void run.finally(() => { if (savingRef.current === run) savingRef.current = null; });
    return run;
  }, [save]);

  const watched = useRef<Editor | null>(null);
  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
    if (watched.current !== editor) {
      watched.current = editor;
      // The editor goes (a note switch, a rename, the page closing) before a save ran: its text is
      // read now, while it still exists, and kept until it is saved.
      editor.on('destroy', () => {
        const edit = takeEdit(editor);
        if (edit) keepUnsavedEdit(pathRef.current, edit);
      });
    }
    dirtyRef.current = true;
    setSaveStatus('idle');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { timerRef.current = null; void flush(); }, SAVE_DEBOUNCE_MS);
  }, [flush, takeEdit]);

  // Leaving the note: a save still waiting goes now (the editor's destroy keeps what it had).
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Passwords locked (Lock, another window, Lock all, the unlock running out): hidden at once; an
  // unsaved edit is kept and saved when the person unlocks again.
  useEffect(() => onVaultSessionChange(() => {
    if (!vaultSession() && shownRef.current) hide();
  }), [hide]);

  // Another window saved this note: an editor with nothing unsaved takes the new text.
  useEvent('notes:updated', (data: unknown) => {
    const d = data as { source?: string; contentHash?: string } | null;
    const cur = shownRef.current;
    if (!cur || d?.source !== `notes/${notePath.replace(/\.md$/, '')}` || d.contentHash === cur.hash) return;
    if (dirtyRef.current || timerRef.current || savingRef.current) return; // the save merges
    void lockedNotesApi.read(notePath).then((r) => {
      if (pathRef.current === notePath && !dirtyRef.current && r.contentHash !== shownRef.current?.hash) adopt(r.content, r.contentHash, r.updatedAt);
    }).catch(() => undefined);
  });

  const hideNow = useCallback(async () => {
    if (await flush()) { hide(); return; }
    const ok = await confirm({
      title: 'Hide without saving?',
      message: 'Your last change to this note did not save. Walnut keeps it on this page and saves it the next time you show the note.',
      confirmLabel: 'Hide',
    });
    if (ok) hide();
  }, [confirm, flush, hide]);

  const removeLock = useCallback(async () => {
    const ok = await confirm({
      title: 'Remove the lock?',
      message: 'The text goes back into the note unencrypted, where agents, search and sync can read it again.',
      confirmLabel: 'Remove lock',
      danger: true,
    });
    if (!ok) return;
    if (!(await flush())) return;
    try {
      const r = await withPasswordsUnlock(SHOW_SUB, () => lockedNotesApi.removeLock(notePath, shownRef.current?.hash));
      if (r) { editorRef.current = null; setShown(null); } // the page reads the note again from its change event, now a plain one
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [confirm, flush, notePath, setShown]);

  if (!shown) {
    return (
      <EmptyState
        size="pane"
        icon={ICON_LOCK}
        title={noteName(notePath)}
        hint={error ?? 'Locked. Its text is hidden and encrypted with your master password, so agents, search and sync cannot read it.'}
        action={{ label: opening ? 'Opening…' : 'Show', onClick: () => void show(), primary: true, disabled: opening, testId: 'locked-note-show' }}
        testId="locked-note-hidden"
        role={error ? 'alert' : 'status'}
      />
    );
  }

  const actions = (
    <>
      <button type="button" className="btn btn-icon notes-locked-hide-btn" onClick={() => void hideNow()} aria-label="Hide the text" title="Hide" data-testid="locked-note-hide">
        {ICON_EYE_OFF}
      </button>
      {!readOnly && (
        <button type="button" className="btn btn-icon notes-locked-remove-btn" onClick={() => void removeLock()} aria-label="Remove the lock" title="Remove lock" data-testid="locked-note-remove-lock">
          {ICON_UNLOCK}
        </button>
      )}
    </>
  );

  return (
    <>
      {error && (
        <NoticeCard className="notes-locked-notice" role="alert" line={error} onClose={() => setError(null)} testId="locked-note-error" />
      )}
      <MarkdownEditorPanel
        key={gen}
        content={shown.body}
        onEditorUpdate={onEditorUpdate}
        saveStatus={saveStatus}
        updatedAt={shown.updatedAt}
        docId={notePath}
        breadcrumbPath={notePath}
        onNavigate={onNavigate}
        onLocate={onLocate}
        onBreadcrumbNavigate={onBreadcrumbNavigate}
        autoFocus={!readOnly}
        readOnly={readOnly}
        placeholder="Start writing..."
        enableWikiLinks
        enableBlockTools
        onWikiLinkClick={onNavigate}
        showWidthToggle
        showFormatToolbar
        showBookmark
        showLocate
        showBreadcrumb
        showBacklinks
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        headerActions={actions}
        noImages
        findPrimary
      />
    </>
  );
}
