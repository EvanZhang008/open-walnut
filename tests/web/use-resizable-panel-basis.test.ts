/**
 * A resizable panel's divider follows the pointer (2026-11-22): useResizablePanel turned a drag's
 * px into % of the WINDOW, while Home's session area draws `${pct}%` of the content row beside the
 * task panel, so the divider moved row/window of the pointer's distance (about 70% with the task
 * panel open). The class: every caller whose width is a share of something other than the window
 * (the session area, the task panel's window-less-rail, the session chat column, the diff tree).
 * The hook now measures a drag against the caller's `basis`; the guard below reads every caller
 * from source, so a new one must say what its 100% is.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// No DOM here (root vitest is `environment: 'node'`): React and the drag gesture are stand-ins,
// as in home-panes-by-content.test.ts, so a test plays a drag as start, move, end.
const stateWrites: unknown[] = []
vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T | (() => T)) => [typeof initial === 'function' ? (initial as () => T)() : initial, (v: unknown) => { stateWrites.push(v) }] as const,
  useCallback: <T,>(fn: T) => fn,
  useRef: <T,>(current: T) => ({ current }),
  useEffect: () => {},
}))
type Drag = { onStart?: () => void; onMove?: (d: { dx: number }) => void; onEnd?: () => void }
let drag: Drag = {}
vi.mock('../../web/src/hooks/useDragGesture', () => ({ useDragGesture: (opts: Drag) => { drag = opts; return { onPointerDown: () => {} } } }))

import { dragPct } from '../../web/src/hooks/useResizablePanel'
import { todoPanelBasisPx } from '../../web/src/pages/columnSizing'

const WEB = path.resolve(__dirname, '../../web/src')

/** Where a panel's divider sits for a width `pct` of `basisPx`, given its far edge at 0. */
const edgePx = (pct: number, basisPx: number) => (pct / 100) * basisPx

describe('dragPct: the divider moves as far as the pointer', () => {
  it.each([
    // [what, basis px, start %, dx, direction]
    ['session area in the content row beside the task panel', 1092, 40, -150, 'right'],
    ['session area, dragged narrower', 1092, 55, 90, 'right'],
    ['task panel in the window less the rail', 1456, 25, 200, 'left'],
    ['diff tree in a narrow diff body', 520, 22, 60, 'left'],
  ] as const)('%s', (_what, basis, start, dx, dir) => {
    const next = dragPct(start, dx, dir, basis)
    const moved = edgePx(next, basis) - edgePx(start, basis)
    // A panel right of its handle grows as the pointer goes left: its divider moves by dx.
    const dividerMoved = dir === 'right' ? -moved : moved
    expect(Math.abs(dividerMoved - dx)).toBeLessThan(2)
  })

  it('the old window basis missed by row/window of the drag (the bug)', () => {
    const next = dragPct(40, -150, 'right', 1512)
    expect(Math.abs(edgePx(next, 1092) - edgePx(40, 1092)) - 150).toBeLessThan(-2)
  })

  it("the task panel's basis is the window less the rail, the room todoPanelWidth sizes it in", () => {
    expect(todoPanelBasisPx(1512, 56)).toBe(1456)
    expect(todoPanelBasisPx(1280, Number.NaN)).toBe(1224)
  })
})

describe('useResizablePanel reads its basis at grab time', () => {
  function memoryStorage() {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)) }, removeItem: (k: string) => { m.delete(k) } }
  }

  it('a getter basis: 120 px left in a 600 px box widens a right-hand panel by 20%', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('window', { innerWidth: 1500 })
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    useResizablePanel('k-getter', 30, 'right', { basis: () => 600 })
    stateWrites.length = 0
    drag.onStart?.(); drag.onMove?.({ dx: -120 })
    expect(stateWrites.at(-1)).toBeCloseTo(50, 5)
    vi.unstubAllGlobals()
  })

  it("'parent': the panel's containing box less padding, past a display: contents wrapper", async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('window', { innerWidth: 1500 })
    const row = { clientWidth: 820, parentElement: null, style: { display: 'flex', paddingLeft: '10px', paddingRight: '10px' } }
    const wrapper = { clientWidth: 0, parentElement: row, style: { display: 'contents', paddingLeft: '0', paddingRight: '0' } }
    vi.stubGlobal('getComputedStyle', (el: { style: object }) => el.style)
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    const panel = useResizablePanel('k-parent', 25, 'left', { basis: 'parent' })
    ;(panel.panelRef as { current: unknown }).current = { parentElement: wrapper, classList: { add() {}, remove() {} } }
    stateWrites.length = 0
    // 80 px right in an 800 px content box: 10% wider.
    drag.onStart?.(); drag.onMove?.({ dx: 80 })
    expect(stateWrites.at(-1)).toBeCloseTo(35, 5)
    vi.unstubAllGlobals()
  })

  it('no basis (or nothing to measure) keeps the window, for panels sized in vw', async () => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('window', { innerWidth: 1000 })
    const { useResizablePanel } = await import('../../web/src/hooks/useResizablePanel')
    useResizablePanel('k-vw', 30, 'right', { basis: () => null })
    stateWrites.length = 0
    drag.onStart?.(); drag.onMove?.({ dx: -100 })
    expect(stateWrites.at(-1)).toBeCloseTo(40, 5)
    vi.unstubAllGlobals()
  })
})

describe('every useResizablePanel caller says what its 100% is', () => {
  // Enumerated from source: a caller with no `basis` must draw its width in vw (the hook's
  // default basis), so a new panel sized in its parent cannot silently drift from the pointer.
  const calls: Array<{ file: string; args: string }> = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name) || entry.name === 'useResizablePanel.ts') continue
      const src = fs.readFileSync(full, 'utf8')
      for (const m of src.matchAll(/useResizablePanel\(([^;]*?)\);/g)) calls.push({ file: path.relative(WEB, full), args: m[1]! })
    }
  }
  walk(WEB)

  it('finds the known callers', () => {
    expect(new Set(calls.map((c) => c.file))).toEqual(new Set([
      'pages/MainPage.tsx', 'pages/OrgPage.tsx', 'components/org/OrgNodeDetail.tsx',
      'components/sessions/SessionPanel.tsx', 'components/sessions/SessionDiffView.tsx',
    ]))
  })

  it.each(['pages/MainPage.tsx', 'components/sessions/SessionPanel.tsx', 'components/sessions/SessionDiffView.tsx'])(
    '%s: every panel passes a basis', (file) => {
      for (const c of calls.filter((x) => x.file === file)) expect(c.args, `${file}: ${c.args}`).toMatch(/\bbasis:/)
    },
  )

  it('a caller without a basis draws its width in vw', () => {
    for (const c of calls.filter((x) => !/\bbasis:/.test(x.args))) {
      const src = fs.readFileSync(path.join(WEB, c.file), 'utf8')
      expect(src, `${c.file} has a panel with no basis that is not sized in vw`).toMatch(/\.pct\}vw/)
    }
  })
})
