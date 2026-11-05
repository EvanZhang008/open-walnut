/**
 * The selection menu is ONE box, beside the selected words, in every view that has it
 * (2026-11-05, the user, of the Ask inline / Ask in Tree choice over a table: "why sitll
 * fucking broekn"; the choice sat on the table above the selection, and its rows spilled
 * out of a box sized for the small button bar, so it read as two boxes drawn out of line).
 *
 * The pill is one component (QuotePinSelectionBar, placed by useMenuPlacement) mounted by
 * every session timeline that can keep a pin: Conversation Mode, Tree Mode's page, a page
 * one level down, the left half of Tree Mode's split, and a narrow column. Each of them is
 * checked here, on the line right under a table and inside a table cell (the user's case),
 * in all three states of the pill: the button bar, the Ask choice, the Comment box.
 *
 *   one layer      one pill in the document; nothing inside it is drawn outside its box,
 *                  and it does not scroll (a box shorter than its rows is the bug)
 *   beside         inside the viewport; never on the selected words; the Ask choice and
 *                  the Comment box open under the passage with no words of the
 *                  conversation under them
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

/** What the pill looks like right now, read in one pass once it stops moving. */
async function menuGeometry(page: Page): Promise<{ count: number; box: Box; spill: string[]; scroll: number; vw: number; vh: number }> {
  let last = ''
  await expect.poll(async () => {
    await page.waitForTimeout(150)
    const now = JSON.stringify(await pill(page).boundingBox())
    const same = now === last
    last = now
    return same
  }, { timeout: 5_000 }).toBe(true)
  return page.evaluate(() => {
    const pills = Array.from(document.querySelectorAll<HTMLElement>('.quote-pin-pill'))
    const el = pills[0]!
    const r = el.getBoundingClientRect()
    const spill: string[] = []
    for (const child of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      // What is DRAWN: a part an ancestor inside the box clips (the "On ..." line's
      // ellipsis) is not on screen. The box's own clip is not counted: rows it has to
      // clip are the bug, and the scroll check below catches them.
      const r0 = child.getBoundingClientRect()
      const c = { left: r0.left, right: r0.right, top: r0.top, bottom: r0.bottom }
      for (let up = child.parentElement; up && up !== el; up = up.parentElement) {
        const s = getComputedStyle(up)
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
        const u = up.getBoundingClientRect()
        c.left = Math.max(c.left, u.left); c.right = Math.min(c.right, u.right)
        c.top = Math.max(c.top, u.top); c.bottom = Math.min(c.bottom, u.bottom)
      }
      if (c.right - c.left < 1 || c.bottom - c.top < 1) continue
      if (c.left < r.left - 1 || c.right > r.right + 1 || c.top < r.top - 1 || c.bottom > r.bottom + 1) {
        spill.push(`${child.tagName.toLowerCase()}.${child.className} ${Math.round(c.top)}..${Math.round(c.bottom)} in ${Math.round(r.top)}..${Math.round(r.bottom)}`)
      }
    }
    return {
      count: pills.length,
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      spill,
      scroll: el.scrollHeight - el.clientHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
  })
}

/** The words of any message under a box (viewport px). */
async function wordsUnder(scope: Locator, b: Box): Promise<string[]> {
  return scope.locator('.session-history').first().evaluate((root, box) => {
    const hits: string[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text
      if (!t.data.trim()) continue
      const host = t.parentElement
      if (!host || getComputedStyle(host).visibility !== 'visible') continue
      const r = document.createRange()
      r.selectNodeContents(t)
      for (const rect of Array.from(r.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue
        if (rect.right > box.x + 1 && rect.left < box.x + box.width - 1 && rect.bottom > box.y + 1 && rect.top < box.y + box.height - 1) {
          hits.push(t.data.trim().slice(0, 40))
          break
        }
      }
    }
    return hits
  }, b)
}

const overlaps = (b: Box, r: { left: number; right: number; top: number; height: number }) =>
  r.right > b.x + 1 && r.left < b.x + b.width - 1 && r.top + r.height > b.y + 1 && r.top < b.y + b.height - 1

/** One box, in the viewport, off the selected words; the choice and the box under them. */
async function expectOneMenuBeside(page: Page, scope: Locator, phrase: string, where: string, state: 'bar' | 'ask' | 'comment'): Promise<void> {
  const g = await menuGeometry(page)
  const at = `${state} at ${where}`
  expect(g.count, `one pill in the document (${at})`).toBe(1)
  expect(g.spill, `nothing drawn outside the box (${at})`).toEqual([])
  expect(g.scroll, `the box holds its rows without scrolling (${at})`).toBeLessThanOrEqual(1)
  expect(g.box.x, `inside the viewport (${at})`).toBeGreaterThanOrEqual(-0.5)
  expect(g.box.y, `inside the viewport (${at})`).toBeGreaterThanOrEqual(-0.5)
  expect(g.box.x + g.box.width, `inside the viewport (${at})`).toBeLessThanOrEqual(g.vw + 0.5)
  expect(g.box.y + g.box.height, `inside the viewport (${at})`).toBeLessThanOrEqual(g.vh + 0.5)
  const lines = await passageRects(scope, phrase, ANSWER)
  expect(lines.filter((r) => overlaps(g.box, r)), `never on the selected words (${at})`).toEqual([])
  if (state === 'bar') return
  const bottom = Math.max(...lines.map((r) => r.top + r.height))
  expect(g.box.y, `under the passage (${at})`).toBeGreaterThanOrEqual(bottom - 0.5)
  expect(await wordsUnder(scope, g.box), `no words under the ${state} (${at})`).toEqual([])
}

/** Select `phrase` in `scope`, then check the bar, the Ask choice and the Comment box. */
async function checkAllStates(page: Page, scope: Locator, phrase: string, where: string): Promise<void> {
  const select = async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await centreInHistory(page, scope, phrase, { at: 0.4, tolerance: 30 })
    await selectPassage(page, scope, phrase, ANSWER)
    await expect(pill(page)).toBeVisible()
  }
  await select()
  await expectOneMenuBeside(page, scope, phrase, where, 'bar')
  await pill(page).getByRole('button', { name: 'Choose how to ask: inline or in Tree' }).click()
  await expect(page.getByTestId('quote-ask-modes')).toBeVisible()
  await expectOneMenuBeside(page, scope, phrase, where, 'ask')
  await shot(page, `${where}-ask`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('quote-ask-modes')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(pill(page)).toHaveCount(0)
  await select()
  await pill(page).getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(page.getByTestId('quote-comment-input')).toBeFocused()
  await expectOneMenuBeside(page, scope, phrase, where, 'comment')
  await shot(page, `${where}-comment`)
  // Discard, so no draft is left on the shared fixture's passage.
  await pill(page).getByRole('button', { name: 'Discard' }).click()
  await expect(pill(page)).toHaveCount(0)
}

const mapRow = (panel: Locator, title: string) => panel.locator('.thread-map .thread-map-row', { hasText: title }).first()

test.describe('Selection menu: one box beside the selection, in every view that has it', () => {
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

  test('a narrow column: the box stays inside it, off the words', async ({ page }) => {
    const panel = await openAt(page, 360, 'stack')
    await checkAllStates(page, panel, await underTable(panel), 'narrow-under-table')
  })
})
