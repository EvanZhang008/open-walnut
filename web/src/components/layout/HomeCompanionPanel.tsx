import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { CalendarSidePanel } from '@/components/calendar/CalendarSidePanel';
import { useDragGesture } from '@/hooks/useDragGesture';
import { useScratchpadSlot } from './ScratchpadHost';
import { SIDE_BAR_LAYOUT_EVENT, SIDE_BAR_WIDTH_MIN, paneWidth, sideBarWidth, usePageSideBar, type SideBarPane } from './page-side-bar';
import type { Task } from '@open-walnut/core';

interface Props {
  calendarOpen: boolean;
  scratchpadOpen: boolean;
  onCloseCalendar: () => void;
  onCloseScratchpad: () => void;
  /** For the scratchpad's /task search. */
  tasks: Task[];
  focusedTaskId?: string;
  /** The task panel's width (a CSS length): a narrow window overlays the column from that edge. */
  overlayLeft?: string;
}

/**
 * The side bars right of the task panel: the day agenda and the scratchpad, each toggled
 * from the rail's Home group. With both on they sit side by side, the scratchpad on the right.
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
  /** The row's own class (`home-companion` on Home, `page-side-bar` beside another page). */
  className: string;
  /** Prefix of the row's and its panes' test ids. */
  testId: string;
  style?: CSSProperties;
  /** The page the side bars serve now (PageSideBar's; null or absent on Home): moving to another
   *  page focuses nothing, and each page keeps its own widths. */
  place?: string | null;
}

/**
 * The agenda and the scratchpad as two independent side bars in one row, each shown while it is
 * open, the scratchpad right of the agenda (2026-11-16, the user: "side bar should be independent,
 * new one on the right, instead of top and bottom"). Each has its own width, dragged on its own
 * right edge and kept per page (page-side-bar.ts), and its own scrolling. Home's side bars and
 * every other page's (PageSideBar) are this one component.
 */
export function CompanionColumn({ calendarOpen, scratchpadOpen, onCloseCalendar, onCloseScratchpad, tasks, focusedTaskId, className, testId, style, place }: ColumnProps) {
  const open = calendarOpen || scratchpadOpen;
  const shellRef = useRef<HTMLElement | null>(null);
  const { view, setWidth } = usePageSideBar(place ?? null);
  const windowWidth = useWindowWidth();
  const paired = calendarOpen && scratchpadOpen;
  const agendaWidth = paneWidth(view, 'agenda', windowWidth, paired);
  const scratchpadWidth = paneWidth(view, 'scratchpad', windowWidth, paired);
  // The full screen area starts beside the side bars (AppShell): tell it when they moved. A drag
  // in progress tells it too (PaneShell).
  useLayoutEffect(() => { window.dispatchEvent(new Event(SIDE_BAR_LAYOUT_EVENT)); }, [calendarOpen, scratchpadOpen, agendaWidth, scratchpadWidth]);
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
        <PaneShell pane="agenda" open={calendarOpen} width={agendaWidth} paired={paired} onWidth={setWidth} testId={`${testId}-calendar`}>
          <div
            className="home-companion-body home-companion-body-calendar"
            data-testid={`${testId}-calendar`}
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
        </PaneShell>
      )}
      {visitedScratchpad.current && (
        <PaneShell pane="scratchpad" open={scratchpadOpen} width={scratchpadWidth} paired={paired} onWidth={setWidth} testId={`${testId}-scratchpad`}>
          <ScratchpadPane open={scratchpadOpen} onClose={onCloseScratchpad} tasks={tasks} focusedTaskId={focusedTaskId} testId={`${testId}-scratchpad`} />
        </PaneShell>
      )}
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

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

const PANE_LABEL: Record<SideBarPane, string> = { agenda: 'Resize agenda', scratchpad: 'Resize scratchpad' };

/**
 * One side bar: its pane, as wide as it was kept, and the resize handle on its right edge. A drag
 * widens only this side bar (the width shows on the element while it runs) and is kept once, when
 * it ends; the arrow keys widen and narrow it 16px a press.
 */
function PaneShell({ pane, open, width, paired, onWidth, testId, children }: {
  pane: SideBarPane;
  open: boolean;
  width: number;
  paired: boolean;
  onWidth: (pane: SideBarPane, width: number) => void;
  testId: string;
  children: ReactNode;
}) {
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const startRef = useRef(width);
  const latestRef = useRef<number | null>(null);
  const { onPointerDown } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => { startRef.current = width; latestRef.current = null; },
    onMove: ({ dx }) => {
      const next = sideBarWidth(startRef.current + dx, window.innerWidth, paired);
      latestRef.current = next;
      setDragWidth(next);
    },
    onEnd: ({ canceled }) => {
      const final = latestRef.current;
      setDragWidth(null);
      // A width the window's cap holds where it is writes nothing: the wider kept one stays.
      if (!canceled && final !== null && final !== width) onWidth(pane, final);
    },
  });
  const shown = dragWidth ?? width;
  useLayoutEffect(() => { if (dragWidth !== null) window.dispatchEvent(new Event(SIDE_BAR_LAYOUT_EVENT)); }, [dragWidth]);
  return (
    <div
      className={`side-bar-pane side-bar-pane-${pane}`}
      data-testid={`${testId}-bar`}
      style={{ '--side-bar-pane-width': `${shown}px`, ...(open ? {} : { display: 'none' }) } as CSSProperties}
    >
      {children}
      <div
        className={`side-bar-pane-resize${dragWidth !== null ? ' resizing' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={PANE_LABEL[pane]}
        aria-valuenow={shown}
        aria-valuemin={SIDE_BAR_WIDTH_MIN}
        aria-valuemax={sideBarWidth(Number.MAX_SAFE_INTEGER, window.innerWidth, paired)}
        tabIndex={0}
        data-testid={`${testId}-resize`}
        onPointerDown={onPointerDown}
        onKeyDown={(event) => {
          const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
          if (!step) return;
          event.preventDefault();
          const next = sideBarWidth(width + step, window.innerWidth, paired);
          if (next !== width) onWidth(pane, next);
        }}
      />
    </div>
  );
}

/** The side bar's place for the window's one scratchpad editor (ScratchpadHost moves it here). */
function ScratchpadPane({ open, onClose, tasks, focusedTaskId, testId }: { open: boolean; onClose: () => void; tasks: Task[]; focusedTaskId?: string; testId: string }) {
  const slot = useRef<HTMLDivElement | null>(null);
  useScratchpadSlot(slot, open, { onClose, tasks, focusedTaskId });
  return <div ref={slot} className="home-companion-body home-companion-scratchpad" data-testid={testId} />;
}
