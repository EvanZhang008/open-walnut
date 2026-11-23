import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SESSION_MODES, type SessionMode } from '@open-walnut/core';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { PickerRow } from './PickerRow';

/**
 * The permission-mode pill of a Claude Code composer (session panel, side
 * chats, the new-task draft): one click opens a menu of every mode, safest
 * first, the current one's name coloured (a Picked row), and a pick switches to it (Evan, 2026-11-12:
 * "make it drop down menu can select"). Shift+Tab in the box still steps
 * through the enabled cycle; the pill no longer prints that hint.
 */
export function PermissionModeMenu({ mode, onPick, title, heading = 'Permission mode', className = '', label, ...attrs }: {
  mode: SessionMode;
  onPick: (mode: SessionMode) => void;
  title: string;
  /** The menu's first line. */
  heading?: string;
  /** Extra classes on the pill (the draft's `draft-mode-pill`). */
  className?: string;
  /** What the pill shows; the mode's label by default. */
  label?: ReactNode;
  'data-mode'?: string;
  'data-source'?: string;
  'aria-label'?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const byKeyRef = useRef(false);
  const placement = useMenuPlacement(open, triggerRef, menuRef, {
    preferSide: 'up', align: 'start', onAnchorLost: () => setOpen(false),
  });
  const entry = SESSION_MODES.find((m) => m.id === mode);

  // One layer: Escape closes the menu (the composer under it keeps its draft and
  // its Escape) and focus goes back to the pill; a press outside closes it.
  useOverlayLayer({
    passOutsideClick: true,
    open,
    refs: [menuRef, triggerRef],
    onClose: (reason) => {
      setOpen(false);
      if (reason === 'escape') triggerRef.current?.focus({ preventScroll: true });
    },
  });

  const options = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  // Opened from the keyboard: focus lands on the current mode.
  useEffect(() => {
    if (!open || !placement || !byKeyRef.current) return;
    byKeyRef.current = false;
    (options().find((o) => o.getAttribute('aria-selected') === 'true') ?? options()[0])?.focus({ preventScroll: true });
  }, [open, placement]);
  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = options();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
    rows[next]?.focus({ preventScroll: true });
  };

  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`btn btn-sm btn-ghost mode-toggle-pill${mode === 'plan' ? ' plan-active' : ''}${className ? ` ${className}` : ''}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      title={title}
      data-mode={mode}
      {...attrs}
      onClick={(event) => { byKeyRef.current = event.detail === 0; setOpen((value) => !value); }}
    >
      <span className="mode-toggle-pill-label">{label ?? entry?.label ?? mode}</span>
    </button>
    {open && createPortal(
      <div
        ref={menuRef}
        className="session-control-menu permission-mode-menu wn-overlay wn-menu"
        role="listbox"
        aria-label={heading}
        // A menu opened from the side chat's own composer belongs to that drawer.
        data-composer-scope={triggerRef.current?.closest('.side-question-popover') ? 'side-question' : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onMenuKey}
        style={{ ...menuPlacementStyle(placement), bottom: 'auto', ...(placement ? { left: 'auto' } : {}), zIndex: 'var(--z-menu)' }}
      >
        <div className="model-picker-col-title">{heading}</div>
        {SESSION_MODES.map((option) => {
          const active = option.id === mode;
          return (
            // One line per mode, the model menu's own row: its name, a few muted words on what
            // it does at the right, and the full sentence as the row's tooltip.
            // The current mode is its name in the picked colour (no check mark); a risky mode warns
            // in its hint's colour, so the warning tone never reads as the pick.
            <PickerRow
              key={option.id}
              picked={active}
              data-mode={option.id}
              title={option.description}
              className={option.id === 'bypass' ? 'permission-mode-danger' : undefined}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
                if (!active) onPick(option.id);
              }}
            >
              <span className="model-picker-row-name permission-mode-name wn-title">{option.label}</span>
              <span className="permission-mode-hint">{option.hint}</span>
            </PickerRow>
          );
        })}
      </div>,
      document.body,
    )}
  </>;
}
