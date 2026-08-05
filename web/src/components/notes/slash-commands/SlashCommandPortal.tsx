/**
 * React portal that renders the slash command floating panel at the cursor
 * position. Manages the state machine: commands -> (task-search | note-link) ->
 * closed. Block-insert commands run inline via cmd.run() and close immediately.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import type { Task } from '@open-walnut/core';
import type { NoteListItem } from '@/api/notes-v2';
import type { SlashCommandState, NoteSlashCommand, SlashRange } from './types';
import { SlashCommandMenu } from './SlashCommandMenu';
import { TaskSearchPanel } from './TaskSearchPanel';
import { NoteLinkPanel } from './NoteLinkPanel';

interface SlashCommandPortalProps {
  editor: Editor;
  state: SlashCommandState & { atBlockStart?: boolean };
  tasks: Task[];
  focusedTaskId?: string;
  /** Notes for the "Link to note" sub-panel (Obsidian-native [[Title]] insert). */
  wikiLinkNotes?: NoteListItem[];
  onClose: () => void;
}

export function SlashCommandPortal({ editor, state, tasks, focusedTaskId, wikiLinkNotes, onClose }: SlashCommandPortalProps) {
  const [subPanel, setSubPanel] = useState<'task-search' | 'note-link' | null>(null);
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
      const panelH = panelRef.current?.getBoundingClientRect().height || 120;
      const aboveTop = c.top - panelH - 4;
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
    // Block-insert commands run immediately as one transaction, then close.
    if (cmd.run) {
      const range = rangeRef.current;
      if (range) {
        const docSize = editor.state.doc.content.size;
        if (range.from < docSize && range.to <= docSize) {
          cmd.run(editor, range);
        }
      }
      onClose();
      return;
    }
    // Reference commands open a secondary panel.
    if (cmd.subPanel === 'task-search') setSubPanel('task-search');
    else if (cmd.subPanel === 'note-link') setSubPanel('note-link');
  }, [editor, onClose]);

  // Handle task selection — validate range, insert link, close
  const handleTaskSelect = useCallback((task: Task) => {
    const range = rangeRef.current;
    if (!range) { onClose(); return; }

    const docSize = editor.state.doc.content.size;
    if (range.from >= docSize || range.to > docSize) { onClose(); return; }

    const label = task.project
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

  // Handle note-link selection — insert Obsidian-native [[Title]] (plain text).
  const handleNoteLinkSelect = useCallback((noteName: string) => {
    const range = rangeRef.current;
    if (!range) { onClose(); return; }
    const docSize = editor.state.doc.content.size;
    if (range.from >= docSize || range.to > docSize) { onClose(); return; }

    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent(`[[${noteName}]] `)
      .run();

    onClose();
  }, [editor, onClose]);

  // Back from a sub-panel -> command list
  const handleBack = useCallback(() => {
    setSubPanel(null);
    editor.commands.focus();
  }, [editor]);

  if (state.phase === 'closed' || !coords) return null;

  let panel: React.ReactNode = null;
  if (subPanel === 'task-search') {
    panel = (
      <TaskSearchPanel
        tasks={tasks}
        focusedTaskId={focusedTaskId}
        onSelect={handleTaskSelect}
        onBack={handleBack}
      />
    );
  } else if (subPanel === 'note-link') {
    panel = (
      <NoteLinkPanel
        notes={wikiLinkNotes ?? []}
        onSelect={handleNoteLinkSelect}
        onBack={handleBack}
      />
    );
  } else if (state.phase === 'commands') {
    panel = (
      <SlashCommandMenu
        query={state.query}
        atBlockStart={state.atBlockStart ?? true}
        onSelect={handleCommandSelect}
        onClose={onClose}
      />
    );
  }

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
