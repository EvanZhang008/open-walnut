/**
 * Settings on a phone (spec 4.7): two layers, like iOS Settings. The nav is
 * the whole page; a tapped row opens its pane as a phone layer (Back bar named
 * after the pane, back gesture = the list). The list stays laid out under the
 * pane, only hidden (styles/phone-settings.css), so its scroll is kept. A page
 * opened at `/settings#<pane>` starts on that pane.
 */
import { useLayoutEffect, useState } from 'react'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory'

export interface PhoneSettingsPane {
  /** `data-phone-settings` for the layout: which layer shows, undefined off phone. */
  layer: 'list' | 'pane' | undefined
  /** A row was tapped: open its pane layer (no-op off phone). */
  open: () => void
}

export function usePhoneSettingsPane(paneId: string, title: string, scroller: HTMLElement | null): PhoneSettingsPane {
  const phone = usePhoneLayout()
  const [paneOpen, setPaneOpen] = useState(() => /^#./.test(window.location.hash))
  usePhoneOverlay({
    id: `settings-pane:${paneId}`,
    kind: 'settings-pane',
    open: phone && paneOpen,
    bar: { title },
    onClose: () => setPaneOpen(false),
    getElement: () => scroller,
  })
  // A pane opened again from the list starts at its top, as a new one does.
  useLayoutEffect(() => {
    if (phone && paneOpen && scroller) scroller.scrollTop = 0
  }, [phone, paneOpen, scroller])
  return { layer: phone ? (paneOpen ? 'pane' : 'list') : undefined, open: () => setPaneOpen(true) }
}
