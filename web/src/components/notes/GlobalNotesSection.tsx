import { useState, useRef, useCallback, useEffect } from 'react';
import { GlobalNotesPopup } from './GlobalNotesPopup';
import { NotesEditor } from './NotesEditor';
import type { UseGlobalNotesReturn } from '@/hooks/useGlobalNotes';
import type { Task } from '@open-walnut/core';
import { ICON_EXPAND, ICON_NEW_TAB } from '@/components/common/Icons';
import { openPopout } from '@/popout/openPopout';

const LS_NOTES_HEIGHT_KEY = 'open-walnut-global-notes-height';
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

interface GlobalNotesSectionProps extends UseGlobalNotesReturn {
  tasks?: Task[];
  focusedTaskId?: string;
  onTaskClick?: (taskId: string) => void;
}

export function GlobalNotesSection(props: GlobalNotesSectionProps) {
  const { content, onEditorUpdate, saving, saveError, collapsed, toggleCollapse, popupOpen, openPopup, closePopup, tasks, focusedTaskId, onTaskClick } = props;
  const [height, setHeight] = useState(readHeight);
  const heightRef = useRef(height);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);

  // Keep ref in sync for use in event handlers
  heightRef.current = height;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = heightRef.current;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    handleRef.current?.classList.add('dragging');
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH.current + delta));
      setHeight(newH);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handleRef.current?.classList.remove('dragging');
      // Persist latest height from ref (not stale closure value)
      try { localStorage.setItem(LS_NOTES_HEIGHT_KEY, String(heightRef.current)); } catch {}
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <>
      <div className="global-notes-section">
        {!collapsed && (
          <div
            ref={handleRef}
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
          {/* Open in a new browser tab (standalone, lightweight) */}
          <button
            className="global-notes-expand-btn"
            onClick={e => { e.stopPropagation(); openPopout('global-notes', {}); }}
            aria-label="Open notes in a new tab"
            title="Open in new tab"
          >
            {ICON_NEW_TAB}
          </button>
          {/* In-app fullscreen overlay (stays in this tab) */}
          <button
            className="global-notes-expand-btn"
            onClick={e => { e.stopPropagation(); openPopup(); }}
            aria-label="Expand notes to fullscreen"
            title="Fullscreen"
          >
            {ICON_EXPAND}
          </button>
        </div>
        {!collapsed && (
          <div className="global-notes-body" style={{ height }}>
            {/* Deliberate compact opt-out of MarkdownEditorPanel: this inline
                panel has its own header row and no room for the shell's
                toolbar/grip rail. The fullscreen popup/pop-out use the shell. */}
            <NotesEditor
              content={content}
              onDirty={onEditorUpdate}
              className="global-notes-editor-inline"
              tasks={tasks}
              focusedTaskId={focusedTaskId}
              onTaskClick={onTaskClick}
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
          tasks={tasks}
          focusedTaskId={focusedTaskId}
          onTaskClick={onTaskClick}
        />
      )}
    </>
  );
}
