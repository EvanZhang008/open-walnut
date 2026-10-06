/**
 * Add a lane (spec 7.5): wide mode a dashed column after the last lane, narrow
 * mode a text button under the last section. It opens a name field and five
 * kind choices (a custom radiogroup, no native control; `In progress` by
 * default, `Waiting` while the name says wait), Add and Cancel; Enter adds,
 * Escape cancels. The lane goes before a trailing done lane, else last, in ONE
 * api.saveLanes(next). Its id is made here (`ln-` + 8 hex, the server's own
 * format), so onAdded can scroll to it and focus its Add task (G35). At 12
 * lanes the button is aria-disabled and says why.
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ICON_PLUS } from '@/components/common/Icons';
import { log } from '@/utils/log';
import {
  LANE_KINDS, LANE_KIND_LABELS, MAX_LANES, MAX_LANE_NAME, makeLaneId, type BoardLane, type BoardLaneKind,
} from '../../../../../src/core/boards/board-lanes';
import { READ_ONLY_TITLE, type KanbanAddLaneProps } from './kanban-contract';
import { laneNameError } from './KanbanLaneHead';

export const MAX_LANES_TITLE = `A board has at most ${MAX_LANES} lanes`;

/** The kind a new lane starts with: Waiting when its name says wait, else In progress. */
export function defaultLaneKind(name: string): BoardLaneKind {
  return /wait/i.test(name) ? 'wait' : 'active';
}

/** The lanes with `lane` added: before a trailing done lane, else at the end. */
export function insertLane(lanes: readonly BoardLane[], lane: BoardLane): BoardLane[] {
  const last = lanes[lanes.length - 1];
  if (last && last.kind === 'done') return [...lanes.slice(0, -1), lane, last];
  return [...lanes, lane];
}

export function KanbanAddLane({ lanes, mode, api, onAdded }: KanbanAddLaneProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<BoardLaneKind | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const full = lanes.length >= MAX_LANES;
  const blocked = api.readOnly ? READ_ONLY_TITLE : full ? MAX_LANES_TITLE : '';
  const kind = picked ?? defaultLaneKind(name);

  const close = () => { setOpen(false); setName(''); setPicked(null); setError(''); };
  const add = async () => {
    if (saving) return;
    const err = laneNameError(lanes, null, name);
    if (err) { setError(err); inputRef.current?.focus(); return; }
    const lane: BoardLane = { id: makeLaneId(), name: name.trim(), kind };
    setSaving(true);
    const ok = await api.saveLanes(insertLane(lanes, lane));
    setSaving(false);
    log.info('board', 'kanban lane added', { laneId: lane.id, kind, ok });
    if (!ok) return; // the container toasts why and rolls back; the form keeps the name
    close();
    onAdded(lane.id);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); void add(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  const onRadioKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = LANE_KINDS.indexOf(kind);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : LANE_KINDS.length - 1;
    const next = LANE_KINDS[(i + step) % LANE_KINDS.length];
    setPicked(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-kind="${next}"]`)?.focus();
  };

  if (!open) {
    return (
      <div className={`kanban-add-lane-wrap is-${mode}`}>
        <button
          type="button"
          className={`kanban-add-lane is-${mode}`}
          data-testid="kanban-add-lane"
          aria-disabled={blocked ? true : undefined}
          title={blocked || 'Add a lane'}
          onClick={() => { if (!blocked) { setOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); } }}
        ><span className="kanban-add-icon" aria-hidden>{ICON_PLUS}</span> Add lane</button>
      </div>
    );
  }
  return (
    <div className={`kanban-add-lane-wrap is-${mode} is-open`}>
      <div className="kanban-add-lane-form" data-testid="kanban-add-lane-form" onKeyDown={onKeyDown} onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="kanban-add-lane-input"
          data-testid="kanban-add-lane-input"
          placeholder="Lane name"
          aria-label="Lane name"
          maxLength={MAX_LANE_NAME + 10}
          value={name}
          readOnly={saving}
          aria-invalid={error ? true : undefined}
          onChange={(e) => { setName(e.target.value); if (error) setError(''); }}
        />
        {error && <div className="kanban-lane-rename-error" data-testid="kanban-add-lane-error" role="alert">{error}</div>}
        <div className="kanban-add-lane-kinds" data-testid="kanban-add-lane-kinds" role="radiogroup" aria-label="Lane kind" onKeyDown={onRadioKey}>
          {LANE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              className={`kanban-kind-radio${k === kind ? ' is-checked' : ''}`}
              data-testid={`kanban-add-lane-kind-${k}`}
              data-kind={k}
              aria-checked={k === kind}
              tabIndex={k === kind ? 0 : -1}
              onClick={() => setPicked(k)}
            >
              <span className="kanban-kind-radio-dot" data-kind={k} aria-hidden />
              {LANE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <div className="kanban-add-lane-actions">
          <button type="button" className="kanban-btn is-primary" data-testid="kanban-add-lane-submit" aria-disabled={saving || undefined} onClick={() => void add()}>Add</button>
          <button type="button" className="kanban-btn" data-testid="kanban-add-lane-cancel" onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
