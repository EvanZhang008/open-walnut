import { useEffect } from 'react';
import { useGlobalNotes } from '@/hooks/useGlobalNotes';
import { MarkdownEditorPanel } from '@/components/notes/MarkdownEditorPanel';
import type { RawFlushIO } from '@/components/notes/MarkdownEditorPanel';
import { fetchGlobalNotes, saveGlobalNotes } from '@/api/notes';

// Global notes save through the memory API; the raw-flush cold-start fallback
// uses the same endpoint, frontmatter-preserving (id stamped into global-notes.md).
const GLOBAL_RAW_IO: RawFlushIO = {
  read: async () => {
    const { content, contentHash } = await fetchGlobalNotes();
    return { content, contentHash };
  },
  save: (_id, content, contentHash) => saveGlobalNotes(content, contentHash),
  splitFrontmatter: true,
};

/**
 * Standalone global-notes editor for a pop-out window.
 *
 * Self-contained: `useGlobalNotes` loads the global note on mount, autosaves
 * (debounced), and stays in sync with external/agent writes over the same
 * WebSocket — so this editor works even when the main window is closed.
 *
 * Renders the SHARED MarkdownEditorPanel shell so the fullscreen pop-out gets the
 * SAME toolbar (width / raw) + rich typography as /notes — no longer the compact
 * `global-notes-editor-popup` downgrade. Block tools + wikilinks/#tags on since
 * the pop-out is a full-width surface.
 */
export function PopoutGlobalNotes() {
  const { content, onEditorUpdate, saving, saveError } = useGlobalNotes();

  useEffect(() => {
    document.title = 'Global Notes — Walnut';
  }, []);

  const saveStatus = saveError ? 'error' : saving ? 'saving' : 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <MarkdownEditorPanel
        content={content}
        onEditorUpdate={onEditorUpdate}
        saveStatus={saveStatus}
        docId="notes/global"
        autoFocus
        enableWikiLinks
        enableBlockTools
        showWidthToggle
        showRawToggle
        showFormatToolbar
        rawFlushIO={GLOBAL_RAW_IO}
      />
    </div>
  );
}
