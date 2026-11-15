import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';

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
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || !close.current) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, []);
  const field = useRef<HTMLElement | null>(null);
  field.current = aboveField ? anchor.current?.closest<HTMLElement>('[data-mic-bubble-anchor]') ?? null : null;
  const placement = useMenuPlacement(true, anchor, popup, { preferSide: 'up', gap: 6, minHeight: 40, verticalAnchorRef: field });
  return createPortal(<div
    ref={popup}
    className={`${className} mic-popover`}
    data-mic-owner={owner}
    role={role}
    style={{ position: 'fixed', bottom: 'auto', top: placement?.top ?? 0, right: placement?.right ?? 0,
      maxHeight: placement?.maxHeight, maxWidth: 'min(320px, calc(100vw - 16px))', overflowY: 'auto',
      visibility: placement ? 'visible' : 'hidden', zIndex: 10050 }}
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
