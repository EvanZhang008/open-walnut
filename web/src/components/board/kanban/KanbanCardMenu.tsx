/**
 * A card's kebab menu (spec 6.1, 8.2), opened from `⋮`, from a right click at
 * the pointer, or with `.` / Shift+F10: Move to lane (a portalled flyout, the
 * current lane checked and aria-disabled), Edit summary, Edit waiting on,
 * Back to automatic lane (explicit placements only), Complete or Reopen task.
 * web/src/AGENTS.md menu rules: placed by useMenuPlacement, portalled to body,
 * pointerdown stops at the portal (dnd-kit never sees it), the flyout is its
 * own portal the outside-click closer exempts, no native select. Up / Down
 * move, Enter picks, Right opens the flyout, Left or Escape goes back, and
 * Escape on the menu closes it and gives focus back to the trigger.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHECK, ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import type { BoardLane } from '../../../../../src/core/boards/board-lanes';
import { READ_ONLY_TITLE, type KanbanWriteApi } from './kanban-contract';
import type { KanbanCardVM } from './kanban-card-model';

/** `from`: what gets focus back on close (N10). */
export type CardMenuAnchor = { kind: 'button'; from?: 'card' | 'kebab' } | { kind: 'point'; x: number; y: number };

export interface KanbanCardMenuProps {
  card: KanbanCardVM;
  anchor: CardMenuAnchor;
  triggerRef: RefObject<HTMLElement | null>;
  lanes: readonly BoardLane[];
  api: KanbanWriteApi;
  onEdit(field: 'summary' | 'waiting_on'): void;
  /** `refocus`: give focus back to the trigger (Escape, a keyboard pick). */
  onClose(refocus: boolean): void;
}

interface Item { key: string; label: string; testId: string; disabled?: string; run?: () => void; sub?: boolean; sepBefore?: boolean }

export const WAIT_ONLY_TITLE = 'Shows when the card is in a waiting lane. Move it to one first.';

const items = (root: HTMLElement | null) => Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]') ?? []);

function moveFocus(root: HTMLElement | null, e: KeyboardEvent): boolean {
  const list = items(root);
  if (!list.length) return false;
  const i = list.indexOf(document.activeElement as HTMLElement);
  const at = e.key === 'ArrowDown' ? (i + 1) % list.length : e.key === 'ArrowUp' ? (i <= 0 ? list.length - 1 : i - 1)
    : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1;
  if (at < 0) return false;
  e.preventDefault();
  list[at].focus();
  return true;
}

