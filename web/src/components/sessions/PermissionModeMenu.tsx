import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { SESSION_MODES, type SessionMode } from '@open-walnut/core';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';

/**
 * The permission-mode pill of a Claude Code composer (session panel, side
 * threads, the new-task draft): one click opens a menu of every mode, safest
 * first, the current one checked, and a pick switches to it (Evan, 2026-11-12:
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

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // One layer: the menu closes, the composer under it keeps its draft and its Escape.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

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
      className={`mode-toggle-pill${mode === 'plan' ? ' plan-active' : ''}${className ? ` ${className}` : ''}`}
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
        className="session-control-menu permission-mode-menu"
        role="listbox"
        aria-label={heading}
        // A menu opened from the side thread's own composer belongs to that drawer.
        data-composer-scope={triggerRef.current?.closest('.side-question-popover') ? 'side-question' : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onMenuKey}
        style={{ ...menuPlacementStyle(placement), bottom: 'auto', ...(placement ? { left: 'auto' } : {}), zIndex: 10020 }}
      >
        <div className="model-picker-col-title">{heading}</div>
        {SESSION_MODES.map((option) => {
          const active = option.id === mode;
          return (
            // One line per mode, the model menu's own row; what the mode does is the row's tooltip.
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={active}
              data-mode={option.id}
              title={option.description}
              className={`model-picker-row${active ? ' model-picker-row-active' : ''}${option.id === 'bypass' ? ' permission-mode-danger' : ''}`}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus({ preventScroll: true });
                if (!active) onPick(option.id);
              }}
            >
              <span className="model-picker-row-check" aria-hidden>{active ? '✓' : ''}</span>
              <span className="model-picker-row-name permission-mode-name">{option.label}</span>
            </button>
          );
        })}
      </div>,
      document.body,
    )}
  </>;
}
