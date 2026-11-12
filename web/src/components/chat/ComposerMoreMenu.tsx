import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/composer-more.css';

/** A separate flyout: opening rare actions never grows the add menu. */
export function ComposerMoreMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const byKeyRef = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, buttonRef, menuRef, {
    // Beside the "+" menu, like a submenu, so its rows stay readable; flipped
    // back over it only where the window has no room (a phone).
    align: 'left', preferSide: 'up', minHeight: 120,
    onAnchorLost: () => setOpen(false),
  });
  useOverlayLayer({
    open, refs: [menuRef, buttonRef], passOutsideClick: true,
    onClose: (reason) => {
      setOpen(false);
      if (reason === 'escape') buttonRef.current?.focus({ preventScroll: true });
    },
  });
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  // Opened from the keyboard: focus lands on its first row.
  useEffect(() => {
    if (open && placement && byKeyRef.current) { byKeyRef.current = false; items()[0]?.focus({ preventScroll: true }); }
  }, [open, placement]);
  const onMenuKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = items();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
    rows[next]?.focus({ preventScroll: true });
  };
  // A flyout opened from the side thread's own composer belongs to that drawer.
  const scope = open && buttonRef.current?.closest('.side-question-popover') ? 'side-question' : undefined;
  return <>
    <div className="chat-plus-menu-divider" role="separator" />
    <button ref={buttonRef} type="button" role="menuitem" className="chat-plus-menu-item"
      aria-haspopup="menu" aria-expanded={open}
      onClick={(event) => { byKeyRef.current = event.detail === 0; setOpen((value) => !value); }}>
      <span className="chat-plus-menu-key" aria-hidden="true">···</span>
      <span>More</span>
      <span className="chat-plus-menu-control-value" aria-hidden="true">›</span>
    </button>
    {open && createPortal(<div ref={menuRef} role="menu" aria-label="More composer actions"
      className="chat-plus-menu chat-plus-more-flyout" style={menuPlacementStyle(placement)}
      data-composer-scope={scope} onKeyDown={onMenuKey}
      onPointerDown={(event) => event.stopPropagation()}>
      {children}
    </div>, document.body)}
  </>;
}
