/**
 * The rail's Focus entry (Sidebar.tsx, above the quick bar): the focus the person is in, or
 * "Focus". A click opens the focus popover beside the rail (FocusPanel.tsx): enter a saved space,
 * make one, leave, and what waited outside while they focused. Shown only while the experiment
 * `focus_workspace` is on.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement'
import { FOCUS_ENDED_EVENT, useFocusSnapshot, type ActiveFocus } from './focus-store'
import { useFocusOn } from './useFocusView'
import { FocusPanel } from './FocusPanel'
import { untilWords } from './focus-model'
import '@/styles/focus-spaces.css'

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle className="focus-glyph-core" cx="12" cy="12" r="3.5" />
    </svg>
  )
}

export function FocusRailButton() {
  const on = useFocusOn()
  const { active } = useFocusSnapshot()
  const [open, setOpen] = useState(false)
  // The focus this window's person just left: the popover opens on what waited outside.
  const [ended, setEnded] = useState<ActiveFocus | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const onEnded = (e: Event) => { setEnded((e as CustomEvent<ActiveFocus>).detail); setOpen(true) }
    window.addEventListener(FOCUS_ENDED_EVENT, onEnded)
    return () => window.removeEventListener(FOCUS_ENDED_EVENT, onEnded)
  }, [])
  if (!on) return null
  const close = () => { setOpen(false); setEnded(null) }
  const live = active
  const title = live ? `In focus: ${live.name}${live.until ? ` (${untilWords(live.until)})` : ''}` : 'Focus: show only a few projects or one task'
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`sidebar-link sidebar-panel-toggle sidebar-focus-link${open ? ' is-open' : ''}`}
        data-choice-exempt="sidebar nav link that opens the Focus popover"
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={live ? `Focus: ${live.name}` : 'Focus'}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title}
        data-testid="sidebar-focus"
        {...(live ? { 'data-active': 'true' } : {})}
      >
        <TargetIcon />
        <span className="sidebar-label">{live ? live.name : 'Focus'}</span>
      </button>
      {open && <FocusPopover triggerRef={triggerRef} ended={ended} onClose={close} />}
    </>
  )
}

function FocusPopover({ triggerRef, ended, onClose }: { triggerRef: React.RefObject<HTMLButtonElement | null>; ended: ActiveFocus | null; onClose(): void }) {
  const popRef = useRef<HTMLDivElement | null>(null)
  // Beside the rail, bottom edge level with the entry, as the status items open.
  const [anchor] = useState(() => {
    const rect = triggerRef.current?.getBoundingClientRect()
    return rect ? { x: rect.right + 10, y: rect.bottom } : null
  })
  const placement = useMenuPlacement(true, triggerRef, popRef, {
    anchorPoint: anchor, align: 'left', preferSide: 'up', gap: 0, minHeight: 160, onAnchorLost: onClose,
  })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => { popRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => {
    const close = () => closeRef.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
      triggerRef.current?.focus({ preventScroll: true })
    }
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || popRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('resize', close)
    }
  }, [triggerRef])

  return createPortal(
    <div
      ref={popRef}
      className="status-item-popover focus-popover"
      role="dialog"
      aria-label="Focus"
      tabIndex={-1}
      style={menuPlacementStyle(placement)}
      // A portal at the end of <body>: a pointer here must not reach a drag under it.
      onPointerDown={(e) => e.stopPropagation()}
      data-testid="focus-popover"
    >
      <FocusPanel ended={ended} onClose={onClose} />
    </div>,
    document.body,
  )
}
