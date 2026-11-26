import { useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';

/** Mic controls escape a scrolling field's clipping, but still belong to that mic. */
export function MicPopover({ anchor, owner, className, role, aboveField, onClose, children }: {
  anchor: RefObject<HTMLElement | null>;
  owner: string;
  className: string;
  role?: 'alert' | 'status';
  aboveField?: boolean;
  onClose?: () => void;
  children: ReactNode;
}) {
  const popup = useRef<HTMLDivElement | null>(null);
  // A popup that can close (the error bubble, the retry dropdown) closes on Escape and on a
  // press outside through the shared overlay layer. The mic's whole field and its other popups
  // count as inside, as ownsMicControl reads them, and so does a dialog opened from the dropdown
  // (the A/B diff). The error bubble lets that outside click through (it only hides a notice,
  // and must never hold a menu under it open). Focus stays in the field.
  // A bubble drawn above its field (`aboveField`: the error with its Retry) belongs to that whole
  // field, the text box included: the user who clicks in to type on after the partial words keeps
  // its Retry (2026-11-24: the mic's own row was the scope, so that click hid the bubble).
  const field = useRef<HTMLElement | null>(null);
  field.current = aboveField ? anchor.current?.closest<HTMLElement>('[data-mic-bubble-anchor]') ?? null : null;
  const scope = useRef<HTMLElement | null>(null);
  scope.current = field.current ?? anchor.current?.parentElement ?? null;
  useOverlayLayer({
    open: !!onClose,
    onClose: () => onClose?.(),
    refs: [popup, scope],
    exemptSelectors: ['.wn-scrim', '.wn-dialog', `[data-mic-owner="${CSS.escape(owner)}"]`],
    passOutsideClick: role !== undefined,
    trapFocus: false,
  });
  // Only a bubble above its field names an anchor of its own; the retry list opens like any menu
  // from the composer, above the whole composer (menu-vertical-anchor.ts).
  const placement = useMenuPlacement(true, anchor, popup, { preferSide: 'up', gap: 6, minHeight: 40, verticalAnchorRef: aboveField ? field : undefined });
  return createPortal(<div
    ref={popup}
    className={`${className} mic-popover wn-overlay`}
    data-mic-owner={owner}
    role={role}
    style={{ position: 'fixed', bottom: 'auto', top: placement?.top ?? 0, right: placement?.right ?? 0,
      maxHeight: placement?.maxHeight, maxWidth: 'min(320px, calc(100vw - 16px))', overflowY: 'auto',
      visibility: placement ? 'visible' : 'hidden', zIndex: 'var(--z-menu)' }}
    onPointerDown={(e) => e.stopPropagation()}
    onMouseDown={(e) => e.stopPropagation()}
    onClick={(e) => e.stopPropagation()}
    onContextMenu={(e) => e.stopPropagation()}
  >{children}</div>, document.body);
}

export function ownsMicControl(field: Element | null | undefined, target: Node | null): boolean {
  if (!field || !target) return false;
  if (field.contains(target)) return true;
  const owner = (target instanceof Element ? target : target.parentElement)?.closest<HTMLElement>('[data-mic-owner]')?.dataset.micOwner;
  return !!owner && Array.from(field.querySelectorAll<HTMLElement>('[data-mic-id]')).some((mic) => mic.dataset.micId === owner);
}
