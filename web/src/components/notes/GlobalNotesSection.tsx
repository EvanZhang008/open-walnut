import { useState, useRef } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';
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
  /** Own the full height of the parent panel (the todo panel's Notes tab) instead of
   *  sitting at the bottom as a fixed-height, collapsible drawer. In fill mode the
   *  collapse chevron and the drag handle are dropped — there's nothing to collapse
   *  into or resize against — and the editor flexes to the available space. */
  fill?: boolean;
}

export function GlobalNotesSection(props: GlobalNotesSectionProps) {
  const { content, onEditorUpdate, saving, saveError, collapsed: collapsedProp, toggleCollapse, popupOpen, openPopup, closePopup, tasks, focusedTaskId, onTaskClick, fill } = props;
  // Fill mode can't honor the persisted collapse flag: this IS the visible section,
  // so a stale `collapsed` from the drawer era would render an empty Notes tab.
  const collapsed = fill ? false : collapsedProp;
  const [height, setHeight] = useState(readHeight);
  const heightRef = useRef(height);
  const startH = useRef(height);
  const handleRef = useRef<HTMLDivElement>(null);

  // Keep ref in sync for use in event handlers
  heightRef.current = height;

  // The body this drag resizes IS the notes editor, which can host PDF wiki-embed
  // iframes — a downward drag puts the cursor inside them. Pointer capture keeps
  // move/up flowing to the handle instead of vanishing into the iframe.
  const { onPointerDown } = useDragGesture({
    cursor: 'row-resize',
    onStart: () => {
      startH.current = heightRef.current;
      handleRef.current?.classList.add('dragging');
    },
    // Handle sits above the body: dragging up (negative dy) grows it.
    onMove: ({ dy }) => setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH.current - dy))),
    onEnd: () => {
      handleRef.current?.classList.remove('dragging');
      // Persist latest height from ref (not stale closure value)
      try { localStorage.setItem(LS_NOTES_HEIGHT_KEY, String(heightRef.current)); } catch {}
    },
  });

  return (
    <>
      <div className={`global-notes-section${fill ? ' global-notes-section-fill' : ''}`}>
        {!collapsed && !fill && (
          <div
            ref={handleRef}
            className="global-notes-resize-handle"
            onPointerDown={onPointerDown}
            title="Drag to resize"
          />
        )}
        <div className="global-notes-header" onClick={fill ? undefined : toggleCollapse} style={fill ? { cursor: 'default' } : undefined}>
          {!fill && <span className="global-notes-chevron">{collapsed ? '\u25B8' : '\u25BE'}</span>}
          {/* In fill mode the section tab above already reads "Notes" \u2014 repeating it
              here is pure duplication. The row itself stays: it carries the
              saving/error status and the pop-out + fullscreen buttons. */}
          {!fill && <span className="global-notes-label">Notes</span>}
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
          <div className="global-notes-body" style={fill ? undefined : { height }}>
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
