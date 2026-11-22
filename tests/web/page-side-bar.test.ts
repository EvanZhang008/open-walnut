/**
 * The Agenda and Scratchpad side bar beside every page but Home (web/src/components/layout/
 * page-side-bar.ts): which page a route's view belongs to, which kept views this build reads,
 * and the width it draws. The real column runs in tests/e2e/browser/page-side-bar.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SIDE_BAR_WIDTH_DEFAULT, SIDE_BAR_WIDTH_MAX, SIDE_BAR_WIDTH_MIN,
  isPageSideBarView, sideBarPageOf, sideBarWidth, storedPaneWidth, withPaneWidth,
} from '../../web/src/components/layout/page-side-bar'

describe('sideBarPageOf', () => {
  it('gives Home no page: Home keeps its own column', () => {
    expect(sideBarPageOf('/')).toBeNull()
    expect(sideBarPageOf('')).toBeNull()
  })

  it('keeps one view per route section', () => {
    expect(sideBarPageOf('/org')).toBe('org')
    expect(sideBarPageOf('/notes/projects/plan.md')).toBe('notes')
    expect(sideBarPageOf('/calendar')).toBe('calendar')
    expect(sideBarPageOf('/settings')).toBe('settings')
    expect(sideBarPageOf('/tasks')).toBe('tasks')
  })

  it('keeps one view per plugin app, whatever page of it shows', () => {
    expect(sideBarPageOf('/apps/walnut-time~main')).toBe('app:walnut-time~main')
    expect(sideBarPageOf('/apps/walnut-time~main/week')).toBe('app:walnut-time~main')
    expect(sideBarPageOf('/apps/a%20b/x')).toBe('app:a b')
    // A malformed escape is kept as written rather than throwing.
    expect(sideBarPageOf('/apps/%E0%A4%A')).toBe('app:%E0%A4%A')
    expect(sideBarPageOf('/apps')).toBe('apps')
  })
})

describe('isPageSideBarView', () => {
  it('reads what this build writes', () => {
    expect(isPageSideBarView({ agenda: true, scratchpad: false })).toBe(true)
    expect(isPageSideBarView({ agenda: false, scratchpad: true, width: 360 })).toBe(true)
    expect(isPageSideBarView({ agenda: true, scratchpad: true, width: 360, scratchpadWidth: 300 })).toBe(true)
  })

  it('reads anything else as nothing kept', () => {
    for (const v of [null, undefined, 1, 'open', [], {}, { agenda: true }, { agenda: 'yes', scratchpad: false },
      { agenda: true, scratchpad: false, width: '360px' }, { agenda: true, scratchpad: false, width: Number.NaN },
      { agenda: true, scratchpad: true, scratchpadWidth: '300' }]) {
      expect(isPageSideBarView(v), JSON.stringify(v)).toBe(false)
    }
  })
})

describe('sideBarWidth', () => {
  it('starts at the default width', () => {
    expect(sideBarWidth(undefined, 1600)).toBe(SIDE_BAR_WIDTH_DEFAULT)
  })

  it('keeps a dragged width inside its bounds', () => {
    expect(sideBarWidth(100, 1600)).toBe(SIDE_BAR_WIDTH_MIN)
    expect(sideBarWidth(5000, 3000)).toBe(SIDE_BAR_WIDTH_MAX)
    expect(sideBarWidth(333.6, 1600)).toBe(334)
  })

  it('never takes more than half the window, and never less than its minimum', () => {
    expect(sideBarWidth(700, 1000)).toBe(500)
    expect(sideBarWidth(400, 400)).toBe(SIDE_BAR_WIDTH_MIN)
  })
})

describe('two side bars side by side', () => {
  it('each keeps its own width; a scratchpad never dragged starts at the old one-column width', () => {
    expect(storedPaneWidth({ agenda: true, scratchpad: true, width: 520, scratchpadWidth: 340 }, 'agenda')).toBe(520)
    expect(storedPaneWidth({ agenda: true, scratchpad: true, width: 520, scratchpadWidth: 340 }, 'scratchpad')).toBe(340)
    expect(storedPaneWidth({ agenda: true, scratchpad: true, width: 520 }, 'scratchpad')).toBe(520)
    expect(storedPaneWidth({ agenda: true, scratchpad: true }, 'scratchpad')).toBeUndefined()
  })

  it('a drag of one side bar never moves the other, an old one-column width included', () => {
    const old = { agenda: true, scratchpad: true, width: 520 }
    const dragged = withPaneWidth(old, 'agenda', 400)
    expect(storedPaneWidth(dragged, 'agenda')).toBe(400)
    expect(storedPaneWidth(dragged, 'scratchpad')).toBe(520)
    expect(withPaneWidth(dragged, 'scratchpad', 300)).toEqual({ agenda: true, scratchpad: true, width: 400, scratchpadWidth: 300 })
    expect(withPaneWidth({ agenda: true, scratchpad: true }, 'agenda', 450)).toEqual({ agenda: true, scratchpad: true, width: 450 })
    expect(withPaneWidth(dragged, 'agenda', 400)).toBe(dragged)
  })

  it('never takes more than 30% of the window each while both show', () => {
    expect(sideBarWidth(700, 1440, true)).toBe(432)
    expect(sideBarWidth(700, 1440, false)).toBe(700)
    expect(sideBarWidth(undefined, 1440, true)).toBe(SIDE_BAR_WIDTH_DEFAULT)
    expect(sideBarWidth(400, 800, true)).toBe(SIDE_BAR_WIDTH_MIN)
  })
})

/**
 * The side bar is a column at every width: laid over the page it hid the page's first column (2026-11-22
 * review: the Scratchpad over the Notes tree and its search at 1024). Every stylesheet is read, so a
 * new rule that floats it again fails here.
 */
describe('the page side bar never lies over the page', () => {
  const dir = path.resolve(__dirname, '../../web/src/styles')
  const sheets = fs.readdirSync(dir).filter((f) => f.endsWith('.css'))
  it('no stylesheet positions .page-side-bar absolute or fixed', () => {
    const hits: string[] = []
    for (const f of sheets) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        const selectors = m[1].split(',').map((x) => x.trim())
        if (selectors.some((x) => /\.page-side-bar$/.test(x)) && /position:\s*(absolute|fixed)/.test(m[2])) hits.push(`${f}: ${m[1].trim()}`)
      }
    }
    expect(hits).toEqual([])
  })
  it('lets the side bar give way while the page keeps half the row', () => {
    const css = fs.readFileSync(path.join(dir, 'home-navigation.css'), 'utf8')
    expect(css).toMatch(/\.page-side-bar \{ flex-shrink: 1; min-width: 0; \}/)
    expect(css).toMatch(/\.main-content-row > \.page-side-bar ~ \.app-content-area \{ min-width: min\(420px, 50%\); \}/)
  })
})
