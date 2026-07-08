import type { Editor } from '@tiptap/core';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import { VAULT_RAW_IO } from './vault-raw-io';
import type { PendingExternalChange } from '@/hooks/useNoteContent';

/**
 * NotesEditorPanel — the /notes-page binding of the shared MarkdownEditorPanel
 * shell. It supplies the vault-specific configuration (full chrome: width, raw,
 * bookmark, breadcrumb, backlinks; wikilinks + #tags on; frontmatter-preserving
 * raw-flush IO) and is driven by NotesPage, which owns useNoteContent.
 *
 * The shell (MarkdownEditorPanel) is reused by every other surface — pop-outs,
 * the global-notes widget/popup, task/memory panels — so the editor + toolbar
 * stay identical everywhere.
 */

interface NotesEditorPanelProps {
  notePath: string | null;
  content: string | null;
  updatedAt: string | null;
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  onEditorUpdate: (editor: Editor) => void;
  onNavigate: (path: string) => void;
  /** Locate the current note in the sidebar tree (#1 button). */
  onLocate?: () => void;
  /** Reveal a breadcrumb folder segment in the sidebar tree (#4). */
  onBreadcrumbNavigate?: (folderPath: string) => void;
  /**
   * Set when an external/AI write (or a true 409 conflict) was DEFERRED while the
   * editor was dirty (§6.2 dirty-guard). Drives the non-destructive reload banner.
   */
  pendingExternal?: PendingExternalChange | null;
  onApplyExternal?: () => void;
  onDismissExternal?: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
}

export function NotesEditorPanel({
  notePath,
  content,
  updatedAt,
  saveStatus,
  onEditorUpdate,
  onNavigate,
  onLocate,
  onBreadcrumbNavigate,
  pendingExternal,
  onApplyExternal,
  onDismissExternal,
  isFavorite,
  onToggleFavorite,
}: NotesEditorPanelProps) {
  if (!notePath) {
    return (
      <div className="notes-editor-empty">
        <div className="notes-editor-empty-content">
          <NotepadIcon />
          <p>Select a note or create a new one</p>
        </div>
      </div>
    );
  }

  return (
    <MarkdownEditorPanel
      content={content}
      onEditorUpdate={onEditorUpdate}
      saveStatus={saveStatus}
      updatedAt={updatedAt}
      docId={notePath}
      breadcrumbPath={notePath}
      onNavigate={onNavigate}
      onLocate={onLocate}
      onBreadcrumbNavigate={onBreadcrumbNavigate}
      autoFocus
      placeholder="Start writing..."
      enableWikiLinks
      enableBlockTools
      onWikiLinkClick={onNavigate}
      attachmentNotePath={notePath}
      showWidthToggle
      showRawToggle
      showBookmark
      showLocate
      showBreadcrumb
      showBacklinks
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      pendingExternal={pendingExternal}
      onApplyExternal={onApplyExternal}
      onDismissExternal={onDismissExternal}
      rawFlushIO={VAULT_RAW_IO}
      loadingFallback={
        <div className="notes-editor-empty">
          <div className="notes-editor-empty-content"><p>Failed to load note</p></div>
        </div>
      }
    />
  );
}

function NotepadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" opacity="0.3">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}
