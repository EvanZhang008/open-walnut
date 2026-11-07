import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
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
  /** The task panel's width (a CSS length): a narrow window overlays the column from that edge. */
  overlayLeft?: string;
}

/**
 * The column right of the task panel: the day agenda and the scratchpad, each toggled
 * from the rail's Home group. With both on they share the column, agenda on top.
 */
export function HomeCompanionPanel({ calendarOpen, scratchpadOpen, overlayLeft, ...rest }: Props) {
  const home = useLocation().pathname === '/';
  return (
    <CompanionColumn
      {...rest}
      calendarOpen={home && calendarOpen}
      scratchpadOpen={home && scratchpadOpen}
      className="home-companion"
      testId="home-companion"
      style={overlayLeft ? { '--home-companion-left': overlayLeft } as CSSProperties : undefined}
    />
  );
}

interface ColumnProps extends Omit<Props, 'overlayLeft'> {
  /** The column's own class (`home-companion` on Home, `page-side-bar` beside another page). */
  className: string;
  /** Prefix of the column's and its panes' test ids. */
  testId: string;
  style?: CSSProperties;
  /** Drawn after the panes (the side bar's resize handle). */
  children?: ReactNode;
  /** The page the column serves now (the side bar's), so moving to another page focuses nothing. */
  place?: string | null;
}

/**
 * The agenda and the scratchpad in one column, agenda on top, each shown while it is open.
 * Home's column and every other page's side bar (PageSideBar) are this one component.
 */
export function CompanionColumn({ calendarOpen, scratchpadOpen, onCloseCalendar, onCloseScratchpad, tasks, focusedTaskId, onTaskClick, className, testId, style, children, place }: ColumnProps) {
  const open = calendarOpen || scratchpadOpen;
  const shellRef = useRef<HTMLElement | null>(null);
  // Loaded with the page, not when the pane first opens: opening it puts the caret in the editor,
  // and typing that began before a late load landed raced the load and lost the text.
  const notes = useGlobalNotes();
  // Opening a pane takes the focus there: the agenda's close button, the scratchpad's editor
  // (opening it is a request to write in it; a reload that restores it open is not). A pane that
  // shows because the side bar moved to another page that keeps it open is no open: that page's
  // own focus stays.
  const was = useRef({ calendarOpen: false, scratchpadOpen, place });
  useEffect(() => {
    const before = was.current;
    was.current = { calendarOpen, scratchpadOpen, place };
    if (before.place !== place) return;
    if (calendarOpen && !before.calendarOpen) shellRef.current?.querySelector<HTMLButtonElement>('.cal-side-header [title="Close calendar panel"]')?.focus({ preventScroll: true });
    if (scratchpadOpen && !before.scratchpadOpen) {
      requestAnimationFrame(() => shellRef.current?.querySelector<HTMLElement>('.home-companion-scratchpad .tiptap')?.focus({ preventScroll: true }));
    }
  }, [calendarOpen, scratchpadOpen, place]);
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
      className={`${className}${calendarOpen ? ` ${className}-calendar` : ''}${scratchpadOpen ? ` ${className}-has-scratchpad` : ''}`}
      data-testid={testId}
      data-active={active}
      style={{ ...(open ? {} : { display: 'none' }), ...style }}
      inert={!open}
    >
      {visitedCalendar.current && (
        <div
          className="home-companion-body home-companion-body-calendar"
          data-testid={`${testId}-calendar`}
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
        <ScratchpadPane notes={notes} open={scratchpadOpen} onClose={onCloseScratchpad} tasks={tasks} focusedTaskId={focusedTaskId} onTaskClick={onTaskClick} testId={`${testId}-scratchpad`} />
      )}
      {children}
    </aside>
  );
}

function ScratchpadPane({ notes, open, onClose, tasks, focusedTaskId, onTaskClick, testId }: { notes: UseGlobalNotesReturn; open: boolean; onClose: () => void; tasks: Task[]; focusedTaskId?: string; onTaskClick: (taskId: string) => void; testId: string }) {
  return (
    <div className="home-companion-body home-companion-scratchpad" data-testid={testId} style={open ? undefined : { display: 'none' }}>
      <GlobalNotesSection {...notes} fill title="Scratchpad" onClose={onClose} tasks={tasks} focusedTaskId={focusedTaskId} onTaskClick={onTaskClick} />
    </div>
  );
}
