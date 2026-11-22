/**
 * A lane's kebab menu (spec 7.3, G7, G18): Rename, Move left / right, the Kind
 * group (five fixed rows, the current one checked, so the menu never changes
 * height), `Complete tasks moved here` on a done lane, and Delete lane. The
 * last done lane cannot be deleted or change kind, and a board keeps one lane:
 * those rows are aria-disabled with a tooltip saying why. Portalled to body,
 * placed by useMenuPlacement, pointer downs stopped (no drag starts under it),
 * arrows move, Escape (useOverlayLayer, wherever focus is) closes and gives the focus back to the kebab.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ICON_CHECK } from '@/components/common/Icons';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { LANE_KINDS, LANE_KIND_LABELS, type BoardLane, type BoardLaneKind } from '../../../../../src/core/boards/board-lanes';
import { READ_ONLY_TITLE } from './kanban-contract';

export interface KanbanLaneMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  lane: BoardLane;
  lanes: readonly BoardLane[];
  index: number;
  readOnly: boolean;
  onRename(): void;
  onMove(delta: -1 | 1): void;
  onKind(kind: BoardLaneKind): void;
  onToggleCompleteOnDrop(): void;
  onDelete(): void;
  onClose(): void;
}

export const ONE_LANE_TITLE = 'A board keeps at least one lane';
export const ONE_DONE_TITLE = 'A board keeps one Done lane';

/** Why a lane cannot be deleted ('' = it can). */
export function deleteBlocked(lanes: readonly BoardLane[], laneId: string): string {
  if (lanes.length <= 1) return ONE_LANE_TITLE;
  const lane = lanes.find((l) => l.id === laneId);
  if (lane?.kind === 'done' && lanes.filter((l) => l.kind === 'done').length === 1) return ONE_DONE_TITLE;
  return '';
}

/** Why a lane cannot take `kind` ('' = it can). */
export function kindBlocked(lanes: readonly BoardLane[], laneId: string, kind: BoardLaneKind): string {
  const lane = lanes.find((l) => l.id === laneId);
  if (lane?.kind === 'done' && kind !== 'done' && lanes.filter((l) => l.kind === 'done').length === 1) return ONE_DONE_TITLE;
  return '';
}

interface RowProps {
  testId: string;
  label: string;
  blocked?: string;
  checked?: boolean;
  danger?: boolean;
  onPick(): void;
}

function Row({ testId, label, blocked, checked, danger, onPick }: RowProps): ReactNode {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      className={`kanban-menu-row${danger ? ' is-danger' : ''}`}
      data-testid={testId}
      aria-disabled={blocked ? true : undefined}
      aria-checked={checked}
      title={blocked || undefined}
      onClick={() => { if (!blocked) onPick(); }}
    >
      <span className="kanban-menu-check" aria-hidden>{checked ? ICON_CHECK : null}</span>
      <span className="kanban-menu-label">{label}</span>
    </button>
  );
}

export function KanbanLaneMenu(p: KanbanLaneMenuProps) {
  const { open, anchorRef, lane, lanes, index, readOnly, onClose } = p;
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, menuRef, { minHeight: 160 });

  // An open menu owns Escape wherever focus is: WebKit leaves focus on <body> after a click on a
  // row, and a bubbling Escape there exits the fullscreen Board instead of closing this menu.
  useOverlayLayer({
    passOutsideClick: true,
    open,
    refs: [menuRef, anchorRef],
    onClose: (reason) => { onClose(); if (reason === 'escape') anchorRef.current?.focus(); },
  });
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('button:not([aria-disabled])')?.focus();
  }, [open]);

  if (!open) return null;
  const ro = readOnly ? READ_ONLY_TITLE : '';
  const pick = (fn: () => void) => () => { onClose(); fn(); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
    if (next) { e.preventDefault(); next.focus(); }
  };
  const delBlocked = ro || deleteBlocked(lanes, lane.id);
  return createPortal(
    <div
      ref={menuRef}
      className="kanban-menu kanban-lane-menu wn-overlay wn-menu"
      data-testid="kanban-lane-menu"
      data-lane-id={lane.id}
      role="menu"
      aria-label={`${lane.name} lane`}
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <Row testId="kanban-lane-menu-rename" label="Rename" blocked={ro} onPick={pick(p.onRename)} />
      <Row testId="kanban-lane-menu-left" label="Move left" blocked={ro || (index === 0 ? 'Already the first lane' : '')} onPick={pick(() => p.onMove(-1))} />
      <Row testId="kanban-lane-menu-right" label="Move right" blocked={ro || (index >= lanes.length - 1 ? 'Already the last lane' : '')} onPick={pick(() => p.onMove(1))} />
      <div className="kanban-menu-sep" role="separator" />
      <div className="kanban-menu-group" role="presentation">Kind</div>
      {LANE_KINDS.map((kind) => (
        <Row
          key={kind}
          testId={`kanban-lane-menu-kind-${kind}`}
          label={LANE_KIND_LABELS[kind]}
          checked={lane.kind === kind}
          blocked={ro || kindBlocked(lanes, lane.id, kind)}
          onPick={pick(() => { if (lane.kind !== kind) p.onKind(kind); })}
        />
      ))}
      {lane.kind === 'done' && (
        <Row
          testId="kanban-lane-menu-complete-on-drop"
          label="Complete tasks moved here"
          checked={!!lane.complete_on_drop}
          blocked={ro}
          onPick={pick(p.onToggleCompleteOnDrop)}
        />
      )}
      <div className="kanban-menu-sep" role="separator" />
      <Row testId="kanban-lane-menu-delete" label="Delete lane" danger blocked={delBlocked} onPick={pick(p.onDelete)} />
    </div>,
    document.body,
  );
}
