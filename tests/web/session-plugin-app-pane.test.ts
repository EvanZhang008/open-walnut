/**
 * The App view of a session split (SessionPluginAppPane), rendered for real:
 *
 *   props      the App gets the session, its task, its own path, the pane id and the document
 *              kept for THAT App; its document changes and Close reach the host
 *   focus      the pane takes the focus only when a person opened it (takeFocus), never when a
 *              kept view brings it back, and never over a control the App focused itself
 *   identity   another pane id or a re-registered App (new generation) remounts the App; a
 *              plain re-render does not
 *   lifecycle  the App's plugin off: "not available" (or loading while plugins load), with Close
 *   boundary   an App that throws shows the plugin's error under the bar, and Close still works
 *   tabs       several Apps: one tab each, a click picks another
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, useEffect, StrictMode } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { RegisteredApp, SessionAppProps } from '../../web/src/apps/registry'

const state = vi.hoisted(() => ({
  all: [] as unknown[],
  discoverable: [] as unknown[],
  runtime: { ready: true, loading: false, plugins: [] as unknown[] },
}))
vi.mock('@/apps/hooks', () => ({ useAppCatalog: () => ({ all: state.all, discoverable: state.discoverable }) }))
vi.mock('@/plugins/runtime-store', () => ({ useWebPluginRuntime: () => state.runtime }))
vi.mock('@/plugins/PluginBounds', async () => {
  const react = await import('../../web/node_modules/react/index.js')
  return {
    PluginBounds: ({ children, className, ...rest }: Record<string, unknown>) =>
      react.createElement('div', { ...rest, className: `${String(className ?? '')} plugin-bounds` }, children as never),
  }
})
vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')
const { SessionPluginAppPane, pickPaneApp } = await import('../../web/src/components/sessions/SessionPluginAppPane')

let seen: SessionAppProps | null = null
let mounts = 0
function SketchPane(props: SessionAppProps) {
  seen = props
  useEffect(() => { mounts++ }, [])
  return createElement('div', { 'data-testid': 'sketch-pane' }, props.documentPath ?? 'no document')
}
function FocusingPane() {
  useEffect(() => { (document.getElementById('own-input') as HTMLElement | null)?.focus() }, [])
  return createElement('input', { id: 'own-input' })
}
function BrokenPane(): never { throw new Error('canvas exploded') }

const app = (key: string, title: string, pane: unknown, generation = 1): RegisteredApp => ({
  key, id: key.split(':')[1], owner: key.split(':')[0], kind: 'native', title,
  path: `/apps/${key.replace(':', '~')}`, routeId: key.replace(':', '~'), badge: null, order: 500,
  fullBleed: true, placement: 'settings', persistent: false, lockVisibility: false, generation,
  pluginId: key.split(':')[0], pluginName: title, component: () => null, sessionPane: pane as never,
})

let doc: Document
let el: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let focused: HTMLElement | null = null
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  doc = dom.document as unknown as Document
  ;(dom.window as unknown as { HTMLElement: { prototype: { focus: () => void } } }).HTMLElement.prototype.focus = function (this: HTMLElement) { focused = this }
  Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => focused ?? doc.body })
})
beforeEach(() => {
  seen = null; mounts = 0; focused = null
  state.runtime = { ready: true, loading: false, plugins: [] }
  el = doc.createElement('div'); doc.body.appendChild(el); root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

const frame = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
function base(over: Partial<Parameters<typeof SessionPluginAppPane>[0]> = {}) {
  return {
    sessionId: 's-1', taskId: 't-1', cwd: '/work/repo', paneId: 'home-column|s-1',
    record: { key: 'sketch:main', docs: { 'sketch:main': 'plans/board.excalidraw', 'other:pane': 'x' } },
    onPickApp: vi.fn(), onDocumentPathChange: vi.fn(), onClose: vi.fn(), takeFocus: () => false,
    ...over,
  }
}
const render = async (props: ReturnType<typeof base>) => {
  await act(async () => { root!.render(createElement(MemoryRouter, null, createElement(SessionPluginAppPane, props))) })
}
const sketch = app('sketch:main', 'Sketch', SketchPane)

describe('the App view pane', () => {
  beforeEach(() => { state.all = [sketch]; state.discoverable = [sketch] })

  it('hands the App its session, its own path, the pane id and its own document', async () => {
    const props = base()
    await render(props)
    expect(el.querySelector('.plugin-bounds [data-testid="sketch-pane"]')?.textContent).toBe('plans/board.excalidraw')
    expect(seen).toMatchObject({ sessionId: 's-1', taskId: 't-1', cwd: '/work/repo', basePath: '/apps/sketch~main', paneId: 'home-column|s-1', documentPath: 'plans/board.excalidraw' })
    expect(seen && 'host' in seen).toBe(false)
    seen!.onDocumentPathChange('plans/next.excalidraw')
    expect(props.onDocumentPathChange).toHaveBeenCalledWith('sketch:main', 'plans/next.excalidraw')
    seen!.onClose()
    ;(el.querySelector('[data-testid="session-app-pane-close"]') as HTMLButtonElement).click()
    expect(props.onClose).toHaveBeenCalledTimes(2)
    expect(el.querySelector('.session-app-pane-title')?.textContent).toBe('Sketch')
  })

  it('shows the first App offered when nothing was picked yet', async () => {
    await render(base({ record: null }))
    expect(seen?.documentPath).toBeUndefined()
    expect(el.querySelector('[data-testid="session-app-pane"]')?.getAttribute('data-app-key')).toBe('sketch:main')
  })

  it('takes the focus when a person opened it, not on a restore, and not over the App own focus', async () => {
    await render(base({ takeFocus: () => false }))
    await frame()
    expect(focused).toBeNull()
    await act(async () => { root!.unmount() }); root = createRoot(el)

    await render(base({ takeFocus: () => true }))
    await frame()
    expect(focused?.classList.contains('session-app-pane-focus')).toBe(true)
    await act(async () => { root!.unmount() }); root = createRoot(el); focused = null

    const focusing = app('sketch:main', 'Sketch', FocusingPane)
    state.all = [focusing]; state.discoverable = [focusing]
    await render(base({ takeFocus: () => true }))
    await frame()
    expect(focused?.id).toBe('own-input')
  })

  it('keeps a one-shot focus wish when its effect runs twice (StrictMode, the dev build)', async () => {
    // The panel's takeFocus answers true once. The first effect's frame is cancelled by
    // StrictMode's cleanup, so the wish must still be there for the second one.
    let wanted = true
    const takeFocus = () => { const w = wanted; wanted = false; return w }
    await act(async () => {
      root!.render(createElement(StrictMode, null, createElement(MemoryRouter, null, createElement(SessionPluginAppPane, base({ takeFocus })))))
    })
    await frame()
    expect(focused?.classList.contains('session-app-pane-focus')).toBe(true)
  })

  it('remounts the App for another pane or a re-registered App, not for a re-render', async () => {
    await render(base())
    expect(mounts).toBe(1)
    await render(base({ cwd: '/work/other' }))
    expect(mounts).toBe(1)
    await render(base({ paneId: 'ask-slot|s-1' }))
    expect(mounts).toBe(2)
    const reloaded = app('sketch:main', 'Sketch', SketchPane, 2)
    state.all = [reloaded]; state.discoverable = [reloaded]
    await render(base({ paneId: 'ask-slot|s-1' }))
    expect(mounts).toBe(3)
  })

  it('says the App is not available when its plugin is off, and loading while plugins load', async () => {
    state.all = []; state.discoverable = []
    state.runtime = { ready: false, loading: true, plugins: [] }
    const props = base()
    await render(props)
    expect(el.querySelector('[data-testid="session-app-pane-empty"]')?.textContent).toBe('Loading the App…')
    state.runtime = { ready: true, loading: false, plugins: [] }
    await render(props)
    expect(el.querySelector('[data-testid="session-app-pane-empty"]')?.textContent).toMatch(/not available/)
    ;(el.querySelector('[data-testid="session-app-pane-close"]') as HTMLButtonElement).click()
    expect(props.onClose).toHaveBeenCalledOnce()
    // Back on: the same kept record shows the App again.
    state.all = [sketch]; state.discoverable = [sketch]
    await render(props)
    expect(el.querySelector('[data-testid="sketch-pane"]')?.textContent).toBe('plans/board.excalidraw')
  })

  it('keeps an App that throws inside its boundary, under a bar that still closes', async () => {
    const broken = app('sketch:main', 'Sketch', BrokenPane)
    state.all = [broken]; state.discoverable = [broken]
    const props = base()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await render(props)
    consoleError.mockRestore()
    expect(el.querySelector('.plugin-error-boundary')?.textContent).toContain('canvas exploded')
    ;(el.querySelector('[data-testid="session-app-pane-close"]') as HTMLButtonElement).click()
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('draws one tab per App when several offer a pane', async () => {
    const other = app('other:pane', 'Other', SketchPane)
    state.all = [sketch, other]; state.discoverable = [sketch, other]
    const props = base()
    await render(props)
    const tabs = Array.from(el.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toEqual([['Sketch', 'true'], ['Other', 'false']])
    tabs[0].click()
    expect(props.onPickApp).not.toHaveBeenCalled()
    tabs[1].click()
    expect(props.onPickApp).toHaveBeenCalledWith('other:pane')
  })
})

describe('pickPaneApp', () => {
  it('never resolves an App without a pane, even when the key names one', () => {
    const plain = { ...app('plain:main', 'Plain', undefined), sessionPane: undefined }
    expect(pickPaneApp({ key: 'plain:main' }, [], [plain]).app).toBeUndefined()
    expect(pickPaneApp(null, [], [plain])).toEqual({ key: null, app: undefined })
  })
})
