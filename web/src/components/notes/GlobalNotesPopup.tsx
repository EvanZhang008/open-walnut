import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { NotesEditor } from './NotesEditor';
import type { Editor } from '@tiptap/core';

interface GlobalNotesPopupProps {
  content: string;
  onDirty: (editor: Editor) => void;
  saving: boolean;
  onClose: () => void;
}

export function GlobalNotesPopup({ content, onDirty, saving, onClose }: GlobalNotesPopupProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown]);

  return createPortal(
    <div className="notes-popup-overlay" role="dialog" aria-modal="true" aria-label="Global Notes" onClick={onClose}>
      <div className="notes-popup-container" onClick={e => e.stopPropagation()}>
        <div className="notes-popup-header">
          <span className="notes-popup-title">Global Notes</span>
          <div className="notes-popup-actions">
            {saving && <span className="notes-popup-saving">Saving...</span>}
            <button className="notes-popup-close" onClick={onClose} aria-label="Close">&times;</button>
          </div>
        </div>
        <div className="notes-popup-body">
          <NotesEditor
            content={content}
            onDirty={onDirty}
            editing={saving}
            className="global-notes-editor-popup"
            autoFocus
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
