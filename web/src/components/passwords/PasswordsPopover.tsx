import { useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useMenuPlacement } from '@/hooks/useMenuPlacement'
import { useOverlayLayer } from '@/hooks/useOverlayLayer'

/**
 * Every Passwords popover and menu (the generator here and in the side bar, the New item menu):
 * portalled, placed by its trigger, closed by Escape (focus back to the trigger) or a press outside.
 */
export function PasswordsPopover({ open, onClose, triggerRef, menu, minHeight, align, children }: {
  open: boolean
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
  /** A list of New rows (role="menu"); otherwise a content popover. */
  menu?: boolean
  minHeight: number
  align?: 'left' | 'right'
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const place = useMenuPlacement(open, triggerRef, box, { minHeight, align, onAnchorLost: onClose })
  // Swallows the click after a closing press, as the backdrop these menus had did.
  useOverlayLayer({
    open,
    refs: [box, triggerRef],
    onClose: (reason) => { onClose(); if (reason === 'escape') triggerRef.current?.focus({ preventScroll: true }) },
  })
  if (!open) return null
  return createPortal(
    <div ref={box} className={menu ? 'pw-menu wn-overlay wn-menu' : 'pw-popover wn-overlay'} role={menu ? 'menu' : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      style={place ? { top: place.top, right: place.right, maxHeight: place.maxHeight } : { visibility: 'hidden' }}>
      {children}
    </div>,
    document.body,
  )
}
