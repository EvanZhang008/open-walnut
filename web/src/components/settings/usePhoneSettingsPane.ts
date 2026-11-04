/**
 * Settings on a phone (spec 4.7): two layers, like iOS Settings. The nav is
 * the whole page; a tapped row opens its pane as a phone layer (Back bar named
 * after the pane, back gesture = the list). The list stays laid out under the
 * pane, only hidden (styles/phone-settings.css), so its scroll is kept. A page
 * opened at `/settings#<pane>` starts on that pane.
 *
 * A sub-page (Phones & Cloud > Tailscale, core-settings-registry `parent`) is
 * reached from inside its parent's pane, so Back from it lands on the parent,
 * as iOS does: the closed layer opens again at once on the parent's hash, with a
 * fresh history entry, and the next Back reaches the list.
 *
 * Moving between panes inside the layer (a way's card, the back link) is a router
 * replace, which drops the layer's history marker; it is put back on the same entry,
 * so Back still pops this layer's own entry and never leaves an empty Back behind.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { isPhoneLayout, usePhoneLayout } from '@/hooks/usePhoneLayout'
import { markerDepth, stateWithMarker, usePhoneOverlay, type OverlayMarker } from '@/hooks/usePhoneOverlayHistory'
import { parentPane } from './settings-routing'

export interface PhoneSettingsPane {
  /** `data-phone-settings` for the layout: which layer shows, undefined off phone. */
  layer: 'list' | 'pane' | undefined
  /** A row was tapped: open its pane layer (no-op off phone). */
  open: () => void
}

/** `action`: the bar's right slot (a stable element: the pane's actions portal into it once its header scrolls away). */
export function usePhoneSettingsPane(paneId: string, title: string, scroller: HTMLElement | null, action?: ReactNode): PhoneSettingsPane {
  const phone = usePhoneLayout()
  const navigate = useNavigate()
  const [paneOpen, setPaneOpen] = useState(() => /^#./.test(window.location.hash))
  // Back from a sub-page: the layer closed and opens again on the parent (one render apart).
  const [toParent, setToParent] = useState(false)
  const parent = parentPane(paneId)
  usePhoneOverlay({
    id: `settings-pane:${paneId}`,
    kind: 'settings-pane',
    open: phone && paneOpen,
    bar: { title, action },
    onClose: () => {
      // Leaving phone layout closes every layer too: a desktop window keeps its sub-page.
      if (parent && isPhoneLayout()) {
        setToParent(true)
        navigate({ hash: `#${parent}` }, { replace: true })
      }
      setPaneOpen(false)
    },
    getElement: () => scroller,
  })
  // The layer's marker as last seen on its entry, put back after a replace wiped it.
  const marker = useRef<OverlayMarker | null>(null)
  useEffect(() => {
    if (!phone || !paneOpen) { marker.current = null; return }
    const state = window.history.state as { walnutOverlay?: OverlayMarker } | null
    const id = `settings-pane:${paneId}`
    if (markerDepth(state) > 0 && state?.walnutOverlay?.kind === 'settings-pane') {
      marker.current = state.walnutOverlay
    } else if (marker.current && markerDepth(state) === 0) {
      // Only an entry with no marker at all: a layer above this one keeps its own.
      window.history.replaceState(stateWithMarker(state, { ...marker.current, id }), '')
      marker.current = { ...marker.current, id }
    }
  })
  useEffect(() => {
    if (!toParent || paneOpen) return
    setToParent(false)
    setPaneOpen(true)
  }, [toParent, paneOpen])
  // A pane opened again from the list starts at its top, as a new one does.
  useLayoutEffect(() => {
    if (phone && paneOpen && scroller) scroller.scrollTop = 0
  }, [phone, paneOpen, scroller])
  const shown = paneOpen || toParent
  return { layer: phone ? (shown ? 'pane' : 'list') : undefined, open: () => setPaneOpen(true) }
}
