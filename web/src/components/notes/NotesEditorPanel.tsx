import type { Editor } from '@tiptap/core';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import { VAULT_RAW_IO } from './vault-raw-io';
import { EmptyState, UnavailableState } from '@/components/common/EmptyState';
import { ICON_NOTE } from '@/components/common/Icons';
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
  /** Remount key of the editor (useNoteContent.remountKey): kept when the note is renamed in place. */
  remountKey?: string;
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
  /** Read only (the phone's default for a note, until Edit). */
  readOnly?: boolean;
}

export function NotesEditorPanel({
  notePath,
  remountKey,
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
  readOnly = false,
}: NotesEditorPanelProps) {
  if (!notePath) {
    return (
      <EmptyState
        size="pane"
        icon={ICON_NOTE}
        title="No note open"
        hint="Pick a note from the list, or create one."
      />
    );
  }

  return (
    <MarkdownEditorPanel
      content={content}
      onEditorUpdate={onEditorUpdate}
      saveStatus={saveStatus}
      updatedAt={updatedAt}
      docId={notePath}
      remountKey={remountKey}
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
      attachmentNotePath={notePath}
      showWidthToggle
      showRawToggle
      showFormatToolbar
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
      findPrimary
      loadingFallback={
        <UnavailableState size="pane" title="Couldn't load this note" />
      }
    />
  );
}

