/**
 * The selection menu is a normal menu in every view that has it. 2026-11-05, the user,
 * first of the Ask inline / Ask in Tree choice over a table: "why sitll fucking broekn";
 * then of the design that opened the choice in a gap pushed into the text: "Just a normal
 * menu", "the ask here dro won", "it is an overlay. Nobody would design it this way".
 *
 * The bar is one component (QuotePinSelectionBar, placed by useMenuPlacement) mounted by
 * every session timeline that can keep a pin: Conversation Mode, Tree Mode's page, a page
 * one level down, the left half of Tree Mode's split, and a narrow column. Each of them is
 * checked here, on the line right under a table and inside a table cell, with the bar, the
 * Ask choice and the Comment box.
 *
 *   the bar        one, solid, inside the viewport, never on the selected words
 *   the menus      the Ask choice and the Comment box are ONE popover each, apart from
 *                  the bar: a solid background, a border and a shadow, inside the
 *                  viewport, hanging off its own button (Ask here's caret, Comment), with
 *                  nothing drawn outside it and no scroll
 *   an overlay     opening either menu moves nothing: the conversation's scroll position,
 *                  its height and every message's top are the same before and after
 *
 * Nothing is written: no Pin, Ask or Add is pressed, so the shared map fixture only needs
 * its lease for the questions it shows.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, selectPassage, test } from './threads-helpers'
import { MAP_SESSION, MAP_TITLES, seededThreadState } from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
const MAP_READY = 'Summarize the open risks.'
const ANSWER = '[data-message-id][data-msg-role="assistant"]'
/** Words inside a table cell of the first answer. */
const IN_TABLE = 'the newest version it can prove'

const pill = (page: Page) => page.locator('[data-testid="quote-pin-pill"]')

async function shot(page: Page, name: string): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/selection-menu-one-layer/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

/** Open the map session in a column `width` px wide, in the given view. */
async function openAt(page: Page, width: number, view: 'stack' | 'linear'): Promise<Locator> {
  if (seededThreadState(MAP_SESSION, Date.now())) await resetThreadsFixture(page.request, MAP_SESSION)
  await page.setViewportSize({ width: Math.max(1280, width + 520), height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${MAP_SESSION}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
  return openThreadsSession(page, MAP_SESSION, MAP_TASK, MAP_READY, { view })
}

/** Three words on the first line under the table: past the question mark that starts
 *  that paragraph, so the drag selects plain words. */
async function underTable(scope: Locator): Promise<string> {
  const table = scope.locator(`.session-history ${ANSWER} .session-msg-content table`).first()
  await expect(async () => {
    await scope.locator('.session-history').first().evaluate((el) => { el.scrollTop = 0 })
    await expect(table).toBeAttached({ timeout: 1_500 })
  }).toPass({ timeout: 30_000 })
  const text = await table
    .evaluate((t) => {
      let next = t.nextElementSibling
      while (next && next.tagName !== 'P') next = next.nextElementSibling
      return next?.textContent ?? ''
    })
  const words = text.split(/\s+/).filter(Boolean)
  expect(words.length, 'a paragraph under the table').toBeGreaterThan(14)
  return words.slice(11, 14).join(' ')
}

/** Words from the longest paragraph of a page's last answer: three, or
 *  `count` of them, enough to run over several lines. */
async function lastAnswerWords(scope: Locator, count = 3): Promise<string> {
  const paras = await scope.locator(`.session-history ${ANSWER} .session-msg-content`).last().locator('p').allInnerTexts()
  const text = paras.reduce((a, b) => (b.length > a.length ? b : a), '')
  const words = text.split(/\s+/).filter(Boolean)
  expect(words.length).toBeGreaterThan(count + 4)
  return words.slice(3, 3 + count).join(' ')
}

type Box = { x: number; y: number; width: number; height: number }
type Geometry = {
  count: number; box: Box; spill: string[]; scroll: number; vw: number; vh: number
  alpha: number; border: number; shadow: string
}

const SOLID_BG = (bg: string) => {
  // "rgb(r, g, b)" is opaque; "rgba(r, g, b, a)" and "color(srgb r g b / a)" carry an alpha.
  const m = /\/\s*([\d.]+)\)$|rgba\([^)]*,\s*([\d.]+)\)$/.exec(bg)
  if (bg === 'transparent') return 0
  return m ? Number(m[1] ?? m[2]) : 1
}

