/**
 * A Waiting task's wait, as one chip in the session header's title row, on the
 * left beside the title, apart from the status pills on the right (2026-10-31,
 * the user: the wait was a bar above the composer; "put it up with the task and
 * its tags, on the left ... hover shows the details").
 *
 *   chip   "Wait until Mon 6:53" (or "Waiting" with no clock)
 *   card   on hover, focus or a tap: when it wakes by itself, on whom or what it
 *          waits, its triggers, and that a message here moves it to In Progress
 *
 * Overlay rules (web/src/AGENTS.md): the card is portalled to <body>, placed by
 * useMenuPlacement, stops pointerdown, and closes on an outside pointerdown,
 * Escape, or the pointer leaving both the chip and the card.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useTaskTriggers } from '@/hooks/useTaskTriggers';
import { triggerPillTitle } from '@/components/routines/TriggerPill';
import { formatWaitUntil, WAIT_UNTIL_ICON } from './TaskStatusControl';
import '@/styles/task-status.css';

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 200;

/** The chip's words. */
export function waitingChipLabel(task: Pick<Task, 'phase' | 'wait_until'>): string {
  if (task.phase !== 'WAITING') return '';
  const until = formatWaitUntil(task.wait_until);
  return until ? `Wait until ${until}` : 'Waiting';
}

/** The card's lines, in reading order (also the chip's hover text). */
export function waitingDetailLines(
  task: Pick<Task, 'phase' | 'wait_until' | 'user_status'>,
  triggersText = '',
): string[] {
  if (task.phase !== 'WAITING') return [];
  const lines: string[] = [];
  lines.push(task.wait_until
    ? `Wakes by itself ${new Date(task.wait_until).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, or sooner when something happens.`
    : 'No clock: it waits until something happens (a trigger fires, a message arrives).');
  const on = task.user_status?.waitingOn?.trim();
  if (on) lines.push(`Waiting on ${on}.`);
  const next = task.user_status?.next?.trim();
  if (next) lines.push(`Next: ${next}`);
  for (const t of triggersText.split('\n').map((l) => l.trim()).filter(Boolean)) lines.push(`Trigger ${t}`);
  lines.push('A message here moves it to In Progress.');
  return lines;
}

/**
 * `compact`: the phone's top bar, where the title is centred over the whole bar:
 * an hourglass only (its words are the card's head and the label), so the bar
 * widens the title's gutters by one button and nothing overlaps.
 */
export function WaitingChip({ task, compact = false }: { task: Task | null | undefined; compact?: boolean }) {
  const triggers = useTaskTriggers(task?.phase === 'WAITING' ? task.id : undefined);
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const byClick = useRef(false);
  const placement = useMenuPlacement(open, chipRef, cardRef, {
    align: 'start', preferSide: 'down', minHeight: 80, onAnchorLost: () => setOpen(false),
  });

  const later = useCallback((next: boolean, ms: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; setOpen(next); }, ms);
  }, []);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!open) { byClick.current = false; return; }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (chipRef.current?.contains(target) || cardRef.current?.contains(target))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!task || task.phase !== 'WAITING') return null;
  const label = waitingChipLabel(task);
  const lines = waitingDetailLines(task, triggerPillTitle(triggers));
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`task-waiting-chip${compact ? ' is-compact' : ''}`}
        data-testid="session-waiting-chip"
        aria-label={`${label}. ${lines.join(' ')}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => later(true, OPEN_DELAY_MS)}
        onMouseLeave={() => later(false, CLOSE_DELAY_MS)}
        onFocus={() => setOpen(true)}
        onBlur={() => later(false, CLOSE_DELAY_MS)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // A click on a card the hover already opened keeps it; otherwise it toggles.
          if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
          if (open && !byClick.current) { byClick.current = true; return; }
          byClick.current = !open;
          setOpen(!open);
        }}
      >
        {compact ? <span className="task-waiting-chip-icon" aria-hidden="true">{WAIT_UNTIL_ICON}</span> : label}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={cardRef}
              className="task-waiting-card"
              role="dialog"
              aria-label="Why this task is waiting"
              data-testid="session-waiting-card"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => later(true, 0)}
              onMouseLeave={() => later(false, CLOSE_DELAY_MS)}
            >
              <div className="task-waiting-card-head">{label}</div>
              {lines.map((l, i) => <div key={i} className="task-waiting-card-line">{l}</div>)}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
