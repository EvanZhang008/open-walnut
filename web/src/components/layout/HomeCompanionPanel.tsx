import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarSidePanel } from '@/components/calendar/CalendarSidePanel';
import { GlobalNotesSection } from '@/components/notes/GlobalNotesSection';
import { useGlobalNotes, type UseGlobalNotesReturn } from '@/hooks/useGlobalNotes';
import type { Task } from '@open-walnut/core';

interface Props {
  calendarOpen: boolean;
  scratchpadOpen: boolean;
  onCloseCalendar: () => void;
  onCloseScratchpad: () => void;
  /** For the scratchpad's task links. */
  tasks: Task[];
  focusedTaskId?: string;
  onTaskClick: (taskId: string) => void;
}

/**
 * The column beside the home conversation: the day agenda and the scratchpad, each toggled
 * from the rail's Home group. With both on they share the column, agenda on top.
 */
export function HomeCompanionPanel({ calendarOpen: calendarRequested, scratchpadOpen: scratchpadRequested, onCloseCalendar, onCloseScratchpad, tasks, focusedTaskId, onTaskClick }: Props) {
  const home = useLocation().pathname === '/';
  const calendarOpen = home && calendarRequested;
  const scratchpadOpen = home && scratchpadRequested;
  const open = calendarOpen || scratchpadOpen;
  const shellRef = useRef<HTMLElement | null>(null);
  // Loaded with the page, not when the pane first opens: opening it puts the caret in the editor,
  // and typing that began before a late load landed raced the load and lost the text.
  const notes = useGlobalNotes();
  useEffect(() => {
    if (calendarOpen) shellRef.current?.querySelector<HTMLButtonElement>('.cal-side-header [title="Close calendar panel"]')?.focus({ preventScroll: true });
  }, [calendarOpen]);
  // Opening the scratchpad is a request to write in it; a reload that restores it open is not.
  const scratchpadWasOpen = useRef(scratchpadOpen);
  useEffect(() => {
    if (scratchpadOpen && !scratchpadWasOpen.current) {
      requestAnimationFrame(() => shellRef.current?.querySelector<HTMLElement>('.home-companion-scratchpad .tiptap')?.focus({ preventScroll: true }));
    }
    scratchpadWasOpen.current = scratchpadOpen;
  }, [scratchpadOpen]);
  // Each pane stays mounted once shown, so the chosen day, an open create form and the
  // editor's undo history survive closing it.
  const visitedCalendar = useRef(false);
  const visitedScratchpad = useRef(false);
  if (calendarOpen) visitedCalendar.current = true;
  if (scratchpadOpen) visitedScratchpad.current = true;
  if (!visitedCalendar.current && !visitedScratchpad.current) return null;

  const active = [calendarOpen && 'calendar', scratchpadOpen && 'scratchpad'].filter(Boolean).join(' ') || 'none';
  return (
    <aside
      ref={shellRef}
      aria-label={calendarOpen && !scratchpadOpen ? 'Calendar side panel' : scratchpadOpen && !calendarOpen ? 'Scratchpad' : 'Home side panel'}
      className={`home-companion${calendarOpen ? ' home-companion-calendar' : ''}${scratchpadOpen ? ' home-companion-has-scratchpad' : ''}`}
      data-testid="home-companion"
      data-active={active}
      style={open ? undefined : { display: 'none' }}
      inert={!open}
    >
      {visitedCalendar.current && (
        <div
          className="home-companion-body home-companion-body-calendar"
          data-testid="home-companion-calendar"
          style={calendarOpen ? undefined : { display: 'none' }}
          onKeyDown={event => {
            // Escape closes the agenda; the scratchpad is a typing surface and keeps its Escape.
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (document.querySelector('.cal-popover-backdrop')) return;
            event.stopPropagation();
            onCloseCalendar();
          }}
        >
          <CalendarSidePanel onClose={onCloseCalendar} active={calendarOpen} width="100%" />
        </div>
      )}
      {visitedScratchpad.current && (
        <ScratchpadPane notes={notes} open={scratchpadOpen} onClose={onCloseScratchpad} tasks={tasks} focusedTaskId={focusedTaskId} onTaskClick={onTaskClick} />
      )}
    </aside>
  );
}

function ScratchpadPane({ notes, open, onClose, tasks, focusedTaskId, onTaskClick }: { notes: UseGlobalNotesReturn; open: boolean; onClose: () => void; tasks: Task[]; focusedTaskId?: string; onTaskClick: (taskId: string) => void }) {
  return (
    <div className="home-companion-body home-companion-scratchpad" data-testid="home-companion-scratchpad" style={open ? undefined : { display: 'none' }}>
      <GlobalNotesSection {...notes} fill title="Scratchpad" onClose={onClose} tasks={tasks} focusedTaskId={focusedTaskId} onTaskClick={onTaskClick} />
    </div>
  );
}