/** One element's geometry and paint, read in one pass once it stops moving. */
async function geometry(page: Page, selector: string): Promise<Geometry> {
  const target = page.locator(selector)
  let last = ''
  await expect.poll(async () => {
    await page.waitForTimeout(150)
    const now = JSON.stringify(await target.first().boundingBox())
    const same = now === last
    last = now
    return same
  }, { timeout: 5_000 }).toBe(true)
  const g = await page.evaluate((sel) => {
    const all = Array.from(document.querySelectorAll<HTMLElement>(sel))
    const el = all[0]!
    const r = el.getBoundingClientRect()
    const spill: string[] = []
    for (const child of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      // What is DRAWN: a part an ancestor inside the box clips is not on screen. The
      // box's own clip is not counted: rows it has to clip are the bug, and the scroll
      // check catches them.
      const r0 = child.getBoundingClientRect()
      const c = { left: r0.left, right: r0.right, top: r0.top, bottom: r0.bottom }
      for (let up = child.parentElement; up && up !== el; up = up.parentElement) {
        const st = getComputedStyle(up)
        if (st.overflowX === 'visible' && st.overflowY === 'visible') continue
        const u = up.getBoundingClientRect()
        c.left = Math.max(c.left, u.left); c.right = Math.min(c.right, u.right)
        c.top = Math.max(c.top, u.top); c.bottom = Math.min(c.bottom, u.bottom)
      }
      if (c.right - c.left < 1 || c.bottom - c.top < 1) continue
      if (c.left < r.left - 1 || c.right > r.right + 1 || c.top < r.top - 1 || c.bottom > r.bottom + 1) {
        spill.push(`${child.tagName.toLowerCase()}.${child.className} ${Math.round(c.top)}..${Math.round(c.bottom)} in ${Math.round(r.top)}..${Math.round(r.bottom)}`)
      }
    }
    const st = getComputedStyle(el)
    return {
      count: all.length,
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      spill,
      scroll: el.scrollHeight - el.clientHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      bg: st.backgroundColor,
      border: parseFloat(st.borderTopWidth),
      shadow: st.boxShadow,
      backdrop: st.backdropFilter || (st as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || 'none',
    }
  }, selector)
  return { ...g, alpha: SOLID_BG(g.bg) }
}

/** Where the conversation is: its scroll, its height and every message's top. */
const layout = (scope: Locator) => scope.locator('.session-history').first().evaluate((el) => ({
  scrollTop: Math.round(el.scrollTop),
  height: el.scrollHeight,
  rows: Array.from(el.querySelectorAll('[data-message-id]')).map((r) => Math.round(r.getBoundingClientRect().top)),
}))

const overlaps = (b: Box, r: { left: number; right: number; top: number; height: number }) =>
  r.right > b.x + 1 && r.left < b.x + b.width - 1 && r.top + r.height > b.y + 1 && r.top < b.y + b.height - 1

function expectInViewport(g: Geometry, at: string): void {
  expect(g.count, `one in the document (${at})`).toBe(1)
  expect(g.spill, `nothing drawn outside the box (${at})`).toEqual([])
  expect(g.scroll, `the box holds its rows without scrolling (${at})`).toBeLessThanOrEqual(1)
  expect(g.box.x, `inside the viewport (${at})`).toBeGreaterThanOrEqual(-0.5)
  expect(g.box.y, `inside the viewport (${at})`).toBeGreaterThanOrEqual(-0.5)
  expect(g.box.x + g.box.width, `inside the viewport (${at})`).toBeLessThanOrEqual(g.vw + 0.5)
  expect(g.box.y + g.box.height, `inside the viewport (${at})`).toBeLessThanOrEqual(g.vh + 0.5)
  expect(g.alpha, `a solid background, nothing shows through (${at})`).toBe(1)
}

/** Over the timeline's text column (not Tree Mode's Questions list, a split's other
 *  pane or the scrollbar), or its padding box when too wide for the column. */
async function expectInColumn(scope: Locator, g: Geometry, at: string): Promise<number[]> {
  const col = await scope.locator('.session-history').first().evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const padLeft = r.left + el.clientLeft
    const padRight = padLeft + el.clientWidth
    return { padLeft, padRight, left: padLeft + parseFloat(cs.paddingLeft), right: padRight - parseFloat(cs.paddingRight) }
  })
  const [l, r] = g.box.width + 8 <= col.right - col.left ? [col.left, col.right] : [col.padLeft, col.padRight]
  expect(g.box.x, `inside the text column on the left (${at}): ${Math.round(g.box.x)} < ${Math.round(l)}`).toBeGreaterThanOrEqual(l - 0.5)
  expect(g.box.x + g.box.width, `inside the text column on the right (${at}): ${Math.round(g.box.x + g.box.width)} > ${Math.round(r)}`).toBeLessThanOrEqual(r + 0.5)
  return [l, r]
}

