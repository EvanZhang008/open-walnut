/**
 * Snooze choices the board offers in one tap (2026-11-07, the user: the board's Move menu "should also
 * show buttons of snoozed"): a few presets that run out at 9:00, and "Pick a date…", which opens the
 * calendar as its own flyout (a menu never grows in place: web/src/AGENTS.md, Menus & overlays). A
 * snooze is the task's start date, what the task menu's "Snooze until" writes (core/snooze.ts).
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { DatePicker } from '@/components/common/DatePicker';
import type { CursorPoint } from './CursorFlyout';
import { snoozePresets, todayIso } from './quick-sort-model';
import '@/styles/quick-sort.css';

export function SnoozeRows({ onSnooze, onPickDate, onClear }: {
  onSnooze: (date: string) => void;
  onPickDate: () => void;
  /** Shown when the task is snoozed now. */
  onClear?: () => void;
}) {
  return (
    <div className="snooze-rows" role="group" aria-label="Snooze until">
      <div className="snooze-rows-head">Snooze until</div>
      {snoozePresets().map(p => (
        <button key={p.id} type="button" className="task-kebab-project-opt snooze-row" data-snooze={p.id}
          onClick={e => { e.stopPropagation(); onSnooze(p.date); }}>
          <span className="task-kebab-project-check" />
          <span className="task-kebab-project-opt-name">{p.label}</span>
          <span className="snooze-row-hint">{p.hint}</span>
        </button>
      ))}
      <button type="button" className="task-kebab-project-opt snooze-row" data-snooze="pick" onClick={e => { e.stopPropagation(); onPickDate(); }}>
        <span className="task-kebab-project-check" />
        <span className="task-kebab-project-opt-name">Pick a date…</span>
      </button>
      {onClear && <button type="button" className="task-kebab-project-opt snooze-row" data-snooze="clear" onClick={e => { e.stopPropagation(); onClear(); }}>
        <span className="task-kebab-project-check" />
        <span className="task-kebab-project-opt-name">Clear snooze</span>
      </button>}
    </div>
  );
}

/** A flyout placed at a viewport point, wearing the project flyout's class so every outside-press
 *  and scroll closer already exempts it. Focus lands on its first button. */
function PointFlyout({ point, anchorRef, label, className, onClose, children }: {
  point: CursorPoint; anchorRef: RefObject<HTMLElement | null>; label: string; className?: string;
  onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(true, anchorRef, ref, { minHeight: 120, anchorPoint: point, align: 'left', onAnchorLost: onClose });
  useEffect(() => { ref.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }); }, [placement !== null]);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('.snooze-row') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[(at + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  };
  return createPortal(
    <div ref={ref} className={`task-kebab-project-flyout${className ? ` ${className}` : ''}`} role="dialog" aria-label={label}
      style={menuPlacementStyle(placement)} onKeyDown={onKeyDown} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export function SnoozeFlyout({ point, anchorRef, onSnooze, onPickDate, onClear, onClose }: {
  point: CursorPoint; anchorRef: RefObject<HTMLElement | null>;
  onSnooze: (date: string) => void; onPickDate: () => void; onClear?: () => void; onClose: () => void;
}) {
  return <PointFlyout point={point} anchorRef={anchorRef} label="Snooze until" onClose={onClose}>
    <SnoozeRows onSnooze={d => { onSnooze(d); onClose(); }} onPickDate={onPickDate} onClear={onClear ? () => { onClear(); onClose(); } : undefined} />
  </PointFlyout>;
}

export function SnoozeDateFlyout({ point, anchorRef, date, onPick, onClose }: {
  point: CursorPoint; anchorRef: RefObject<HTMLElement | null>; date?: string | null;
  onPick: (date: string | null) => void; onClose: () => void;
}) {
  return <PointFlyout point={point} anchorRef={anchorRef} label="Snooze until a date" className="snooze-date-flyout" onClose={onClose}>
    <div className="snooze-rows-head">Snooze until</div>
    <DatePicker inline withTime date={date} minDate={todayIso()} onChange={d => { onPick(d); onClose(); }} />
  </PointFlyout>;
}
