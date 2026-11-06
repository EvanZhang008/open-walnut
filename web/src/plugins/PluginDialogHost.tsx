import { Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { wsClient } from '@/api/ws'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { closeModalOverlays, ModalOverlayOwner, useModalOverlay } from '@/hooks/useModalOverlay'
import { overlayTabStops, useOverlayLayer } from '@/hooks/useOverlayLayer'
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory'
import { isPopoutPath } from '@/popout/openPopout'
import { usePluginUi, useWebPluginRuntime } from './hooks'
import { closePluginDialog, getPluginDialog, getPluginDialogOpener, invalidatePluginDialog, isDialogNavigationPath, subscribePluginDialog, pluginDialogSlot, type PluginDialogRequest } from './dialog-store'
import type { PluginDialogSlotProps } from './types'
import '@/styles/plugin-dialog.css'

export function PluginDialogHost() {
  const request = useSyncExternalStore(subscribePluginDialog, getPluginDialog, getPluginDialog)
  return request ? <PluginDialog key={request.sequence} request={request} /> : null
}

function PluginDialog({ request }: { request: PluginDialogRequest }) {
  const ui = usePluginUi()
  const runtime = useWebPluginRuntime()
  const routerNavigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const { sequence, pluginId } = request
  useEffect(() => wsClient.onEvent('plugin:runtime-changed', data => {
    const change = data as { action?: string; pluginId?: string } | null
    if (change?.action === 'reloaded' && (!change.pluginId || change.pluginId === pluginId)) invalidatePluginDialog(sequence)
  }), [sequence, pluginId])
  useEffect(() => wsClient.onEvent('plugin:dependency-changed', data => {
    const change = data as { action?: string; pluginId?: string } | null
    if (change?.pluginId === pluginId && ['blocked', 'restored'].includes(change.action ?? '')) invalidatePluginDialog(sequence)
  }), [sequence, pluginId])
  const opener = useRef(getPluginDialogOpener(sequence))
  const focusEpoch = useRef(0)
  const dismiss = useCallback(() => closePluginDialog(sequence), [sequence])
  const { close } = usePhoneOverlay({ id: `plugin-dialog:${sequence}`, kind: 'sheet', open: true, onClose: dismiss, getElement: () => ref.current })
  const modalOwner = useModalOverlay(close)
  // The modal is an outside boundary, not a popover. Child portals own their keys.
  useOverlayLayer({ open: true, refs: [ref, overlayRef], closeOnOutside: false, closeOnEscape: false, trapFocus: false, onClose: close })
  useLayoutEffect(() => {
    const epoch = ++focusEpoch.current
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true })
    return () => {
      // StrictMode's immediate remount must not steal a plugin input's autoFocus.
      queueMicrotask(() => {
        const before = opener.current
        if (focusEpoch.current === epoch && !getPluginDialog() && before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
      })
    }
  }, [])

  // Resolve ONLY the named owner's named dialog. Never render the whole target's slot list.
  const entry = pluginDialogSlot(ui.slots, request.pluginId, request.slot)
  const bound = useRef<{ generation: number; title: string } | null>(null)
  if (!bound.current && entry && !request.unavailable) {
    bound.current = { generation: entry.generation, title: entry.value.title }
  }
  const changed = bound.current !== null && entry?.generation !== bound.current.generation
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (entry || request.unavailable) return
    const timer = setTimeout(() => setTimedOut(true), 30_000)
    return () => clearTimeout(timer)
  }, [entry, request.unavailable])
  const plugin = runtime.plugins.find(plugin => plugin.id === request.pluginId)
  const failure = runtime.errors.some(error => error.id === request.pluginId || error.id === 'runtime')
  const disabled = !runtime.loading && plugin && !['active', 'activating', 'disposing', 'discovered'].includes(plugin.state)
  const [contentTimedOut, setContentTimedOut] = useState(false)
  const expireContent = useCallback(() => setContentTimedOut(true), [])
  const unavailable = request.unavailable || changed || disabled || contentTimedOut
    || (!entry && (failure || timedOut || (runtime.ready && !runtime.loading)))
  const unavailableReason = useRef<'changed' | 'failed' | 'missing' | 'timeout' | null>(null)
  if (unavailable && !unavailableReason.current) unavailableReason.current = contentTimedOut ? 'timeout' : changed || ((request.unavailable || disabled) && bound.current) ? 'changed' : failure ? 'failed' : 'missing'
  useEffect(() => {
    if (unavailable) invalidatePluginDialog(sequence)
  }, [unavailable, sequence])

  const [navigationError, setNavigationError] = useState(false)
  const unavailableRef = useRef(unavailable)
  unavailableRef.current = unavailable
  const navigate = useCallback((path: string) => {
    const current = getPluginDialog()
    if (current?.sequence !== sequence || current.unavailable || unavailableRef.current) return
    if (!isDialogNavigationPath(path)) { setNavigationError(true); return }
    const popout = isPopoutPath(window.location.pathname)
    closeModalOverlays(() => {
      if (popout) window.open(path, '_blank', 'noopener')
      else routerNavigate(path)
    })
  }, [routerNavigate, sequence])
  const title = bound.current?.title ?? entry?.value.title ?? 'Plugin dialog'
  const Component = entry?.value.component as ComponentType<PluginDialogSlotProps> | undefined
  return createPortal(
    <div ref={overlayRef} className="plugin-dialog-overlay" onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      const root = ref.current
      if (event.key !== 'Tab' || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || !root?.contains(event.target as Node)) return
      const stops = overlayTabStops(root)
      event.preventDefault()
      if (!stops.length) { root.focus({ preventScroll: true }); return }
      const index = stops.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (index <= 0 ? stops.length - 1 : index - 1) : (index < 0 || index === stops.length - 1 ? 0 : index + 1)
      stops[next].focus({ preventScroll: true })
      stops[next].scrollIntoView?.({ block: 'nearest' })
    }}>
      <div ref={ref} className="plugin-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid="plugin-dialog">
        <header className="plugin-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="plugin-dialog-close" aria-label="Close dialog" onClick={close}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="plugin-dialog-body">
          {unavailable ? <p role="alert">{unavailableReason.current === 'timeout' ? 'The dialog content did not finish loading. Close it and try again.' : unavailableReason.current === 'changed' ? 'This plugin changed or became unavailable. Close this dialog and open it again.' : unavailableReason.current === 'failed' ? 'The plugin could not load this dialog. Close it and try again.' : 'This dialog is unavailable. Its plugin may be disabled or no longer provide it.'}</p>
            : Component && entry ? (
              <PluginBoundary key={`${entry.key}:${entry.generation}`} pluginId={entry.pluginId} pluginName={entry.pluginName} resetKey={entry.generation}
                fallback={<p role="alert">The plugin could not render this dialog. Close it and try again.</p>}>
                <Suspense fallback={<DialogLoading onTimeout={expireContent} />}>
                  <ModalOverlayOwner.Provider value={modalOwner}>
                    <DialogContent args={request.args} Component={Component} close={close} navigate={navigate} />
                  </ModalOverlayOwner.Provider>
                </Suspense>
              </PluginBoundary>
            ) : <p role="status">Loading plugin dialog...</p>}
          {navigationError && <p role="alert">This dialog can only open paths within Walnut.</p>}
        </div>
      </div>
    </div>, document.body,
  )
}

function DialogLoading({ onTimeout }: { onTimeout(): void }) {
  useEffect(() => {
    const timer = setTimeout(onTimeout, 30_000)
    return () => clearTimeout(timer)
  }, [onTimeout])
  return <p role="status">Loading dialog content...</p>
}

/** A null-rendering slot must not leave an unexplained empty modal. */
function DialogContent({ args, Component, close, navigate }: {
  args?: Record<string, unknown>
  Component: ComponentType<PluginDialogSlotProps>
  close(): void
  navigate(path: string): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setEmpty(el.childNodes.length === 0)
    check()
    const observer = new MutationObserver(check)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  return <><div ref={ref}><Component args={args} close={close} navigate={navigate} /></div>
    {empty && <p role="status">The plugin has no dialog content to show.</p>}</>
}
