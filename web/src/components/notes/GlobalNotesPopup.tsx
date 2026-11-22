import { useYieldsToTaskOpen } from '@/hooks/useOpenTask';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { createPortal } from 'react-dom';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import type { RawFlushIO } from './MarkdownEditorPanel';
import type { Editor } from '@tiptap/core';
import type { Task } from '@open-walnut/core';
import { ICON_COLLAPSE } from '@/components/common/Icons';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';

// Raw-flush cold-start IO — same shape as PopoutGlobalNotes: the raw view's
// fallback save goes through the legacy global endpoint, frontmatter-preserving.
const GLOBAL_RAW_IO: RawFlushIO = {
  read: async () => {
    const { content, contentHash } = await fetchGlobalNotes();
    return { content, contentHash };
  },
  save: (_id, content, contentHash) => saveGlobalNotes(content, contentHash),
  splitFrontmatter: true,
};

interface GlobalNotesPopupProps {
  content: string;
  onDirty: (editor: Editor) => void;
  saving: boolean;
  onClose: () => void;
  tasks?: Task[];
  focusedTaskId?: string;
}

export function GlobalNotesPopup({ content, onDirty, saving, onClose, tasks, focusedTaskId }: GlobalNotesPopupProps) {
  // Escape and the shared scroll lock; a picker inside the editor that took the key keeps it.
  useModalOverlay(onClose);
  // A task link in the notes opens on Home: the popup gives way.
  useYieldsToTaskOpen(onClose);

  return createPortal(
    <div className="notes-popup-overlay wn-scrim" role="dialog" aria-modal="true" aria-label="Global Notes" onClick={onClose}>
      <div className="notes-popup-container wn-dialog" onClick={e => e.stopPropagation()}>
        <div className="notes-popup-header wn-dialog-head">
          <span className="notes-popup-title">Global Notes</span>
          <div className="notes-popup-actions">
            {saving && <span className="notes-popup-saving">Saving...</span>}
            <button className="btn btn-icon notes-popup-close wn-dialog-close" onClick={onClose} aria-label="Collapse notes" title="Collapse notes">{ICON_COLLAPSE}</button>
          </div>
        </div>
        <div className="notes-popup-body">
          {/* saveStatus idle — the popup header already shows its own "Saving…"
              next to the collapse button, so we don't duplicate it in the shell. */}
          {/* Same feature set as PopoutGlobalNotes — both are full-width surfaces
              over the same doc; wikilinks/raw were missing here by accident. */}
          <MarkdownEditorPanel
            content={content}
            onEditorUpdate={onDirty}
            saveStatus="idle"
            docId="notes/global"
            autoFocus
            enableWikiLinks
            enableBlockTools
            showWidthToggle
            showRawToggle
            showFormatToolbar
            rawFlushIO={GLOBAL_RAW_IO}
            tasks={tasks}
            focusedTaskId={focusedTaskId}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