/** The bar: one, solid, in the viewport, off the selected words. */
async function expectBar(page: Page, scope: Locator, phrase: string, where: string): Promise<void> {
  const g = await geometry(page, '.quote-pin-pill')
  expectInViewport(g, `bar at ${where}`)
  await expectInColumn(scope, g, `bar at ${where}`)
  const lines = await passageRects(scope, phrase, ANSWER)
  expect(lines.filter((r) => overlaps(g.box, r)), `the bar is never on the selected words (${where})`).toEqual([])
  // Under the passage when the bar and a menu fit there (the mockup the user was
  // shown), above it otherwise, so a menu never has to flip onto the words.
  const bottom = Math.max(...lines.map((r) => r.top + r.height))
  const floor = await scope.locator('.session-history').first().evaluate((el) => Math.min(el.getBoundingClientRect().bottom, window.innerHeight))
  if (floor - bottom >= 8 + g.box.height + 4 + 110) expect(g.box.y, `the bar is under the passage (${where})`).toBeGreaterThanOrEqual(bottom - 0.5)
}

/** A menu: one popover with a border and a shadow, hanging off its button, which moved
 *  nothing in the conversation. */
async function expectMenu(page: Page, scope: Locator, phrase: string, anchor: Locator, before: Awaited<ReturnType<typeof layout>>, at: string): Promise<void> {
  const g = await geometry(page, '[data-testid="quote-pin-menu"]')
  expectInViewport(g, at)
  const [edgeL, edgeR] = await expectInColumn(scope, g, at)
  expect(g.border, `a border (${at})`).toBeGreaterThanOrEqual(1)
  expect(g.shadow, `a shadow (${at})`).not.toBe('none')
  const a = (await anchor.boundingBox())!
  const below = g.box.y - (a.y + a.height)
  const above = a.y - (g.box.y + g.box.height)
  expect((below >= -0.5 && below <= 12) || (above >= -0.5 && above <= 12), `hangs off its button: ${Math.round(below)}px below or ${Math.round(above)}px above (${at})`).toBe(true)
  // Over the bar is wrong too: the menu sits beside it, never on it.
  const bar = (await pill(page).boundingBox())!
  // On the bar's side away from the passage: down from a bar under the words when
  // it fits, up from a bar above them.
  const words = await passageRects(scope, phrase, ANSWER)
  const barAbove = bar.y + bar.height <= Math.min(...words.map((r) => r.top)) + 0.5
  if (barAbove) expect(above, `opens up from a bar above the words (${at})`).toBeGreaterThanOrEqual(-0.5)
  else if (a.y + a.height + 4 + g.box.height + 8 <= g.vh) expect(below, `drops down from its button (${at})`).toBeGreaterThanOrEqual(-0.5)
  // A dropdown off its own button: left edges meet, or right edges where the column
  // leaves no room to the right; only a menu wider than either side of the button
  // is held at the column's edge.
  const leftMeets = Math.abs(g.box.x - a.x) <= 2
  const rightMeets = Math.abs(g.box.x + g.box.width - (a.x + a.width)) <= 2
  // The menu keeps a 4px margin inside its column (QuotePinSelectionBar's placement).
  const neitherFits = a.x + g.box.width > edgeR - 4.5 && a.x + a.width - g.box.width < edgeL + 4.5
  expect(leftMeets || rightMeets || (neitherFits && (g.box.x <= edgeL + 6 || g.box.x + g.box.width >= edgeR - 6)),
    `hangs from its own button: left ${Math.round(g.box.x - a.x)}px, right ${Math.round(g.box.x + g.box.width - a.x - a.width)}px off it (${at})`).toBe(true)
  expect(overlaps(g.box, { left: bar.x, right: bar.x + bar.width, top: bar.y, height: bar.height }), `the menu is not drawn on the bar (${at})`).toBe(false)
  expect(await layout(scope), `the conversation did not move (${at})`).toEqual(before)
  // It opens away from the passage, so the words it is about stay in view.
  const lines = await passageRects(scope, phrase, ANSWER)
  expect(lines.filter((r) => overlaps(g.box, r)), `the menu is not on the selected words (${at})`).toEqual([])
}

