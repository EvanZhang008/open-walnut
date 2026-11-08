import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { act, createElement, lazy, StrictMode, useEffect, useLayoutEffect, useState } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

import { Router } from '../../web/node_modules/react-router-dom'
const runtimeEvents = vi.hoisted(() => new Set<(data: unknown) => void>())
vi.mock('@/api/ws', () => ({ wsClient: { onEvent: (_name: string, callback: (data: unknown) => void) => {
  runtimeEvents.add(callback)
  return () => { runtimeEvents.delete(callback) }
} } }))
const routeNavigate = vi.fn()
const navigator = { createHref: () => '/', go: vi.fn(), push: routeNavigate, replace: routeNavigate }
vi.mock('@/hooks/useOverlayLayer', () => ({
  useOverlayLayer: () => {},
  overlayTabStops: (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('button,input')).filter(el => !(el as HTMLButtonElement).disabled),
}))
vi.mock('@/utils/log', () => ({ log: { error: vi.fn(), warn: vi.fn() } }))
import { PluginDialogHost } from '../../web/src/plugins/PluginDialogHost'
import { Lightbox } from '../../web/src/components/common/Lightbox'
import { ConfirmDialog } from '../../web/src/components/common/ConfirmDialog'
import { closePluginDialog, getPluginDialog, openPluginDialog } from '../../web/src/plugins/dialog-store'
import { pluginUiRegistry } from '../../web/src/plugins/registry'
import { publishWebPluginRuntime, resetWebPluginRuntime } from '../../web/src/plugins/runtime-store'
import type { PluginDialogSlotProps } from '../../web/src/plugins/types'
import { closeModalOverlays, useModalOverlay } from '../../web/src/hooks/useModalOverlay'
import { __resetPhoneOverlaysForTest, phoneOverlayIds, stateWithoutMarker, usePhoneOverlay } from '../../web/src/hooks/usePhoneOverlayHistory'

let root: ReturnType<typeof createRoot>
let host: HTMLElement
const cleanup = vi.fn()
const mounted = vi.fn()
function Record({ args }: PluginDialogSlotProps) {
  useEffect(() => { mounted(); return cleanup }, [])
  return createElement('span', { 'data-testid': 'record-content' }, String(args?.id ?? 'record'))
}
function slot(pluginId = 'sample', id = 'record', component = Record, title = 'Record') {
  return pluginUiRegistry.registerSlot(pluginId, pluginId, { id, target: 'dialog', title, component: component as never })
}
const text = () => document.querySelector('[data-testid="plugin-dialog"]')?.textContent ?? ''

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
  // Linkedom has no keyboard or location implementation; the browser spec proves those.
  Object.defineProperty(dom.window, 'location', { configurable: true, value: { pathname: '/' } })
  dom.window.HTMLElement.prototype.focus = function () { Object.defineProperty(dom.document, 'activeElement', { configurable: true, value: this }) }
  dom.window.HTMLInputElement.prototype.select = function () { this.focus() }
})
beforeEach(async () => {
  mounted.mockClear(); cleanup.mockClear(); routeNavigate.mockClear()
  resetWebPluginRuntime(); pluginUiRegistry.clear()
  document.body.focus()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => { root.render(createElement(Router, { location: '/', navigator }, createElement(PluginDialogHost))) })
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  const request = getPluginDialog(); if (request) closePluginDialog(request.sequence)
  pluginUiRegistry.clear(); resetWebPluginRuntime(); host.remove()
})

