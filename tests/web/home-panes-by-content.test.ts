/**
 * Home's panes go by content (standard.md "Panes"; 2026-11-21 UI audit on the user's data):
 *   - nothing open beside the task panel: the room says what it is for (HomeEmptyPane), never a
 *     blank two thirds of the window;
 *   - the New task draft's mode cards sit right above the input they lead to, not centred
 *     hundreds of pixels above it;
 *   - the Quick question slot beside a column gets at least that column's share, in every order of
 *     opening and after a reload (the width is derived, never written by the program);
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
    expect(main).toMatch(/const homeRowEmpty = !phoneLayout && !chatVisible && sessionColumns\.length === 0 && !triagePanelOpen;/)
    expect(main).toMatch(/\{homeRowEmpty && \(\s*<HomeEmptyPane onNewTask=\{handleToolbarOpenLauncher\} \/>/)
    const pane = read('pages/HomeEmptyPane.tsx')
    expect(pane).toContain('No session open')
    // One New task, one look: the toolbar's own button, never a second one beside it.
    expect(pane).toMatch(/action=\{\{ label: 'Start a task', onClick: onNewTask, testId: 'home-empty-pane-start' \}\}/)
    // One control named New task on Home: the empty pane's button has its own name.
    expect(pane).not.toContain('NewLauncherButton')
    expect(rule(globals, '.home-empty-pane')).toMatch(/flex:\s*1/)
  })

  it('the draft body anchors its cards to the bottom, right above the composer', () => {
    const body = rule(globals, '.draft-session-body')
    expect(body).not.toMatch(/align-items:\s*center/)
    expect(rule(globals, '.draft-session-body > *')).toMatch(/margin-top:\s*auto/)
  })

  it('the session area\'s width is derived from the layout, and the task panel width ignores the sidebar', () => {
    // Round 2 capped it in an effect on the slot's opening and wrote the graduated width in another on
    // a column added: Quick question first then a column, or a reload with both open, missed the cap
    // (2026-11-22 review). The width shown is now one derivation (columnSizing.sessionAreaShownPct).
    expect(main).toMatch(/const sessionAreaShown = sessionAreaShownPct\(usersSessionWidth\(sessionPanel\), colCount, askSlot\)/)
    // The slot counts as shown only while it has something to read (an empty one keeps the smaller share).
    expect(main).toMatch(/const askSlot: QuickQuestionSlot = !chatVisible \|\| phoneLayout \? 'closed' : askSlotHasContent \? 'shown' : 'empty';/)
    expect(main).toMatch(/onContentChange=\{setAskSlotHasContent\}/)
    expect(read('components/chat/AskWalnutSlot.tsx')).toMatch(/onHistoryShown=\{onHistoryShown\}/)
    expect(main).toMatch(/style=\{sessionColumns\.length > 0 \|\| triagePanelOpen \? \{ width: `\$\{sessionAreaShown\}%` \} : undefined\}/)
    // Nothing writes the session area's width but a drag: no effect sizes it in turn.
    expect(main).not.toMatch(/sessionPanel\.setPct\(/)
    expect(main).not.toMatch(/sessionPanel\.width\b/)
    // A drag starts from the width that shows (a capped one too), never from the stored one.
    // ...and measures a drag against the content row its `${pct}%` is a share of (basis 'parent').
    expect(main).toMatch(/useResizablePanel\('walnut-session-panel-width-v2', 35, 'right', \{ measure: \(\) => sessionAreaShownRef\.current, basis: 'parent' \}\)/)
    expect(main).toMatch(/style=\{todoShown \? \{ width: todoWidth \} : undefined\}/)
    // Nothing open beside it: the task panel takes the room first, with its own width for that layout.
    expect(main).toMatch(/const todoAloneLayout = homeRowEmpty && !calendarVisible && !scratchpadVisible;/)
    expect(main).toMatch(/todoPanelAloneWidth\(todoAlone\.dragged \? todoAlone\.pct : null, todoPanel\.pct\)/)
    expect(main).toMatch(/<div className="todo-resize-handle" \{\.\.\.todoResize\.handleProps\} \/>/)
    expect(main).not.toMatch(/width: todoPanel\.width/)
    expect(rule(globals, '.main-page')).toMatch(/--home-rail-width:\s*56px/)
    expect(rule(globals, '.sidebar.collapsed')).toMatch(/width:\s*56px/)
  })

  it('every card-list page keeps a readable width', () => {
    for (const page of ['pages/AgentsPage.tsx', 'pages/CommandsPage.tsx']) {
      expect(read(page), page).toMatch(/return \(\s*<div className="page-readable">/)
    }
    expect(rule(globals, '.page-readable')).toMatch(/max-width:\s*880px/)
  })
})

describe('useResizablePanel: a dragged width is the user\'s', () => {
  const KEY = 'walnut-session-panel-width-v2'
  function memoryStorage(seed: Record<string, string>) {
    const m = new Map(Object.entries(seed))
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)) }, removeItem: (k: string) => { m.delete(k) }, raw: m }
  }

  it('a drag is the user\'s from its first move, stores its width with its mark, and a reload still knows', async () => {
    const store = memoryStorage({ [KEY]: '50' })
    vi.stubGlobal('localStorage', store)
    vi.stubGlobal('window', { innerWidth: 1000 })
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    // The width that shows is a capped 40, not the stored 50: the drag starts from what shows.
    const panel = useResizablePanel(KEY, 35, 'right', { measure: () => 40 })
    expect(panel.dragged).toBe(false)
    stateWrites.length = 0
    // The divider is left of the area ('right'): dragging 120 px left widens it by 12%.
    drag.onStart?.(); drag.onMove?.({ dx: -120 })
    // Mid-drag it is already his (no frame drawn as the program's width), and it moved from 40.
    expect(stateWrites).toEqual([true, true, 52])
    drag.onEnd?.()
    expect(store.raw.get(KEY)).toBe('52')
    expect(store.raw.get(`${KEY}:dragged`)).toBe('1')
    expect(useResizablePanel(KEY, 35)).toMatchObject({ pct: 52, dragged: true, custom: true })
    // A width a caller sets is no longer the user's.
    useResizablePanel(KEY, 35).setPct(40)
    expect(store.raw.get(KEY)).toBe('40')
    expect(store.raw.has(`${KEY}:dragged`)).toBe(false)
    vi.unstubAllGlobals()
  })

  it('a press that never moves sets nothing', async () => {
    const store = memoryStorage({})
    vi.stubGlobal('localStorage', store)
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    useResizablePanel(KEY, 35)
    stateWrites.length = 0
    drag.onStart?.(); drag.onEnd?.()
    expect(stateWrites).toEqual([])
    expect(store.raw.size).toBe(0)
    vi.unstubAllGlobals()
  })
})
