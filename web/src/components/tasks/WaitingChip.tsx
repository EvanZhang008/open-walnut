/**
 * A Waiting task's wait, as one chip in the session header's title row, on the
 * left beside the title, apart from the status pills on the right (2026-10-31,
 * the user: the wait was a bar above the composer; "put it up with the task and
 * its tags, on the left ... hover shows the details").
 *
 *   chip   "Wait until Mon 6:53" (or "Waiting" with no clock); a parked task whose own work
 *          runs (its build, a test run of its change) reads "Working · checks back Mon 6:53",
 *          and one with only a result to read "To read" (2026-11-02, the user: "wait is just
 *          acutally waitng, if it is runnig it shoud be i progress right?")
 *   card   on hover, focus or a tap: when it wakes by itself, on whom or what it
 *          waits, its triggers, and that a message here moves it to Working
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
import { taskUserState } from '@/utils/session-status';
import { NEEDS_CATEGORY_LABELS, USER_STATE_LABELS, needsLineOf } from '@open-walnut/user-status';
import { ICON_PHASE_IN_PROGRESS, ICON_TO_READ } from '@/components/common/Icons';
import '@/styles/task-status.css';

const OPEN_DELAY_MS = 250;
const CLOSE_DELAY_MS = 200;

/**
 * The task is parked: the chip labels the WAITING phase itself (its clock, and that a
 * message ends it), not the status the user reads, which also says Waiting for a snoozed
 * or not-started task that has no park to show (listed in task-state-ratchet).
 */
function isParked(task: Pick<Task, 'phase'> | null | undefined): boolean {
  return task?.phase === 'WAITING';
}

type ChipTask = Pick<Task, 'phase' | 'wait_until'> & Partial<Pick<Task, 'status' | 'user_status'>>;

/** What the park is to the user: a wait, the task's own work going on, or a result to read. */
function parkReads(task: ChipTask): 'waiting' | 'working' | 'read' {
  const state = taskUserState(task as Pick<Task, 'phase' | 'status' | 'user_status'>);
  return state === 'working' || state === 'read' ? state : 'waiting';
}

/** The chip's words. */
export function waitingChipLabel(task: ChipTask): string {
  if (!isParked(task)) return '';
  const until = formatWaitUntil(task.wait_until);
  const reads = parkReads(task);
  if (reads === 'working') return until ? `${USER_STATE_LABELS.working} · checks back ${until}` : USER_STATE_LABELS.working;
  if (reads === 'read') {
    const line = task.user_status ? needsLineOf(task.user_status) : null;
    return line ? NEEDS_CATEGORY_LABELS[line.category] : NEEDS_CATEGORY_LABELS.look;
  }
  return until ? `Wait until ${until}` : 'Waiting';
}

/** The card's lines, in reading order (also the chip's hover text). */
export function waitingDetailLines(
  task: Pick<Task, 'phase' | 'wait_until' | 'user_status'>,
  triggersText = '',
): string[] {
  if (!isParked(task)) return [];
  const lines: string[] = [];
  const reads = parkReads(task);
  if (reads === 'working') lines.push(`Its own work runs (a build, a test run or a deploy of its change), so it reads ${USER_STATE_LABELS.working}.`);
  if (reads === 'read') lines.push('Nothing is asked: there is a result to read.');
  lines.push(task.wait_until
    ? `Wakes by itself ${new Date(task.wait_until).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, or sooner when something happens.`
    : 'No clock: it waits until something happens (a trigger fires, a message arrives).');
  const on = task.user_status?.waitingOn?.trim();
  if (on && reads === 'waiting') lines.push(`Waiting on ${on}.`);
  const next = task.user_status?.next?.trim();
  if (next) lines.push(`Next: ${next}`);
  for (const t of triggersText.split('\n').map((l) => l.trim()).filter(Boolean)) lines.push(`Trigger ${t}`);
  lines.push('A message here moves it to Working.');
  return lines;
}

/**
 * `compact`: the phone's top bar, where the title is centred over the whole bar:
 * an hourglass only (its words are the card's head and the label), so the bar
 * widens the title's gutters by one button and nothing overlaps.
 */
export function WaitingChip({ task, compact = false }: { task: Task | null | undefined; compact?: boolean }) {
  const triggers = useTaskTriggers(isParked(task) ? task!.id : undefined);
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
    // Capture phase: every pill on a row stops its own pointerdown (see LeaderPill.tsx).
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!task || !isParked(task)) return null;
  const label = waitingChipLabel(task);
  const lines = waitingDetailLines(task, triggerPillTitle(triggers));
  const reads = parkReads(task);
  const icon = reads === 'working' ? ICON_PHASE_IN_PROGRESS : reads === 'read' ? ICON_TO_READ : WAIT_UNTIL_ICON;
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`task-waiting-chip${compact ? ' is-compact' : ''}${reads !== 'waiting' ? ` is-${reads}` : ''}`}
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
        {compact ? <span className="task-waiting-chip-icon" aria-hidden="true">{icon}</span> : label}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={cardRef}
              className="task-waiting-card"
              role="dialog"
              aria-label={reads === 'waiting' ? 'Why this task is waiting' : 'When this task checks back'}
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
