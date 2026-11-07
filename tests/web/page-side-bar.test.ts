/**
 * The Agenda and Scratchpad side bar beside every page but Home (web/src/components/layout/
 * page-side-bar.ts): which page a route's view belongs to, which kept views this build reads,
 * and the width it draws. The real column runs in tests/e2e/browser/page-side-bar.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import {
  SIDE_BAR_WIDTH_DEFAULT, SIDE_BAR_WIDTH_MAX, SIDE_BAR_WIDTH_MIN,
  isPageSideBarView, sideBarPageOf, sideBarWidth,
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
  })

  it('reads anything else as nothing kept', () => {
    for (const v of [null, undefined, 1, 'open', [], {}, { agenda: true }, { agenda: 'yes', scratchpad: false },
      { agenda: true, scratchpad: false, width: '360px' }, { agenda: true, scratchpad: false, width: Number.NaN }]) {
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
