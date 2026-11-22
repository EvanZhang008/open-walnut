/**
 * Home's panes go by content (standard.md "Panes"; 2026-11-21 UI audit on the user's data):
 *   - nothing open beside the task panel: the room says what it is for (HomeEmptyPane), never a
 *     blank two thirds of the window;
 *   - the New task draft's mode cards sit right above the input they lead to, not centred
 *     hundreds of pixels above it;
 *   - the Quick question slot opened beside a column gets at least that column's share;
 *   - expanding the sidebar never narrows the task panel (its width is a share of the window
 *     less the collapsed rail, not of Home);
 *   - a page that is one list of cards keeps a readable width.
 * Source-level, so a rewrite that drops one of these fails here before a screenshot shows it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The resizable panel hook runs here without a DOM (the root vitest is `environment: 'node'`): React
// is mocked with stand-ins that record each state write, the drag gesture with a no-op. The frontend's
// React lives in web/node_modules, so the mock is keyed on that path (use-project-actions.test.ts).
const stateWrites: unknown[] = []
vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, (v: unknown) => { stateWrites.push(v) }] as const,
  useCallback: <T,>(fn: T) => fn,
  useRef: <T,>(current: T) => ({ current }),
  useEffect: () => {},
}))
// The drag's own handlers, so a test plays a drag the way the pointer does (start, move, end).
type Drag = { onStart?: () => void; onMove?: (d: { dx: number }) => void; onEnd?: () => void }
let drag: Drag = {}
vi.mock('../../web/src/hooks/useDragGesture', () => ({ useDragGesture: (opts: Drag) => { drag = opts; return { onPointerDown: () => {} } } }))

const WEB = path.resolve(__dirname, '../../web/src')
const read = (p: string) => fs.readFileSync(path.join(WEB, p), 'utf8')
const noComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
function rule(css: string, selector: string): string {
  const m = noComments(css).match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  return m?.[1] ?? ''
}

describe("Home's panes go by content", () => {
  const main = read('pages/MainPage.tsx')
  const globals = read('styles/globals.css')

  it('an empty Home row shows the empty room, with the toolbar\'s own New task action', () => {
    expect(main).toMatch(/!chatVisible && sessionColumns\.length === 0 && !triagePanelOpen && \(\s*<HomeEmptyPane onNewTask=\{handleToolbarOpenLauncher\} \/>/)
    const pane = read('pages/HomeEmptyPane.tsx')
    expect(pane).toContain('No session open')
    // One New task, one look: the toolbar's own button, never a second one beside it.
    expect(pane).toContain('<NewLauncherButton onOpen={onNewTask} />')
    expect(rule(globals, '.home-empty-pane')).toMatch(/flex:\s*1/)
  })

  it('the draft body anchors its cards to the bottom, right above the composer', () => {
    const body = rule(globals, '.draft-session-body')
    expect(body).not.toMatch(/align-items:\s*center/)
    expect(rule(globals, '.draft-session-body > *')).toMatch(/margin-top:\s*auto/)
  })

  it('opening the Quick question slot caps the columns at their share, and the task panel width ignores the sidebar', () => {
    expect(main).toMatch(/sessionAreaPctBesideChat\(count\)/)
    expect(main).toMatch(/style=\{todoShown \? \{ width: todoWidth \} : undefined\}/)
    expect(main).not.toMatch(/width: todoPanel\.width/)
    expect(rule(globals, '.main-page')).toMatch(/--home-rail-width:\s*56px/)
    expect(rule(globals, '.sidebar.collapsed')).toMatch(/width:\s*56px/)
  })

  it('the cap beside the Quick question never covers a width the user dragged, and is never stored', () => {
    // Round 1 stored the cap (setPct persists), so opening Quick question overwrote the width the user
    // had dragged, for good (2026-11-22 review). A width a caller set comes back when the slot closes.
    expect(main).toMatch(/count > 0 && !sessionPanel\.dragged && sessionPanel\.pct > cap/)
    expect(main).toMatch(/sessionPanel\.setPct\(cap, \{ save: false \}\)/)
    expect(main).toMatch(/if \(closed && cappedBesideChatRef\.current\) \{[^}]*sessionPanel\.restore\(\)/)
  })

  it('every card-list page keeps a readable width', () => {
    for (const page of ['pages/AgentsPage.tsx', 'pages/CommandsPage.tsx']) {
      expect(read(page), page).toMatch(/return \(\s*<div className="page-readable">/)
    }
    expect(rule(globals, '.page-readable')).toMatch(/max-width:\s*880px/)
  })
})

describe('useResizablePanel: a dragged width is the user\'s, a width for now only is never stored', () => {
  const KEY = 'walnut-session-panel-width-v2'
  function memoryStorage(seed: Record<string, string>) {
    const m = new Map(Object.entries(seed))
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)) }, removeItem: (k: string) => { m.delete(k) }, raw: m }
  }

  it('a drag stores its width and says it was dragged, and a reload still knows', async () => {
    const store = memoryStorage({ [KEY]: '50' })
    vi.stubGlobal('localStorage', store)
    vi.stubGlobal('window', { innerWidth: 1000 })
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    const panel = useResizablePanel(KEY, 35)
    expect(panel.dragged).toBe(false)
    // The divider is left of the area ('right'): dragging 120 px left widens it by 12%.
    drag.onStart?.(); drag.onMove?.({ dx: -120 }); drag.onEnd?.()
    expect(store.raw.get(KEY)).toBe('62')
    expect(store.raw.get(`${KEY}:dragged`)).toBe('1')
    expect(useResizablePanel(KEY, 35)).toMatchObject({ pct: 62, dragged: true })
    // A width a caller sets (the graduated one, a new column) is no longer the user's.
    useResizablePanel(KEY, 35).setPct(40)
    expect(store.raw.get(KEY)).toBe('40')
    expect(store.raw.has(`${KEY}:dragged`)).toBe(false)
    vi.unstubAllGlobals()
  })

  it('a width for now only leaves the stored one, and restore brings it back', async () => {
    const store = memoryStorage({ [KEY]: '62' })
    vi.stubGlobal('localStorage', store)
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    const panel = useResizablePanel(KEY, 35)
    stateWrites.length = 0
    panel.setPct(50, { save: false })
    expect(stateWrites).toEqual([50])
    expect(store.raw.get(KEY)).toBe('62')
    panel.restore()
    expect(stateWrites).toEqual([50, 62])
    expect(useResizablePanel(KEY, 35).pct).toBe(62)
    vi.unstubAllGlobals()
  })

  it('with nothing stored, restore goes back to the default', async () => {
    vi.stubGlobal('localStorage', memoryStorage({}))
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    const panel = useResizablePanel(KEY, 35)
    stateWrites.length = 0
    panel.setPct(50, { save: false })
    panel.restore()
    expect(stateWrites).toEqual([50, 35])
    vi.unstubAllGlobals()
  })
})
