/**
 * A session's title row keeps one height from its first frame: while the session loads the kebab is
 * not drawn, and once it came the row grew to the kebab key's height. The transcript pads its top by
 * the header's height (--sp-header-h), so the first message, already on screen, moved down by the
 * difference (2026-11-24: 8px once the kebab became the 28px .btn-icon key, 1fe4084c48;
 * tests/e2e/browser/launch-prompt-first-message.spec.ts measures it in the browser).
 *
 * This fails when the reserve and the key drift apart: the row that holds the kebab (and the draft's
 * row that stands beside it) must be exactly as tall as the key the kebab is drawn with.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../../web/src', p), 'utf8')

/** The min-height a rule gives, in px, from the first rule whose selector matches exactly. */
function minHeightOf(css: string, selector: string): number {
  const at = css.indexOf(`${selector} {`)
  expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0)
  const body = css.slice(at, css.indexOf('}', at))
  const m = /min-height:\s*(\d+)px/.exec(body)
  expect(m, `${selector} sets a min-height`).not.toBeNull()
  return Number(m![1])
}

describe('the session title row is as tall as its kebab key from the first frame', () => {
  const panel = read('components/sessions/SessionPanel.tsx')
  const kebab = read('components/sessions/TaskQuickActions.tsx')
  const keyClass = /className="(btn btn-icon[^"]*task-kebab-btn[^"]*)"/.exec(kebab)?.[1] ?? ''
  const buttons = read('styles/buttons.css')
  const key = keyClass.split(' ').includes('btn-sm')
    ? minHeightOf(buttons, '.btn-icon.btn-sm')
    : minHeightOf(buttons, '.btn-icon')

  it('the kebab is an icon key of the button family', () => {
    expect(keyClass).toMatch(/\bbtn-icon\b/)
  })

  it('the title row says when it will hold the kebab, loading or not', () => {
    const row = panel.slice(panel.indexOf('<div className="session-panel-header-top"'))
    const tag = row.slice(0, row.indexOf('>\n'))
    // The same condition the kebab is drawn under, minus `!loading`.
    expect(tag).toContain("data-kebab-row={sessionId && !kebabSlot && !hostHeader ? '' : undefined}")
    expect(panel).toContain('{!loading && sessionId && !kebabSlot && !hostHeader && renderSessionKebab()}')
  })

  it('that row, and the draft row beside it, reserve exactly the key\'s height', () => {
    expect(minHeightOf(read('styles/globals.css'), '.session-panel-header-top[data-kebab-row]')).toBe(key)
    expect(minHeightOf(read('styles/walnut-agent.css'), '.main-page-session-column .draft-session-panel .session-panel-header-top')).toBe(key)
  })
})
