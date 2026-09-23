import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import {
  TP_DEFAULT_COLUMNS, offerColumns, toggleColumn,
  type ColumnScope, type TpColumnId,
} from './tasks-table-columns';

interface TasksColumnsMenuProps {
  columns: readonly TpColumnId[];
  scope: ColumnScope;
  onChange: (next: TpColumnId[]) => void;
}

/**
 * The "choose columns" control at the right end of the table header: a portalled
 * checklist of every optional column (placed by useMenuPlacement, so it never runs
 * off-screen), plus a reset to the shipped layout. Title is not listed — it is the
 * one column that cannot be turned off.
 */
export function TasksColumnsMenu({ columns, scope, onChange }: TasksColumnsMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { onAnchorLost: () => setOpen(false) });

  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);

  const offers = offerColumns(columns, scope);
  const isDefault = columns.length === TP_DEFAULT_COLUMNS.length
    && TP_DEFAULT_COLUMNS.every((id) => columns.includes(id));

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tp-cols-btn${open ? ' open' : ''}`}
        title="Choose columns"
        aria-label="Choose columns"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="tasks-columns-btn"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M6 2.5v11M10 2.5v11" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="tp-cols-popover"
          role="menu"
          data-testid="tasks-columns-menu"
          style={menuPlacementStyle(placement)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="tp-cols-head">Columns</div>
          {offers.map(({ def, checked, disabledReason }) => (
            <label
              key={def.id}
              className={`tp-cols-opt${disabledReason ? ' disabled' : ''}`}
              data-column={def.id}
              title={disabledReason}
            >
              <input
                type="checkbox"
                checked={checked && !disabledReason}
                disabled={!!disabledReason}
                onChange={() => onChange(toggleColumn(columns, def.id))}
              />
              <span>{def.label}</span>
            </label>
          ))}
          <button
            type="button"
            className="tp-cols-reset"
            disabled={isDefault}
            onClick={() => { onChange([...TP_DEFAULT_COLUMNS]); }}
          >
            Reset to default
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
