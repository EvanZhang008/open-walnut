import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import { CONFLICT_WORDS } from './locked-note-saves';
import { useLockedNoteEditor } from './useLockedNoteEditor';
import { useConfirm } from '@/hooks/useConfirm';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { ICON_LOCK, ICON_UNLOCK } from '@/components/common/Icons';
import { EmptyState } from '@/components/common/EmptyState';
import { NoticeCard } from '@/components/common/NoticeCard';
import { CoverButton } from './HiddenNoteCover';
import { LockedNoteKeyRestore } from './LockedNoteKeyRestore';
import { noteName } from './locked-note';

/**
 * A locked note on the Notes page (docs/reference/locked-notes.md). Hidden by default: the file is
 * in the tree, but its text shows only after Show, which needs this window's Passwords unlock (the
 * master password). Hide, leaving the note, or Passwords locking hides it again, and the text is
 * dropped from the page. It is never cached, kept in storage, sent to a chat or put in an
 * attachment: saves go sealed, and the editor has no Ask, raw view or images. The text, its saves
 * and merges live in useLockedNoteEditor.ts; this is the view.
 */

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
  const note = useLockedNoteEditor(notePath);
  const { editorDoc, error, conflict } = note;

  const hideNow = useLeanCallback(async () => {
    if (await note.hideIfSaved()) return;
    const ok = await confirm({
      title: 'Hide without saving?',
      message: conflict
        ? 'Your version is not saved: this note changed in another window. Walnut keeps yours on this page and shows it again the next time you show the note.'
        : 'Your last change to this note is not saved yet. Walnut keeps it on this page and saves it as soon as it can, or puts it back the next time you show the note.',
      confirmLabel: 'Hide',
    });
    if (ok) note.hide();
  }, [confirm, conflict]);

  const removeLock = useLeanCallback(async () => {
    const ok = await confirm({
      title: 'Remove the lock?',
      message: note.comesBackHidden()
        ? 'The text goes back into the note unencrypted. It stays hidden from AI: agents cannot read it, and it opens with Show.'
        : 'The text goes back into the note unencrypted, where agents, search and sync can read it again.',
      confirmLabel: 'Remove lock',
      danger: true,
    });
    if (ok) await note.removeLock();
  }, [confirm]);

  if (!editorDoc && note.keyMissing) return <LockedNoteKeyRestore noteName={noteName(notePath)} onRestored={() => void note.show()} />;

  if (!editorDoc) {
    return (
      <EmptyState
        size="pane"
        icon={ICON_LOCK}
        title={noteName(notePath)}
        hint={error ?? 'Locked. Its text is hidden and encrypted with your master password, so agents, search and sync cannot read it.'}
        action={{ label: note.opening ? 'Opening…' : 'Show', onClick: () => void note.show(), primary: true, disabled: note.opening, testId: 'locked-note-show' }}
        testId="locked-note-hidden"
        role={error ? 'alert' : 'status'}
      />
    );
  }

  const actions = (
    <>
      <CoverButton onClick={() => void hideNow()} testId="locked-note-hide" />
      {!readOnly && (
        <button type="button" className="btn btn-icon notes-locked-remove-btn" onClick={() => void removeLock()} disabled={note.removing} aria-label="Remove the lock" title="Remove lock" data-testid="locked-note-remove-lock">
          {ICON_UNLOCK}
        </button>
      )}
    </>
  );

  return (
    <>
      {conflict && (
        <NoticeCard
          className="notes-locked-notice"
          role="alert"
          line={CONFLICT_WORDS}
          testId="locked-note-conflict"
          data={{ 'walnut-unsaved': 'A change to a locked note, not saved' }}
        >
          <div className="notes-reload-banner-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={note.keepMine} data-testid="locked-note-keep-mine">Keep mine</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={note.takeTheirs} data-testid="locked-note-take-theirs">Use the other version</button>
          </div>
        </NoticeCard>
      )}
      {error && !conflict && (
        <NoticeCard className="notes-locked-notice" role="alert" line={error} onClose={() => note.setError(null)} testId="locked-note-error" />
      )}
      <MarkdownEditorPanel
        key={editorDoc.gen}
        content={editorDoc.body}
        onEditorUpdate={note.onEditorUpdate}
        saveStatus={note.saveStatus}
        updatedAt={note.updatedAt}
        docId={notePath}
        breadcrumbPath={notePath}
        onNavigate={onNavigate}
        onLocate={onLocate}
        onBreadcrumbNavigate={onBreadcrumbNavigate}
        autoFocus={!readOnly}
        readOnly={readOnly || note.removing}
        dictation={false}
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
