import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarSidePanel } from '@/components/calendar/CalendarSidePanel';
import { useScratchpadSlot } from './ScratchpadHost';
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
  // Opening a pane takes the focus there: the agenda's close button, the scratchpad's editor
  // (opening it is a request to write in it; a reload that restores it open is not). A pane that
  // shows because the side bar moved to another page that keeps it open is no open: that page's
  // own focus stays.
  // Home's column (no place) keeps its old rule of focusing an agenda a reload restores open;
  // beside another page a restored pane leaves that page's own first focus alone.
  const was = useRef({ calendarOpen: place === undefined ? false : calendarOpen, scratchpadOpen, place });
  useEffect(() => {
    const before = was.current;
    was.current = { calendarOpen, scratchpadOpen, place };
    if (before.place !== place) return;
    if (calendarOpen && !before.calendarOpen) shellRef.current?.querySelector<HTMLButtonElement>('.cal-side-header [title="Close calendar panel"]')?.focus({ preventScroll: true });
    if (scratchpadOpen && !before.scratchpadOpen && shellRef.current) focusEditorWhenReady(shellRef.current);
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
        <ScratchpadPane open={scratchpadOpen} onClose={onCloseScratchpad} tasks={tasks} focusedTaskId={focusedTaskId} onTaskClick={onTaskClick} testId={`${testId}-scratchpad`} />
      )}
      {children}
    </aside>
  );
}

/**
 * Put the caret in the scratchpad once its editor is there: at once, or when the note's first read
 * lands and the editor mounts (until then no editor takes typing). Only while the focus is still
 * where the open left it, so a click elsewhere meanwhile is never taken back.
 */
function focusEditorWhenReady(shell: HTMLElement): void {
  const startedOn = document.activeElement;
  const tryFocus = (): boolean => {
    const editor = shell.querySelector<HTMLElement>('.home-companion-scratchpad .tiptap');
    if (!editor) return false;
    const now = document.activeElement;
    if (now === startedOn || now === document.body || now === null) editor.focus({ preventScroll: true });
    return true;
  };
  requestAnimationFrame(() => {
    if (tryFocus()) return;
    const watch = new MutationObserver(() => { if (tryFocus()) { watch.disconnect(); clearTimeout(stop); } });
    watch.observe(shell, { childList: true, subtree: true });
    const stop = setTimeout(() => watch.disconnect(), 30_000);
  });
}

/** The column's place for the window's one scratchpad editor (ScratchpadHost moves it here). */
function ScratchpadPane({ open, onClose, tasks, focusedTaskId, onTaskClick, testId }: { open: boolean; onClose: () => void; tasks: Task[]; focusedTaskId?: string; onTaskClick: (taskId: string) => void; testId: string }) {
  const slot = useRef<HTMLDivElement | null>(null);
  useScratchpadSlot(slot, open, { onClose, tasks, focusedTaskId, onTaskClick });
  return <div ref={slot} className="home-companion-body home-companion-scratchpad" data-testid={testId} style={open ? undefined : { display: 'none' }} />;
}