/** Select `phrase` in `scope`, then check the bar, the Ask choice and the Comment box. */
async function checkAllStates(page: Page, scope: Locator, phrase: string, where: string, at = 0.4): Promise<void> {
  const select = async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await centreInHistory(page, scope, phrase, { at, tolerance: 30 })
    await selectPassage(page, scope, phrase, ANSWER)
    await expect(pill(page)).toBeVisible()
  }
  const menu = page.locator('[data-testid="quote-pin-menu"]')
  await select()
  await expectBar(page, scope, phrase, where)
  // One bar, one style: all buttons worded, or (a column too narrow) all icons.
  const styles = await pill(page).locator('.quote-pin-pill-btn:not(.quote-ask-mode-btn)').evaluateAll((bs) =>
    bs.map((b) => ([...b.children].some((c) => c.tagName === 'SPAN' && getComputedStyle(c).display !== 'none') ? 'words' : 'icon')))
  expect(new Set(styles).size, `the bar never mixes icon-only and worded buttons (${where}: ${styles.join(', ')})`).toBe(1)
  const before = await layout(scope)
  // Ask: a menu under Ask here's caret; Up and Down move; Esc closes it and keeps the bar.
  const caret = pill(page).getByRole('button', { name: 'Choose how to ask: inline or in Tree' })
  await caret.click()
  await expect(page.getByTestId('quote-ask-modes')).toBeVisible()
  await expect(caret).toHaveAttribute('aria-expanded', 'true')
  await expectMenu(page, scope, phrase, pill(page).locator('.quote-pin-ask-group'), before, `ask at ${where}`)
  // The current way (Tree Mode asks in Tree) has the focus; Down moves to the other.
  const current = page.locator('[data-testid="quote-ask-modes"] .quote-ask-mode.is-current')
  await expect(current).toBeFocused()
  const other = (await current.getAttribute('data-testid')) === 'quote-ask-inline' ? 'quote-ask-tree' : 'quote-ask-inline'
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId(other)).toBeFocused()
  await shot(page, `${where}-ask`)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(pill(page)).toBeVisible()
  // Focus goes back to the caret, so the next Tab carries on from the bar.
  await expect(caret).toBeFocused()
  expect(await layout(scope), `the conversation is where it was (${where})`).toEqual(before)
  // A scroll and a narrower window with the menu open (after the checks above,
  // which need the conversation where it was).
  await caret.click()
  await expect(page.getByTestId('quote-ask-modes')).toBeVisible()
  // The bar stays on the words and the menu on its caret, never frozen over other text.
  const nearWords = async () => {
    const words = await passageRects(scope, phrase, ANSWER)
    const bar = (await pill(page).boundingBox())!
    const box = (await page.locator('[data-testid="quote-pin-menu"]').boundingBox())!
    const grp = (await pill(page).locator('.quote-pin-ask-group').boundingBox())!
    const top = Math.min(...words.map((r) => r.top))
    const bottom = Math.max(...words.map((r) => r.top + r.height))
    const barNear = (bar.y >= bottom - 0.5 && bar.y - bottom <= 24) || (bar.y + bar.height <= top + 0.5 && top - (bar.y + bar.height) <= 24)
    const menuNear = Math.abs(box.y - (grp.y + grp.height)) <= 12 || Math.abs(grp.y - (box.y + box.height)) <= 12
    return barNear && menuNear
  }
  await scope.locator('.session-history').first().evaluate((el) => { el.scrollTop -= 50 })
  await expect.poll(nearWords, { message: `the bar and the Ask menu follow the words through a scroll (${where})`, timeout: 3_000 }).toBe(true)
  const vpAsk = page.viewportSize()!
  await page.setViewportSize({ width: vpAsk.width - 120, height: vpAsk.height })
  await expect.poll(nearWords, { message: `the bar and the Ask menu follow the words through a resize (${where})`, timeout: 3_000 }).toBe(true)
  await page.setViewportSize(vpAsk)
  await scope.locator('.session-history').first().evaluate((el) => { el.scrollTop += 50 })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="quote-pin-menu"]')).toHaveCount(0)
  // The caret again closes it too.
  await caret.click()
  await expect(menu).toHaveCount(1)
  await caret.click()
  await expect(menu).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(pill(page)).toHaveCount(0)
  // Comment: a box under the Comment button, the field focused.
  await select()
  const beforeComment = await layout(scope)
  const commentBtn = pill(page).getByRole('button', { name: 'Comment', exact: true })
  await commentBtn.click()
  await expect(page.getByTestId('quote-comment-input')).toBeFocused()
  await expect(commentBtn).toHaveAttribute('aria-expanded', 'true')
  await expectMenu(page, scope, phrase, commentBtn, beforeComment, `comment at ${where}`)
  await expectBar(page, scope, phrase, `${where} with the Comment box`)
  await shot(page, `${where}-comment`)
  // A scroll moves the bar with the passage: the box goes with its button, never
  // left behind on the bar or the words.
  await scope.locator('.session-history').first().evaluate((el) => { el.scrollTop -= 60 })
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!
    const btn = (await commentBtn.boundingBox())!
    const below = box.y - (btn.y + btn.height)
    const above = btn.y - (box.y + box.height)
    return (below >= -0.5 && below <= 12) || (above >= -0.5 && above <= 12)
  }, { message: `the box follows its button through a scroll (${where})`, timeout: 3_000 }).toBe(true)
  // A shorter window: the bar stays one whole row, never clipped into a scrolling strip.
  const vp = page.viewportSize()!
  await page.setViewportSize({ width: vp.width, height: vp.height - 220 })
  await expect.poll(() => pill(page).evaluate((el) => {
    const btn = el.querySelector<HTMLElement>('.quote-pin-pill-btn')!
    return el.scrollHeight - el.clientHeight <= 1 && el.clientHeight >= btn.offsetHeight
  }), { message: `the bar keeps its whole row in a shorter window (${where})`, timeout: 3_000 }).toBe(true)
  await page.setViewportSize(vp)
  // Discard, so no draft is left on the shared fixture's passage.
  await menu.getByRole('button', { name: 'Discard' }).click()
  await expect(pill(page)).toHaveCount(0)
  await expect(menu).toHaveCount(0)
}

