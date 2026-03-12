/**
 * React portal that renders the slash command floating panel at the cursor
 * position. Manages the state machine: commands -> task-search -> closed.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { Task } from '@walnut/core';
import type { SlashCommandState, NoteSlashCommand, SlashRange } from './types';
import { SlashCommandMenu } from './SlashCommandMenu';
import { TaskSearchPanel } from './TaskSearchPanel';

interface SlashCommandPortalProps {
  editor: Editor;
  state: SlashCommandState;
  tasks: Task[];
  focusedTaskId?: string;
  onClose: () => void;
}

export function SlashCommandPortal({ editor, state, tasks, focusedTaskId, onClose }: SlashCommandPortalProps) {
  const [subPanel, setSubPanel] = useState<'task-search' | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  // Store the range when transitioning to sub-panels (range is lost from state)
  const rangeRef = useRef<SlashRange | null>(null);

  // Update range ref whenever we get a range from the extension
  useEffect(() => {
    if (state.phase !== 'closed' && 'range' in state) {
      rangeRef.current = state.range;
    }
  }, [state]);

  // Reset sub-panel and coords when the slash command state closes
  useEffect(() => {
    if (state.phase === 'closed') {
      setSubPanel(null);
      setCoords(null);
    }
  }, [state.phase]);

  // Calculate cursor position for panel placement.
  // Default: panel appears ABOVE the "/" (like editor autocomplete).
  // Falls back to below if not enough space above.
  useEffect(() => {
    if (state.phase === 'closed') return;
    const range = 'range' in state ? state.range : rangeRef.current;
    if (!range) return;

    try {
      const c = editor.view.coordsAtPos(range.from);

      // Measure actual panel height after render (fallback to estimate)
      const panelH = panelRef.current?.getBoundingClientRect().height || 120;

      // Prefer above: anchor bottom of panel to top of "/" line
      const aboveTop = c.top - panelH - 4;
      // Fallback below: anchor top of panel to bottom of "/" line
      const belowTop = c.bottom + 4;

      const top = aboveTop >= 0 ? aboveTop : belowTop;
      setCoords({ left: c.left, top });
    } catch {
      // coordsAtPos can fail for invalid positions — panel stays hidden
    }
  }, [state, editor]);

  // Close when clicking outside the panel (only when visible)
  useEffect(() => {
    if (state.phase === 'closed') return;

    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [state.phase, onClose]);

  const handleCommandSelect = useCallback((cmd: NoteSlashCommand) => {
    if (cmd.action === 'task-search') {
      setSubPanel('task-search');
    }
  }, []);

  // Handle task selection — validate range, insert link, close
  const handleTaskSelect = useCallback((task: Task) => {
    const range = rangeRef.current;
    if (!range) { onClose(); return; }

    // Validate range is still within document bounds
    const docSize = editor.state.doc.content.size;
    if (range.from >= docSize || range.to > docSize) { onClose(); return; }

    const label = task.project && task.project !== task.category
      ? `${task.project} / ${task.title}`
      : task.title;

    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent([
        {
          type: 'text',
          marks: [{ type: 'link', attrs: { href: `/tasks/${task.id}` } }],
          text: label,
        },
        { type: 'text', text: ' ' },
      ])
      .run();

    onClose();
  }, [editor, onClose]);

  // Back from task-search -> command list
  const handleBack = useCallback(() => {
    setSubPanel(null);
    editor.commands.focus();
  }, [editor]);

  if (state.phase === 'closed' || !coords) return null;

  const panel = subPanel === 'task-search' ? (
    <TaskSearchPanel
      tasks={tasks}
      focusedTaskId={focusedTaskId}
      onSelect={handleTaskSelect}
      onBack={handleBack}
    />
  ) : state.phase === 'commands' ? (
    <SlashCommandMenu
      query={state.query}
      onSelect={handleCommandSelect}
      onClose={onClose}
    />
  ) : null;

  if (!panel) return null;

  return createPortal(
    <div
      ref={panelRef}
      className="notes-slash-portal"
      style={{ position: 'fixed', left: coords.left, top: coords.top, zIndex: 10001 }}
    >
      {panel}
    </div>,
    document.body,
  );
}
