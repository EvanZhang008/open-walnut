/**
 * A lane's head (spec 7.3, 3.2): the kind bar, the name, the count (`2 / 6`
 * while filtering, `24 (1 open)` on a done lane holding open tasks), a red dot
 * with how many cards need the user, and the kebab. Wide mode: double click
 * the name to rename. Narrow mode (G35): the whole row is the section's fold
 * button (aria-expanded, chevron), with no double click rename (a double click
 * would fold it twice); Rename comes from the kebab beside it. Every edit is
 * ONE api.saveLanes(next lanes); the container rolls back and toasts on failure.
 */
import '@/styles/board-kanban-controls.css';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ICON_CHEVRON_DOWN, ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { log } from '@/utils/log';
import { deletePreviewText, MAX_LANE_NAME, type BoardLane, type BoardLaneKind } from '../../../../../src/core/boards/board-lanes';
import { READ_ONLY_TITLE, type KanbanLaneHeadProps } from './kanban-contract';
import { KanbanLaneMenu } from './KanbanLaneMenu';
import { KANBAN_PANE_SELECTOR, emitKanbanToast } from './kanban-toasts';
import { laneCountText } from './kanban-filter-model';

/** Why `name` cannot name lane `laneId` ('' = it can). */
export function laneNameError(lanes: readonly BoardLane[], laneId: string | null, name: string): string {
  const n = name.trim();
  if (!n) return 'A lane needs a name';
  if (n.length > MAX_LANE_NAME) return `A lane name has at most ${MAX_LANE_NAME} characters`;
  const dup = lanes.find((l) => l.id !== laneId && l.name.trim().toLowerCase() === n.toLowerCase());
  return dup ? `There is already a lane called "${dup.name}"` : '';
}