export function KanbanCardMenu({ card, anchor, triggerRef, lanes, api, onEdit, onClose }: KanbanCardMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const [fly, setFly] = useState(false);
  const flyOpen = useRef(false);
  flyOpen.current = fly;
  const point = anchor.kind === 'point' ? { x: anchor.x, y: anchor.y } : null;
  const pos = useMenuPlacement(true, triggerRef, menuRef, { anchorPoint: point, onAnchorLost: () => onClose(false) });
  const flyPos = useMenuPlacement(fly, moveRef, flyRef, { align: 'left', minHeight: 120 });
  const ro = api.readOnly;
  const roTitle = ro ? READ_ONLY_TITLE : undefined;

  useEffect(() => {
    const t = setTimeout(() => items(menuRef.current)[0]?.focus(), 0);
    const outside = (e: PointerEvent) => {
      const n = e.target as Node;
      if (menuRef.current?.contains(n) || flyRef.current?.contains(n) || triggerRef.current?.contains(n)) return;
      onClose(false);
    };
    // The open menu owns Escape wherever focus is (WebKit leaves it on <body> after a row click,
    // where a bubbling Escape would exit the fullscreen Board): the flyout first, then the menu.
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (flyOpen.current) { setFly(false); moveRef.current?.focus(); } else onClose(true);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onEsc, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', onEsc, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (fly) setTimeout(() => items(flyRef.current).find((el) => el.getAttribute('aria-disabled') !== 'true')?.focus(), 0); }, [fly]);

  const pick = (run: () => void, refocus = true) => { onClose(refocus); run(); };
  // N14: the chevron item opens on hover too (a short delay so a pass over it does not flash).
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverItem = (sub: boolean) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (ro) return;
    if (sub) hoverTimer.current = setTimeout(() => setFly(true), 120);
    else if (flyOpen.current) setFly(false);
  };
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const list: Item[] = [
    { key: 'move', label: 'Move to lane', testId: 'kanban-card-menu-move', sub: true, disabled: roTitle },
    { key: 'summary', label: 'Edit summary', testId: 'kanban-card-menu-summary', disabled: roTitle, run: () => onEdit('summary') },
    // N5: waiting on shows only in a wait lane; a save elsewhere would be invisible.
    { key: 'waiting', label: 'Edit waiting on', testId: 'kanban-card-menu-waiting',
      disabled: roTitle ?? (card.laneKind === 'wait' ? undefined : WAIT_ONLY_TITLE), run: () => onEdit('waiting_on') },
    ...(card.source === 'explicit' ? [{
      key: 'auto', label: 'Back to automatic lane', testId: 'kanban-card-menu-auto', sepBefore: true, disabled: roTitle,
      run: () => { void api.setCard(card.taskId, { lane: '' }); },
    }] : []),
    card.isComplete
      ? { key: 'reopen', label: 'Reopen task', testId: 'kanban-card-menu-reopen', sepBefore: card.source !== 'explicit', disabled: roTitle, run: () => { void api.reopenTask(card.taskId); } }
      : { key: 'complete', label: 'Complete task', testId: 'kanban-card-menu-complete', sepBefore: card.source !== 'explicit', disabled: roTitle, run: () => { void api.completeTask(card.taskId); } },
  ];

  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' && document.activeElement === moveRef.current && !ro) { e.preventDefault(); setFly(true); return; }
    moveFocus(menuRef.current, e);
  };
  const onFlyKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setFly(false); moveRef.current?.focus(); return; }
    moveFocus(flyRef.current, e);
  };

  return (
    <>
      {createPortal(
        <div
          ref={menuRef} role="menu" aria-label="Card actions" className="task-kebab-menu kanban-menu" data-testid="kanban-card-menu"
          style={menuPlacementStyle(pos)} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKey}
        >
          {list.map((it) => (
            <div key={it.key}>
              {it.sepBefore && <div className="task-kebab-sep kanban-menu-sep" role="separator" />}
              <button
                type="button" role="menuitem" className="task-kebab-item" data-testid={it.testId}
                ref={it.sub ? moveRef : undefined}
                aria-disabled={it.disabled ? true : undefined} title={it.disabled}
                aria-haspopup={it.sub ? 'menu' : undefined} aria-expanded={it.sub ? fly : undefined}
                onPointerEnter={(e) => { if (e.pointerType !== 'touch') hoverItem(!!it.sub); }}
                onClick={() => {
                  if (it.disabled) return;
                  if (it.sub) { if (hoverTimer.current) clearTimeout(hoverTimer.current); hoverTimer.current = null; setFly(true); return; }
                  if (it.run) pick(it.run, it.key !== 'summary' && it.key !== 'waiting');
                }}
              >
                <span>{it.label}</span>
                {it.sub && <span className="kanban-menu-chevron" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>}
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
      {fly && createPortal(
        <div
          ref={flyRef} role="menu" aria-label="Move to lane" className="task-kebab-menu kanban-menu kanban-menu-flyout" data-testid="kanban-card-move-flyout"
          style={menuPlacementStyle(flyPos)} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
          onKeyDown={onFlyKey}
        >
          {lanes.map((l) => {
            const current = l.id === card.lane;
            return (
              <button
                key={l.id} type="button" role="menuitemradio" aria-checked={current} className="task-kebab-item"
                data-testid="kanban-card-move-lane" data-lane-id={l.id}
                aria-disabled={current || ro ? true : undefined} title={ro ? READ_ONLY_TITLE : current ? 'The card is in this lane' : undefined}
                onClick={() => { if (current || ro) return; pick(() => { void api.moveCard(card.taskId, l.id, { index: 0, reason: 'menu' }); }); }}
              >
                <span className="kanban-menu-check" aria-hidden="true">{current ? ICON_CHECK : null}</span>
                <span>{l.name}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