describe('plugin dialog host boundaries', () => {
  it('renders the exact owner once and preserves it on duplicates and unrelated registry changes', async () => {
    const other = vi.fn(() => createElement('span', null, 'Wrong owner'))
    await act(async () => { slot('other', 'record', other as never); slot(); openPluginDialog('sample', 'record', { id: 'one' }) })
    expect(text()).toContain('one'); expect(other).not.toHaveBeenCalled(); expect(mounted).toHaveBeenCalledTimes(1)
    await act(async () => { openPluginDialog('sample', 'record', { id: 'two' }); slot('other', 'another', other as never) })
    expect(text()).toContain('one'); expect(mounted).toHaveBeenCalledTimes(1); expect(cleanup).not.toHaveBeenCalled()
    await act(async () => { closePluginDialog(getPluginDialog()!.sequence) })
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(cleanup).toHaveBeenCalledTimes(1)
    expect(document.body.style.overflow).toBe('')
  })

  it('unmounts and releases args on a generation change, never starting its replacement silently', async () => {
    await act(async () => { slot(); openPluginDialog('sample', 'record', { id: 'one' }) })
    await act(async () => { pluginUiRegistry.removeOwner('sample'); slot('sample', 'record', Record, 'New record') })
    expect(cleanup).toHaveBeenCalledTimes(1); expect(mounted).toHaveBeenCalledTimes(1)
    expect(text()).toContain('changed or became unavailable'); expect(getPluginDialog()?.args).toBeUndefined()
    await act(async () => { closePluginDialog(getPluginDialog()!.sequence); openPluginDialog('sample', 'record') })
    expect(text()).toContain('New record'); expect(mounted).toHaveBeenCalledTimes(2)
  })

  it('invalidates a server reload even when its web module has not changed, without affecting another owner', async () => {
    await act(async () => { slot(); openPluginDialog('sample', 'record', { id: 'one' }) })
    const emit = (data: unknown) => { for (const listener of runtimeEvents) listener(data) }
    await act(async () => { emit({ action: 'reloaded', pluginId: 'other' }); emit({ action: 'recovered', pluginId: 'sample' }) })
    expect(mounted).toHaveBeenCalledTimes(1); expect(cleanup).not.toHaveBeenCalled()
    await act(async () => { emit({ action: 'reloaded', pluginId: 'sample' }) })
    expect(getPluginDialog()?.unavailable).toBe(true); expect(getPluginDialog()?.args).toBeUndefined()
    expect(cleanup).toHaveBeenCalledTimes(1); expect(mounted).toHaveBeenCalledTimes(1)
    expect(text()).toContain('changed or became unavailable')
    await act(async () => { closePluginDialog(getPluginDialog()!.sequence); openPluginDialog('sample', 'record') })
    await act(async () => { emit({ action: 'reloaded' }) })
    expect(getPluginDialog()?.unavailable).toBe(true)
  })

  it('invalidates a dialog when its unchanged module loses a server dependency', async () => {
    await act(async () => { slot(); openPluginDialog('sample', 'record', { id: 'one' }) })
    const emit = (data: unknown) => { for (const listener of runtimeEvents) listener(data) }
    await act(async () => { emit({ action: 'blocked', pluginId: 'other', dependencyId: 'service' }) })
    expect(cleanup).not.toHaveBeenCalled()
    await act(async () => { emit({ action: 'blocked', pluginId: 'sample', dependencyId: 'service' }) })
    expect(cleanup).toHaveBeenCalledTimes(1); expect(getPluginDialog()?.args).toBeUndefined()
    await act(async () => { emit({ action: 'restored', pluginId: 'sample', dependencyId: 'service' }) })
    expect(mounted).toHaveBeenCalledTimes(1); expect(getPluginDialog()?.unavailable).toBe(true)
  })

  it('keeps a missing dialog visibly loading, then reports unavailable once the catalogue settles', async () => {
    await act(async () => { publishWebPluginRuntime({ loading: true }); openPluginDialog('sample', 'record') })
    expect(text()).toContain('Loading plugin dialog')
    await act(async () => { publishWebPluginRuntime({ ready: true, loading: false }) })
    expect(text()).toContain('unavailable'); expect(getPluginDialog()?.unavailable).toBe(true)
  })

  it('closes on Escape through the shared modal hook and runs component cleanup', async () => {
    await act(async () => { slot(); openPluginDialog('sample', 'record') })
    const event = new window.Event('keydown', { cancelable: true })
    Object.assign(event, { key: 'Escape' })
    await act(async () => { document.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true); expect(getPluginDialog()).toBeNull(); expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('preserves plugin focus on mount and restores the opener after invalidation and close', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus()
    const AutoFocus = () => {
      useLayoutEffect(() => { document.querySelector<HTMLElement>('[data-testid="auto-focus"]')?.focus() }, [])
      return createElement('input', { 'data-testid': 'auto-focus' })
    }
    try {
      await act(async () => { slot('sample', 'record', AutoFocus as never); openPluginDialog('sample', 'record', { id: 'one' }) })
      expect(document.activeElement).toBe(document.querySelector('[data-testid="auto-focus"]'))
      await act(async () => { pluginUiRegistry.removeOwner('sample') })
      await act(async () => { closePluginDialog(getPluginDialog()!.sequence) })
      expect(document.activeElement).toBe(opener)
    } finally { opener.remove() }
  })

  it('does not restore an old opener over a newly opened dialog', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus()
    const AutoFocus = () => {
      useLayoutEffect(() => { document.querySelector<HTMLElement>('[data-testid="next-focus"]')?.focus() }, [])
      return createElement('input', { 'data-testid': 'next-focus' })
    }
    try {
      await act(async () => { slot(); slot('sample', 'next', AutoFocus as never); openPluginDialog('sample', 'record') })
      await act(async () => { closePluginDialog(getPluginDialog()!.sequence); openPluginDialog('sample', 'next') })
      expect(document.activeElement).toBe(document.querySelector('[data-testid="next-focus"]'))
    } finally { opener.remove() }
  })

  it('cycles Tab inside the dialog while leaving child body-portal Tab untouched', async () => {
    await act(async () => { slot(); openPluginDialog('sample', 'record') })
    const dialog = document.querySelector<HTMLElement>('[data-testid="plugin-dialog"]')!
    const first = dialog.querySelector<HTMLElement>('button')!
    first.focus()
    const tab = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(tab, { key: 'Tab' })
    await act(async () => { first.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(true); expect(document.activeElement).toBe(first)
    const portal = document.createElement('input'); document.body.append(portal); portal.focus()
    const outside = new window.Event('keydown', { bubbles: true, cancelable: true }); Object.assign(outside, { key: 'Tab' })
    await act(async () => { portal.dispatchEvent(outside) })
    expect(outside.defaultPrevented).toBe(false); expect(document.activeElement).toBe(portal)
    portal.remove()
  })

  it('does not invalidate a re-enabled slot against an older disabled runtime during refresh', async () => {
    await act(async () => {
      publishWebPluginRuntime({ ready: true, loading: true, plugins: [{ id: 'sample', state: 'disabled' }] })
      slot(); openPluginDialog('sample', 'record', { id: 'one' })
    })
    expect(text()).toContain('one'); expect(getPluginDialog()?.unavailable).toBeUndefined()
    await act(async () => { publishWebPluginRuntime({ loading: false, plugins: [{ id: 'sample', state: 'active' }] }) })
    expect(cleanup).not.toHaveBeenCalled()
    expect(getPluginDialog()?.args).toEqual({ id: 'one' })
  })

  it('cleans up even when the runtime disables a plugin before its registry is removed', async () => {
    await act(async () => { slot(); openPluginDialog('sample', 'record', { id: 'one' }) })
    await act(async () => { publishWebPluginRuntime({ ready: true, plugins: [{ id: 'sample', state: 'disabled' }] }) })
    expect(cleanup).toHaveBeenCalledTimes(1); expect(getPluginDialog()?.args).toBeUndefined()
    expect(document.querySelector('[data-testid="record-content"]')).toBeNull()
  })

  it('ignores navigation callbacks from a closed component and rejects external navigation', async () => {
    let navigate!: PluginDialogSlotProps['navigate']
    const component = (props: PluginDialogSlotProps) => { navigate = props.navigate; return createElement('span', null, 'Record') }
    await act(async () => { slot('sample', 'record', component as never); openPluginDialog('sample', 'record') })
    await act(async () => { navigate('//example.com') })
    expect(text()).toContain('only open paths within Walnut'); expect(routeNavigate).not.toHaveBeenCalled()
    const staleNavigate = navigate
    await act(async () => { closePluginDialog(getPluginDialog()!.sequence); openPluginDialog('sample', 'record') })
    await act(async () => { staleNavigate('/settings') })
    expect(getPluginDialog()).not.toBeNull(); expect(routeNavigate).not.toHaveBeenCalled()
    await act(async () => { navigate('/settings') })
    expect(getPluginDialog()).toBeNull(); expect(routeNavigate).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/settings' }), undefined, expect.anything())
  })

  it('bounds a missing dialog loading wait and releases its arguments', async () => {
    vi.useFakeTimers()
    try {
      await act(async () => { publishWebPluginRuntime({ loading: true }); openPluginDialog('sample', 'record', { id: 'one' }) })
      expect(text()).toContain('Loading plugin dialog')
      await act(async () => { vi.advanceTimersByTime(30_000) })
      expect(text()).toContain('unavailable'); expect(getPluginDialog()?.args).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('unmounts a timed-out Suspense tree so late resolution cannot mount or run effects', async () => {
    vi.useFakeTimers()
    let resolve!: (module: { default: typeof Record }) => void
    const Late = lazy(() => new Promise<{ default: typeof Record }>(done => { resolve = done }))
    try {
      await act(async () => { slot('sample', 'record', Late as never); openPluginDialog('sample', 'record', { id: 'one' }) })
      expect(text()).toContain('Loading dialog content')
      await act(async () => { vi.advanceTimersByTime(30_000) })
      expect(text()).toContain('did not finish loading'); expect(getPluginDialog()?.args).toBeUndefined()
      await act(async () => { resolve({ default: Record }) })
      expect(mounted).not.toHaveBeenCalled(); expect(document.querySelector('[data-testid="record-content"]')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('handles only the newest modal Escape and retains the underlying scroll lock', async () => {
    const taskClose = vi.fn(); const confirmClose = vi.fn()
    function Modal({ close }: { close(): void }) { useModalOverlay(close); return null }
    const render = (confirm: boolean) => root.render(createElement(Router, { location: '/', navigator },
      createElement(Modal, { key: 'task', close: taskClose }), createElement(PluginDialogHost, { key: 'plugin' }),
      confirm ? createElement(Modal, { key: 'confirm', close: confirmClose }) : null))
    await act(async () => { render(false); slot(); openPluginDialog('sample', 'record') })
    await act(async () => { render(true) })
    const escape = () => { const event = new window.Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' }); document.dispatchEvent(event) }
    await act(async () => { escape() })
    expect(confirmClose).toHaveBeenCalledTimes(1); expect(taskClose).not.toHaveBeenCalled(); expect(getPluginDialog()).not.toBeNull()
    await act(async () => { render(false) })
    await act(async () => { escape() })
    expect(getPluginDialog()).toBeNull(); expect(taskClose).not.toHaveBeenCalled(); expect(document.body.style.overflow).toBe('hidden')
    const consumed = new window.Event('keydown', { cancelable: true }); Object.assign(consumed, { key: 'Escape' }); consumed.preventDefault()
    await act(async () => { document.dispatchEvent(consumed) })
    expect(taskClose).not.toHaveBeenCalled()
    await act(async () => { closeModalOverlays() })
    expect(taskClose).toHaveBeenCalledTimes(1)
  })

  it('a child modal present at the first render owns Escape and closes before its parent', async () => {
    const imageClose = vi.fn()
    function Content() {
      const [image, setImage] = useState(true)
      return createElement('div', null, 'Record', image ? createElement(Lightbox, {
        src: '/fixture.png', onClose: () => { imageClose(); setImage(false) },
      }) : null)
    }
    await act(async () => { slot('sample', 'record', Content as never); openPluginDialog('sample', 'record') })
    const escape = () => { const event = new window.Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' }); document.dispatchEvent(event) }
    await act(async () => { escape() })
    expect(imageClose).toHaveBeenCalledTimes(1); expect(getPluginDialog()).not.toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    await act(async () => { escape() })
    expect(getPluginDialog()).toBeNull()
    await act(async () => { openPluginDialog('sample', 'record') })
    await act(async () => { closeModalOverlays() })
    expect(imageClose).toHaveBeenCalledTimes(2); expect(getPluginDialog()).toBeNull()
  })

  it('three initially mounted modal levels close deepest first', async () => {
    const imageClose = vi.fn(); const confirmClose = vi.fn()
    function Content() {
      const [confirm, setConfirm] = useState(true)
      const [image, setImage] = useState(true)
      return createElement('div', null, 'Record', confirm ? createElement(ConfirmDialog, {
        title: 'Initial confirmation', confirmLabel: 'Keep', promptDefaultValue: '', onConfirm: () => {},
        onCancel: () => { confirmClose(); setConfirm(false) },
        message: image ? createElement(Lightbox, { src: '/fixture.png', onClose: () => { imageClose(); setImage(false) } }) : 'Preview closed',
      }) : null)
    }
    await act(async () => { slot('sample', 'record', Content as never); openPluginDialog('sample', 'record') })
    const prompt = document.querySelector<HTMLInputElement>('.app-modal-input')!
    prompt.focus()
    const escape = () => { const event = new window.Event('keydown', { cancelable: true, bubbles: true }); Object.assign(event, { key: 'Escape' }); (prompt.isConnected ? prompt : document).dispatchEvent(event) }
    await act(async () => { escape() })
    expect(imageClose).toHaveBeenCalledTimes(1); expect(confirmClose).not.toHaveBeenCalled(); expect(getPluginDialog()).not.toBeNull()
    await act(async () => { escape() })
    expect(confirmClose).toHaveBeenCalledTimes(1); expect(getPluginDialog()).not.toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    await act(async () => { escape() })
    expect(getPluginDialog()).toBeNull(); expect(document.body.style.overflow).toBe('')
  })

  it('a later independent modal wins over an older nested family', async () => {
    const imageClose = vi.fn(); const outerClose = vi.fn()
    function Content() { return createElement(Lightbox, { src: '/fixture.png', onClose: imageClose }) }
    function Later() { useModalOverlay(outerClose); return null }
    const render = (later: boolean) => root.render(createElement(StrictMode, null,
      createElement(Router, { location: '/', navigator }, createElement(PluginDialogHost), later ? createElement(Later) : null)))
    await act(async () => { render(false); slot('sample', 'record', Content as never); openPluginDialog('sample', 'record') })
    await act(async () => { render(true) })
    const event = new window.Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' })
    await act(async () => { document.dispatchEvent(event) })
    expect(outerClose).toHaveBeenCalledTimes(1); expect(imageClose).not.toHaveBeenCalled(); expect(getPluginDialog()).not.toBeNull()
    await act(async () => { render(false) })
    const next = new window.Event('keydown', { cancelable: true }); Object.assign(next, { key: 'Escape' })
    await act(async () => { document.dispatchEvent(next) })
    expect(imageClose).toHaveBeenCalledTimes(1); expect(outerClose).toHaveBeenCalledTimes(1); expect(getPluginDialog()).not.toBeNull()
  })

  it('a nested image preview owns Escape and keeps the plugin dialog scroll locked', async () => {
    const imageClose = vi.fn()
    const render = (image: boolean) => root.render(createElement(Router, { location: '/', navigator },
      createElement(PluginDialogHost), image ? createElement(Lightbox, { src: '/fixture.png', onClose: imageClose }) : null))
    await act(async () => { render(false); slot(); openPluginDialog('sample', 'record') })
    await act(async () => { render(true) })
    const escape = () => { const event = new window.Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' }); document.dispatchEvent(event) }
    await act(async () => { escape() })
    expect(imageClose).toHaveBeenCalledTimes(1); expect(getPluginDialog()).not.toBeNull()
    await act(async () => { render(false) })
    expect(document.body.style.overflow).toBe('hidden')
    await act(async () => { escape() })
    expect(getPluginDialog()).toBeNull(); expect(document.body.style.overflow).toBe('')
  })

  it('navigation closes underlying modal owners before pushing the new route', async () => {
    const taskClose = vi.fn()
    function TaskModal() { useModalOverlay(taskClose); return null }
    let navigate!: PluginDialogSlotProps['navigate']
    const Component = (props: PluginDialogSlotProps) => { navigate = props.navigate; return createElement('p', null, 'Record') }
    await act(async () => { root.render(createElement(Router, { location: '/', navigator }, createElement(TaskModal), createElement(PluginDialogHost))); slot('sample', 'record', Component as never); openPluginDialog('sample', 'record') })
    await act(async () => { navigate('/settings') })
    expect(getPluginDialog()).toBeNull(); expect(taskClose).toHaveBeenCalledTimes(1)
    expect(taskClose.mock.invocationCallOrder[0]).toBeLessThan(routeNavigate.mock.invocationCallOrder[0])
  })

  it('closes nested phone modals one back at a time and preserves the route beneath them', async () => {
    const historyDescriptor = Object.getOwnPropertyDescriptor(window, 'history')
    const mediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    const entries: unknown[] = [{ key: 'home' }, { key: 'plugin' }]
    let index = 1
    const traversals: number[] = []
    const visit = (delta: number) => {
      traversals.push(delta)
      setTimeout(() => {
        index = Math.max(0, index + delta)
        const event = new window.Event('popstate'); Object.assign(event, { state: entries[index] })
        window.dispatchEvent(event)
      }, 0)
    }
    const history = {
      get state() { return entries[index] },
      pushState(state: unknown) { entries.splice(index + 1); entries.push(state); index++ },
      replaceState(state: unknown) { entries[index] = state },
      back() { visit(-1) }, go(delta: number) { visit(delta) },
    }
    const taskClose = vi.fn()
    function PhoneTask() {
      const [open, setOpen] = useState(true)
      return open ? createElement(PhoneTaskBody, { close: () => { taskClose(); setOpen(false) } }) : null
    }
    function PhoneTaskBody({ close }: { close(): void }) {
      const layer = usePhoneOverlay({ id: 'sheet:test-task', kind: 'sheet', open: true, onClose: close })
      useModalOverlay(layer.close)
      return null
    }
    try {
      __resetPhoneOverlaysForTest()
      Object.defineProperty(window, 'history', { configurable: true, value: history })
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) })
      await act(async () => { root.render(createElement(Router, { location: '/', navigator }, createElement(PhoneTask), createElement(PluginDialogHost))) })
      await act(async () => { slot(); openPluginDialog('sample', 'record') })
      expect(phoneOverlayIds()).toHaveLength(2)
      const navigate = vi.fn()
      await act(async () => {
        closeModalOverlays(() => { navigate(); history.pushState({ key: 'settings' }) })
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
      })
      expect(traversals).toEqual([-1, -1])
      expect(taskClose).toHaveBeenCalledTimes(1)
      expect(getPluginDialog()).toBeNull()
      expect(phoneOverlayIds()).toEqual([])
      expect(navigate).toHaveBeenCalledTimes(1)
      expect(index).toBe(2)
      expect(stateWithoutMarker(entries[1])).toEqual({ key: 'plugin' })
      expect(entries[2]).toEqual({ key: 'settings' })
    } finally {
      await act(async () => { root.render(createElement(Router, { location: '/', navigator }, createElement(PluginDialogHost))) })
      __resetPhoneOverlaysForTest()
      if (historyDescriptor) Object.defineProperty(window, 'history', historyDescriptor)
      else Reflect.deleteProperty(window, 'history')
      if (mediaDescriptor) Object.defineProperty(window, 'matchMedia', mediaDescriptor)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('never leaves a null-rendering slot blank', async () => {
    await act(async () => { slot('sample', 'record', (() => null) as never); openPluginDialog('sample', 'record') })
    expect(text()).toContain('The plugin has no dialog content to show.')
  })

  it('reports a render failure without breaking the host or rendering another slot', async () => {
    const bad = () => { throw new Error('Fixture render failure') }
    await act(async () => { slot('sample', 'record', bad as never); slot('other'); openPluginDialog('sample', 'record') })
    expect(text()).toContain('could not render'); expect(mounted).not.toHaveBeenCalled()
    await act(async () => { closePluginDialog(getPluginDialog()!.sequence) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows a failed module without mounting unrelated dialog slots', async () => {
    await act(async () => { slot('other'); publishWebPluginRuntime({ ready: true, errors: [{ id: 'sample', error: 'Build failed' }] }); openPluginDialog('sample', 'record') })
    expect(text()).toContain('could not load'); expect(mounted).not.toHaveBeenCalled()
  })
})
