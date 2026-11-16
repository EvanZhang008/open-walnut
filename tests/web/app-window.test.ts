/**
 * An app in a window of its own (the sidebar's "Open in new window"): its address, its window
 * name, the popup features that make a browser open a WINDOW rather than a tab, and the open
 * that brings an existing window forward instead of a second one.
 *
 * 2026-11-16, the user: "app right click sould pen a pannel shud open in another window, work in
 * chrome and mac app". The Mac app finds the window already showing an address by the exact
 * address (desktop/LinkPolicy.swift `isSameWindowTarget`), so the address must name the app
 * alone and never change while the window is open.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appWindowFeatures,
  appWindowName,
  appWindowPath,
  canOpenAppWindow,
  isPopoutPath,
  openAppWindow,
} from '../../web/src/popout/openPopout.js'
import { isPopoutView } from '../../web/src/popout/popout-views.js'
import { appWindowPlaceKey, appWindowStart, isPlaceInApp } from '../../web/src/popout/app-window-place.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('the app window address', () => {
  it('names the app by its key on the pop-out route, and is the same every time', () => {
    expect(appWindowPath('core:calendar')).toBe('/popout?view=app&app=core%3Acalendar')
    expect(appWindowPath('walnut-drawing:main')).toBe('/popout?view=app&app=walnut-drawing%3Amain')
    expect(appWindowPath('webview:board')).toBe(appWindowPath('webview:board'))
    expect(isPopoutPath(appWindowPath('core:notes').split('?')[0]!)).toBe(true)
    expect(isPopoutView(new URLSearchParams(appWindowPath('core:notes').split('?')[1]).get('view'))).toBe(true)
  })

  it('gives each app one window name, different from every other app', () => {
    expect(appWindowName('core:calendar')).toBe('walnut-app-core:calendar')
    expect(appWindowName('core:calendar')).not.toBe(appWindowName('core:notes'))
    expect(appWindowPath('core:calendar')).not.toBe(appWindowPath('core:notes'))
  })

  it('is offered for every app with a page, never Home (Home is the console)', () => {
    expect(canOpenAppWindow({ path: '/' })).toBe(false)
    for (const p of ['/notes', '/settings', '/apps', '/apps/walnut-drawing~main', '/apps/board']) {
      expect(canOpenAppWindow({ path: p }), p).toBe(true)
    }
  })
})

describe('the popup features', () => {
  const box = { screenX: 100, screenY: 50, outerWidth: 1600, outerHeight: 1000, screen: { availWidth: 1920, availHeight: 1080 } }

  it('ask for a popup about 1200 by 800, centred over the window it came from', () => {
    expect(appWindowFeatures(box)).toBe('popup=yes,width=1200,height=800,left=300,top=150')
  })

  it('never ask for more than the screen has, nor a place off its edge', () => {
    const small = { screenX: 0, screenY: 0, outerWidth: 900, outerHeight: 600, screen: { availWidth: 1000, availHeight: 700 } }
    expect(appWindowFeatures(small)).toBe('popup=yes,width=1000,height=700,left=0,top=0')
  })
})

describe('openAppWindow', () => {
  type Opened = { location: { href: string; replace: ReturnType<typeof vi.fn> }; focus: ReturnType<typeof vi.fn> }
  const g = globalThis as unknown as { window?: unknown }
  let saved: unknown
  let open: ReturnType<typeof vi.fn>

  const opened = (href: string): Opened => ({ location: { href, replace: vi.fn() }, focus: vi.fn() })
  const stubWindow = (answers: Array<Opened | null>) => {
    open = vi.fn(() => answers.shift() ?? null)
    g.window = {
      open,
      location: { origin: 'http://127.0.0.1:3456' },
      screenX: 0, screenY: 0, outerWidth: 1400, outerHeight: 900,
      screen: { availWidth: 1400, availHeight: 900 },
    }
  }
  const URL_OF = 'http://127.0.0.1:3456/popout?view=app&app=core%3Acalendar'

  beforeEach(() => { saved = g.window })
  afterEach(() => { g.window = saved })

  it('sends a new (blank) window to the app and focuses it', () => {
    const w = opened('about:blank')
    stubWindow([w])
    expect(openAppWindow('core:calendar')).toBe(w)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open.mock.calls[0]![0]).toBe('')
    expect(open.mock.calls[0]![1]).toBe('walnut-app-core:calendar')
    expect(open.mock.calls[0]![2]).toMatch(/^popup=yes,width=1200,height=800,/)
    expect(w.location.replace).toHaveBeenCalledWith(URL_OF)
    expect(w.focus).toHaveBeenCalled()
  })

  it('brings the window already showing the app forward without reloading it (the place in the app stays)', () => {
    const w = opened(`${URL_OF}`)
    stubWindow([w])
    expect(openAppWindow('core:calendar')).toBe(w)
    expect(w.location.replace).not.toHaveBeenCalled()
    expect(w.focus).toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('sends a window of that name that left the app back to it before focusing it', () => {
    // Another site, another page of the console, another app's window address, an unreadable window.
    const away = [
      opened('https://example.com/elsewhere'),
      opened('http://127.0.0.1:3456/notes'),
      opened('http://127.0.0.1:3456/popout?view=app&app=core%3Anotes'),
    ]
    const crossOrigin = { location: { replace: vi.fn() }, focus: vi.fn() }
    Object.defineProperty(crossOrigin.location, 'href', { get() { throw new DOMException('Blocked a frame', 'SecurityError') } })
    for (const w of [...away, crossOrigin]) {
      stubWindow([w as Opened])
      expect(openAppWindow('core:calendar')).toBe(w)
      expect(w.location.replace).toHaveBeenCalledWith(URL_OF)
      expect(w.focus).toHaveBeenCalled()
      expect(w.location.replace.mock.invocationCallOrder[0]!).toBeLessThan(w.focus.mock.invocationCallOrder[0]!)
    }
    // Still in the app, only its hash moved: left as it is.
    const hashed = opened(`${URL_OF}#addLibrary=x`)
    stubWindow([hashed])
    openAppWindow('core:calendar')
    expect(hashed.location.replace).not.toHaveBeenCalled()
  })

  it('in the Mac app, opens the address itself and never an empty one (that reached macOS as a -50 dialog)', () => {
    stubWindow([null, null])
    ;(g.window as { webkit?: unknown }).webkit = { messageHandlers: { walnutChrome: {} } }
    openAppWindow('core:calendar')
    openAppWindow('core:calendar')
    expect(open.mock.calls.map((c) => c[0])).toEqual([URL_OF, URL_OF])
    expect(open.mock.calls[0]![1]).toBe('walnut-app-core:calendar')
  })

  it('opens the address itself where an empty open gives no window (an older shell), the same address each time', () => {
    stubWindow([null, null, null, null])
    openAppWindow('core:calendar')
    openAppWindow('core:calendar')
    expect(open).toHaveBeenCalledTimes(4)
    expect(open.mock.calls[1]![0]).toBe(URL_OF)
    expect(open.mock.calls[3]![0]).toBe(URL_OF)
    expect(open.mock.calls[1]![1]).toBe('walnut-app-core:calendar')
  })
})

describe('the Mac app opens and refinds the window by its address', () => {
  const policy = read('desktop/LinkPolicy.swift')

  it('a same-origin window.open becomes an app window, and an empty one is cancelled', () => {
    // An empty address (window.open('', name)) is nothing to open: cancelled, never handed to macOS.
    expect(policy).toMatch(/if scheme\.isEmpty \{ return \.ignore \}/)
    expect(policy).toMatch(/if request\.targetsNewWindow \{\s*if isAppOrigin\(url\) \{ return \.openInAppWindow \}/)
    expect(read('desktop/main.swift')).toMatch(/linkPolicy\.isSameWindowTarget\(current, url\)/)
  })

  it('only session and task windows are matched by id; an app window is matched by its exact address', () => {
    expect(policy).toMatch(/guard view == "session" \|\| view == "task",/)
    expect(policy).toMatch(/return current == requested/)
  })

  it('so the app window keeps its address: its moves go through a router in memory, never the window history', () => {
    const view = read('web/src/popout/PopoutAppView.tsx')
    expect(view).toMatch(/<AppOwnRouter start=\{start\}>/)
    expect(view).not.toMatch(/history\.(pushState|replaceState)/)
    expect(read('web/src/popout/AppOwnRouter.tsx')).toMatch(/<MemoryRouter initialEntries=\{\[start\]\}>/)
  })
})

describe("the app's own router inside the window's", () => {
  it('draws without React Router refusing it; the app reads its own place, the hooks above read the window', async () => {
    const { createElement: h } = await import('../../web/node_modules/react/index.js')
    const { renderToStaticMarkup } = await import('../../web/node_modules/react-dom/server.node.js')
    const { MemoryRouter, useLocation } = await import('../../web/node_modules/react-router-dom')
    const { AppOwnRouter } = await import('../../web/src/popout/AppOwnRouter')
    const Where = ({ label }: { label: string }) => {
      const at = useLocation()
      return h('i', null, `${label}=${at.pathname}${at.search}`)
    }
    const html = renderToStaticMarkup(
      h(MemoryRouter, { initialEntries: ['/popout?view=app&app=core%3Acalendar'] },
        h(Where, { label: 'window' }),
        h(AppOwnRouter, { start: '/calendar?view=week' }, h(Where, { label: 'app' }))),
    )
    expect(html).toContain('window=/popout?view=app&amp;app=core%3Acalendar')
    expect(html).toContain('app=/calendar?view=week')
  })
})

describe('where an app window is in its app', () => {
  const calendar = { kind: 'core' as const, path: '/calendar' }
  const drawing = { kind: 'native' as const, path: '/apps/walnut-drawing~main' }

  it('a built-in app has its one page; a plugin App has its subtree', () => {
    expect(isPlaceInApp(calendar, '/calendar?view=week&d=2026-11-16')).toBe(true)
    expect(isPlaceInApp(calendar, '/calendar/other')).toBe(false)
    expect(isPlaceInApp(calendar, '/settings#usage')).toBe(false)
    expect(isPlaceInApp(drawing, '/apps/walnut-drawing~main?path=a.excalidraw')).toBe(true)
    expect(isPlaceInApp(drawing, '/apps/walnut-drawing~main/edit')).toBe(true)
    expect(isPlaceInApp(drawing, '/apps/walnut-drawing~mainx')).toBe(false)
  })

  it('opens where the window was before a reload, else where the console last was, else the app', () => {
    expect(appWindowStart(calendar, '/calendar?view=month', '/calendar?view=week')).toBe('/calendar?view=month')
    expect(appWindowStart(calendar, null, '/calendar?view=week')).toBe('/calendar?view=week')
    expect(appWindowStart(calendar, '/settings', '/notes')).toBe('/calendar')
    expect(appWindowPlaceKey('core:calendar')).toBe('walnut-app-window-place:core:calendar')
  })
})
