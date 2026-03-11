import { useState, useRef, useCallback, useEffect } from 'react';
import { GlobalNotesPopup } from './GlobalNotesPopup';
import { NotesEditor } from './NotesEditor';
import type { UseGlobalNotesReturn } from '@/hooks/useGlobalNotes';

const LS_NOTES_HEIGHT_KEY = 'walnut-global-notes-height';
const DEFAULT_HEIGHT = 180;
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 500;

function readHeight(): number {
  try {
    const v = localStorage.getItem(LS_NOTES_HEIGHT_KEY);
    if (v) return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parseInt(v, 10)));
  } catch {}
  return DEFAULT_HEIGHT;
}

export function GlobalNotesSection(props: UseGlobalNotesReturn) {
  const { content, onEditorUpdate, saving, saveError, collapsed, toggleCollapse, popupOpen, openPopup, closePopup } = props;
  const [height, setHeight] = useState(readHeight);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [height]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      // Dragging UP increases notes height (panel grows upward)
      const delta = startY.current - e.clientY;
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH.current + delta));
      setHeight(newH);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist
      try { localStorage.setItem(LS_NOTES_HEIGHT_KEY, String(height)); } catch {}
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [height]);

  return (
    <>
      <div className="global-notes-section">
        {!collapsed && (
          <div
            className="global-notes-resize-handle"
            onMouseDown={onMouseDown}
            title="Drag to resize"
          />
        )}
        <div className="global-notes-header" onClick={toggleCollapse}>
          <span className="global-notes-chevron">{collapsed ? '\u25B8' : '\u25BE'}</span>
          <span className="global-notes-label">Notes</span>
          {saving && <span className="global-notes-saving">Saving...</span>}
          {saveError && <span className="global-notes-error" title={saveError}>Save failed</span>}
          <button
            className="global-notes-expand-btn"
            onClick={e => { e.stopPropagation(); openPopup(); }}
            aria-label="Expand notes"
            title="Expand notes"
          >
            &#x26F6;
          </button>
        </div>
        {!collapsed && (
          <div className="global-notes-body" style={{ height }}>
            <NotesEditor
              content={content}
              onDirty={onEditorUpdate}
              editing={saving}
              className="global-notes-editor-inline"
            />
          </div>
        )}
      </div>
      {popupOpen && (
        <GlobalNotesPopup
          content={content}
          onDirty={onEditorUpdate}
          saving={saving}
          onClose={closePopup}
        />
      )}
    </>
  );
}
