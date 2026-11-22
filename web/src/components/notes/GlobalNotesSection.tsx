import { useEffect, useState, useRef } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import type { Editor } from '@tiptap/react';
import { useDragGesture } from '@/hooks/useDragGesture';
import { GlobalNotesPopup } from './GlobalNotesPopup';
import { NotesEditor } from './NotesEditor';
import type { UseGlobalNotesReturn } from '@/hooks/useGlobalNotes';
import type { Task } from '@open-walnut/core';
import { ICON_EXPAND, ICON_NEW_TAB, ICON_NOTE } from '@/components/common/Icons';
import { openPopout } from '@/popout/openPopout';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';

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
  /** Own the full height of the parent panel (the todo panel's Notes tab) instead of
   *  sitting at the bottom as a fixed-height, collapsible drawer. In fill mode the
   *  collapse chevron and the drag handle are dropped — there's nothing to collapse
   *  into or resize against — and the editor flexes to the available space. */
  fill?: boolean;
  /** Fill mode's header names the panel (the home Scratchpad column, which has no tab above it). */
  title?: string;
  /** A × at the end of the header, for a panel the user opened and closes. */
  onClose?: () => void;
}

export function GlobalNotesSection(props: GlobalNotesSectionProps) {
  const { content, onEditorUpdate, saving, saveError, loaded, loadError, retryLoad, collapsed: collapsedProp, toggleCollapse, popupOpen, openPopup, closePopup, tasks, focusedTaskId, fill, title, onClose } = props;
  // Fill mode can't honor the persisted collapse flag: this IS the visible section,
  // so a stale `collapsed` from the drawer era would render an empty Notes tab.
  const collapsed = fill ? false : collapsedProp;
  const [height, setHeight] = useState(readHeight);
  // An empty scratchpad says it is loaded and empty (2026-11-21 UI audit: a blank pane with a faint
  // placeholder looked unloaded). It goes with the first character typed, without moving the text.
  const [blank, setBlank] = useState(() => content.trim() === '');
  useEffect(() => { setBlank(content.trim() === ''); }, [content]);
  const onDirty = useLeanCallback((editor: Editor) => { setBlank(editor.isEmpty); onEditorUpdate(editor); }, [onEditorUpdate]);
  const bodyRef = useRef<HTMLDivElement>(null);
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
    onMove: ({ dy }) => {
      heightRef.current = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startH.current - dy));
      setHeight(heightRef.current);
    },
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
          {(!fill || title) && <span className="global-notes-label">{fill ? title : 'Notes'}</span>}
          {saving && <span className="global-notes-saving">Saving...</span>}
          {saveError && <span className="global-notes-error" title={saveError}>Save failed</span>}
          {/* Open in a new browser tab (standalone, lightweight) */}
          <button
            className="btn btn-icon btn-sm global-notes-expand-btn"
            onClick={e => { e.stopPropagation(); openPopout('global-notes', {}); }}
            aria-label="Open notes in a new tab"
            title="Open in new tab"
          >
            {ICON_NEW_TAB}
          </button>
          {/* In-app fullscreen overlay (stays in this tab) */}
          <button
            className="btn btn-icon btn-sm global-notes-expand-btn"
            onClick={e => { e.stopPropagation(); openPopup(); }}
            aria-label="Expand notes to fullscreen"
            title="Fullscreen"
          >
            {ICON_EXPAND}
          </button>
          {onClose && (
            <button
              className="btn btn-icon btn-sm global-notes-expand-btn"
              onClick={e => { e.stopPropagation(); onClose(); }}
              aria-label={`Close ${title ?? 'notes'}`}
              title={`Close ${title ?? 'notes'}`}
            >
              ×
            </button>
          )}
        </div>
        {!collapsed && (
          <div ref={bodyRef} className="global-notes-body" style={fill ? undefined : { height }}>
            {/* Deliberate compact opt-out of MarkdownEditorPanel: this inline
                panel has its own header row and no room for the shell's
                toolbar/grip rail. The fullscreen popup/pop-out use the shell. */}
            {loaded ? (
              <>
                <NotesEditor
                  content={content}
                  onDirty={onDirty}
                  // The empty state over it says what the place is; no second line under it.
                  placeholder=""
                  className="global-notes-editor-inline"
                  tasks={tasks}
                  focusedTaskId={focusedTaskId}
                />
                {blank && (
                  // Over the empty editor, never in its flow; a click on it puts the caret in the editor (and
                  // goes straight through while it has focus: globals.css).
                  <div
                    className="global-notes-empty-cover"
                    onMouseDown={(e) => { e.preventDefault(); bodyRef.current?.querySelector<HTMLElement>('.tiptap')?.focus(); }}
                  >
                    <EmptyState
                      size="pane"
                      testId="global-notes-empty"
                      icon={ICON_NOTE}
                      title={`Your ${(title ?? 'notes').toLowerCase()} is empty`}
                      hint="Click to write. Markdown works, and it saves as you go."
                    />
                  </div>
                )}
              </>
            ) : (
              // No editor before the note is read: typing into an empty one would save over it.
              loadError
                ? <UnavailableState size="section" title="Couldn't load the scratchpad" onRetry={retryLoad} testId="global-notes-loading" />
                : <LoadingState size="section" title="Loading the scratchpad…" testId="global-notes-loading" />
            )}
          </div>
        )}
      </div>
      {popupOpen && loaded && (
        <GlobalNotesPopup
          content={content}
          onDirty={onEditorUpdate}
          saving={saving}
          onClose={closePopup}
          tasks={tasks}
          focusedTaskId={focusedTaskId}
        />
      )}
    </>
  );
}
