import { useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MarkdownEditorPanel } from '@/components/notes/MarkdownEditorPanel';
import { VAULT_RAW_IO } from '@/components/notes/vault-raw-io';
import { useNoteContent } from '@/hooks/useNoteContent';
import { NoteMissingState } from '@/components/notes/NoteMissingState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { openPopout } from './openPopout';

/**
 * Standalone single-note editor for a pop-out window.
 *
 * Loads the note named by `?path=` via `useNoteContent` (the same hook /notes
 * uses) and renders the SHARED MarkdownEditorPanel shell — so the pop-out has the
 * exact same toolbar (width / raw / bookmark-less) + rich typography as /notes.
 * Self-contained: works with the main window closed. Last-write-wins (single user).
 *
 * Wiki-link clicks open the target note in ITS OWN pop-out.
 */
export function PopoutNote() {
  const [params, setParams] = useSearchParams();
  const notePath = params.get('path') ?? params.get('id') ?? '';
  // Opened by following a link (`create=1`): a note not written yet opens empty to write, as
  // on the Notes page; any other missing note shows as not here.
  const following = params.get('create') === '1';

  const {
    content,
    loading,
    saveStatus,
    onEditorUpdate,
    pendingExternal,
    applyExternalChange,
    dismissExternalChange,
    missing,
    createMissing,
    updatedAt,
  } = useNoteContent(notePath || null, {
    mayCreate: (p) => following && p === notePath,
    onSavedAs: (_from, to) => setParams({ path: to }, { replace: true }),
  });
  // Once the note is there, a reload of this window treats it as any other note.
  useEffect(() => {
    if (updatedAt && following) setParams((prev) => { const next = new URLSearchParams(prev); next.delete('create'); return next; }, { replace: true });
  }, [updatedAt, following, setParams]);

  useEffect(() => {
    const display = notePath.replace(/\.md$/, '') || 'Note';
    document.title = `${display} — Walnut`;
  }, [notePath]);

  const handleWikiLinkClick = useCallback((target: string) => {
    openPopout('note', { path: target, create: 1 });
  }, []);

  if (!notePath) {
    return <div style={{ padding: 24, color: 'var(--fg-muted)' }}>No note path provided.</div>;
  }
  if (missing) return <NoteMissingState path={notePath} onCreate={createMissing} onClose={() => window.close()} closeLabel="Close window" />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <MarkdownEditorPanel
        content={loading ? null : content}
        onEditorUpdate={onEditorUpdate}
        saveStatus={saveStatus}
        docId={notePath}
        breadcrumbPath={notePath}
        onNavigate={(p) => openPopout('note', { path: p, create: 1 })}
        autoFocus
        placeholder="Start writing..."
        enableWikiLinks
        enableBlockTools
        onWikiLinkClick={handleWikiLinkClick}
        attachmentNotePath={notePath}
        showWidthToggle
        showRawToggle
        showFormatToolbar
        showBreadcrumb
        pendingExternal={pendingExternal}
        onApplyExternal={applyExternalChange}
        onDismissExternal={dismissExternalChange}
        rawFlushIO={VAULT_RAW_IO}
        loadingFallback={<LoadingSpinner />}
      />
    </div>
  );
}
