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
import { describe, expect, it } from 'vitest'

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

  it('every card-list page keeps a readable width', () => {
    for (const page of ['pages/AgentsPage.tsx', 'pages/CommandsPage.tsx']) {
      expect(read(page), page).toMatch(/return \(\s*<div className="page-readable">/)
    }
    expect(rule(globals, '.page-readable')).toMatch(/max-width:\s*880px/)
  })
})