const mapRow = (panel: Locator, title: string) => panel.locator('.thread-map .thread-map-row', { hasText: title }).first()

test.describe('Selection menu: a bar and normal menus over the conversation, in every view that has it', () => {
  test.describe.configure({ timeout: 240_000 })

  test('Conversation Mode: a few words, and a passage dragged down over several lines', async ({ page }) => {
    // The table is in the first answer, which Conversation Mode folds behind "Load
    // earlier turns" (the Initial Prompt); Tree Mode's page below has it.
    const panel = await openAt(page, 760, 'linear')
    await checkAllStates(page, panel, await lastAnswerWords(panel), 'linear-words')
    const long = await lastAnswerWords(panel, 24)
    expect((await passageRects(panel, long, ANSWER)).length, 'the passage runs over several lines').toBeGreaterThan(1)
    await checkAllStates(page, panel, long, 'linear-lines')
  })

  test('Conversation Mode: a passage on the last lines above the composer', async ({ page }) => {
    // The common case of selecting an answer's last lines: the bar goes above the
    // passage and both menus open upward from it, never onto the words.
    const panel = await openAt(page, 1100, 'linear')
    await checkAllStates(page, panel, await lastAnswerWords(panel), 'linear-bottom', 0.93)
  })

  test('Tree Mode: the main page, then a page one level down', async ({ page }) => {
    const panel = await openAt(page, 720, 'stack')
    await checkAllStates(page, panel, await underTable(panel), 'tree-under-table')
    await checkAllStates(page, panel, IN_TABLE, 'tree-in-table')
    await mapRow(panel, MAP_TITLES.Q1a).click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '2', { timeout: 15_000 })
    await expect(panel.locator('.thread-quote-head')).toBeVisible()
    await checkAllStates(page, panel, await lastAnswerWords(panel), 'tree-depth-2')
  })

  test('Tree Mode split: the page asked on, in the left half', async ({ page }) => {
    const panel = await openAt(page, 1000, 'stack')
    await mapRow(panel, MAP_TITLES.Q1).click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    const left = panel.locator('.tree-split-left')
    await expect(left).toBeVisible({ timeout: 15_000 })
    await expect(left.locator('.session-history')).toContainText(MAP_READY, { timeout: 15_000 })
    await checkAllStates(page, left, await underTable(left), 'split-left-under-table')
  })

  test('a narrow column: the bar and the menus stay in the viewport', async ({ page }) => {
    const panel = await openAt(page, 360, 'stack')
    await checkAllStates(page, panel, await underTable(panel), 'narrow-under-table')
  })
})