export function KanbanLaneHead({ lane: vm, lanes, index, mode, folded, onToggleFold, shown, api, flashing, deletePreview }: KanbanLaneHeadProps) {
  const lane = vm.lane;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readOnly = api.readOnly;
  const narrow = mode === 'narrow';

  // A lane deleted under its open rename (another window, the leader): say so once the head is gone
  // and the board still shows (a closed board or the Page view is not a deletion).
  const renameState = useRef<{ renaming: boolean; name: string; id: string; pane: Element | null }>({ renaming: false, name: '', id: '', pane: null });
  renameState.current = { renaming, name: lane.name, id: lane.id, pane: headRef.current?.closest(KANBAN_PANE_SELECTOR) ?? renameState.current.pane };
  useLayoutEffect(() => () => {
    const s = renameState.current;
    if (!s.renaming || !s.pane) return;
    const pane = s.pane;
    setTimeout(() => {
      if (!pane.isConnected || !pane.querySelector('[data-testid="kanban-lane-head"]')) return;
      if (pane.querySelector(`[data-testid="kanban-lane-head"][data-lane-id="${CSS.escape(s.id)}"]`)) return;
      emitKanbanToast(pane, { text: `"${s.name}" was deleted while you were renaming it.` });
    }, 0);
  }, []);

  const save = useCallback(async (next: BoardLane[], what: string) => {
    log.info('board', 'kanban lane edit', { laneId: lane.id, what });
    return api.saveLanes(next);
  }, [api, lane.id]);

  const editing = useRef(false);
  const startRename = () => {
    if (readOnly) return;
    editing.current = true;
    setDraft(lane.name);
    setError('');
    setRenaming(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  };
  const commitRename = () => {
    if (!editing.current) return;
    const err = laneNameError(lanes, lane.id, draft);
    if (err) { setError(err); return; }
    editing.current = false;
    setRenaming(false);
    const name = draft.trim();
    if (name !== lane.name) void save(lanes.map((l) => (l.id === lane.id ? { ...l, name } : l)), 'rename');
  };
  const cancelRename = () => { editing.current = false; setRenaming(false); setError(''); };

  const move = (delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= lanes.length) return;
    const next = [...lanes];
    [next[index], next[j]] = [next[j], next[index]];
    void save(next, delta < 0 ? 'move-left' : 'move-right');
  };
  const setKind = (kind: BoardLaneKind) => void save(lanes.map((l) => {
    if (l.id !== lane.id) return l;
    if (kind === 'done') return { ...l, kind };
    const next: BoardLane = { id: l.id, name: l.name, kind };
    return next;
  }), `kind-${kind}`);
  const toggleCompleteOnDrop = () => void save(lanes.map((l) => (l.id === lane.id ? { ...l, complete_on_drop: !l.complete_on_drop } : l)), 'complete-on-drop');
  const doDelete = () => { setConfirmDelete(false); void save(lanes.filter((l) => l.id !== lane.id), 'delete'); };

  const count = laneCountText(vm.total, shown, vm.openInDone);
  const needs = vm.needs > 0 && (
    <span className="kanban-lane-needs" data-testid="kanban-lane-needs" aria-label={`${vm.needs} ${vm.needs === 1 ? 'needs' : 'need'} you`} title={`${vm.needs} ${vm.needs === 1 ? 'card needs' : 'cards need'} you`}>{vm.needs}</span>
  );
  const nameEl = renaming ? (
    <span className="kanban-lane-rename">
      <input
        ref={inputRef}
        className="kanban-lane-rename-input"
        data-testid="kanban-lane-rename-input"
        aria-label="Lane name"
        aria-invalid={error ? true : undefined}
        maxLength={MAX_LANE_NAME + 10}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(''); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
          if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
        }}
        onBlur={commitRename}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {error && <span className="kanban-lane-rename-error" data-testid="kanban-lane-rename-error" role="alert">{error}</span>}
    </span>
  ) : (
    <span
      className="kanban-lane-name"
      data-testid="kanban-lane-name"
      title={narrow || readOnly ? lane.name : `${lane.name} (double click to rename)`}
      onDoubleClick={narrow ? undefined : startRename}
    >{lane.name}</span>
  );
  // N1: cards headed here that a held lane still draws: the count is what is drawn, this says what comes.
  const countEl = (
    <>
      <span className="kanban-lane-count" data-testid="kanban-lane-count">{count}</span>
      {vm.incoming ? (
        <span className="kanban-lane-incoming" data-testid="kanban-lane-incoming" title="Arrives when the pointer leaves the lane it is in">
          {vm.incoming} incoming
        </span>
      ) : null}
    </>
  );

  return (
    <div
      ref={headRef}
      className={`kanban-lane-head is-${mode}${flashing ? ' is-flashing' : ''}`}
      data-testid="kanban-lane-head"
      data-lane-id={lane.id}
      data-kind={lane.kind}
      data-flashing={flashing || undefined}
    >
      <span className="kanban-lane-kind-bar" data-kind={lane.kind} aria-hidden />
      {narrow && !renaming ? (
        <button
          type="button"
          className="kanban-lane-toggle"
          data-testid="kanban-lane-toggle"
          aria-expanded={!folded}
          onClick={onToggleFold}
        >
          <span className="kanban-lane-chevron" aria-hidden>{folded ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}</span>
          {nameEl}
          {countEl}
          {needs}
        </button>
      ) : (
        <>{nameEl}{countEl}{needs}</>
      )}
      <button
        ref={kebabRef}
        type="button"
        className="kanban-lane-kebab"
        data-testid="kanban-lane-kebab"
        aria-label={`${lane.name} lane actions`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={readOnly ? READ_ONLY_TITLE : 'Lane actions'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => setMenuOpen((v) => !v)}
      >⋮</button>
      <KanbanLaneMenu
        open={menuOpen}
        anchorRef={kebabRef}
        lane={lane}
        lanes={lanes}
        index={index}
        readOnly={readOnly}
        onRename={startRename}
        onMove={move}
        onKind={setKind}
        onToggleCompleteOnDrop={toggleCompleteOnDrop}
        onDelete={() => setConfirmDelete(true)}
        onClose={() => setMenuOpen(false)}
      />
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${lane.name}"?`}
          message={deletePreviewText(deletePreview(lane.id))}
          confirmLabel="Delete lane"
          cancelLabel="Cancel"
          danger
          onConfirm={doDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
