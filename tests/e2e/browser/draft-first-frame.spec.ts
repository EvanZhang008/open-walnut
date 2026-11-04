/**
 * New task draws its whole draft in the first frame after the click (2026-11-04, the user: "I click
 * new taks the qikc aciton etc show really slow ... it shoud isntancely show ... no delay ... the
 * data is cache not surewhy there is delay").
 *
 * The open path never asked the network (draft-session-column.spec.ts pins that), yet the draft
 * reached the screen half a second late: the column animator held a new column at opacity 0 for
 * 240 ms and faded it in over 240 more, the sessions strip and the chat slot animated their width,
 * flex and opacity for a quarter second, and the caret waited a frame. This judges the frame itself,
 * on the production bundle, empty and with chat columns open: the draft is there with its cards and
 * the caret in its composer, fully opaque, at its final width, no column around it moves, and no
 * request went out.
 */
import { test, expect, type Page } from '@playwright/test'
import { draftCwdPill, loadHome, seedColumns, watchFirstDraftFrame, watchForbiddenRequests } from './draft-helpers'
import { serveProductionBundle } from './production-bundle'
import { holdPanelCountLock } from './panel-count-lock'

test.setTimeout(120_000)
test.describe.configure({ mode: 'serial' })
holdPanelCountLock('file')

async function openAndJudge(page: Page): Promise<void> {
  const seen = watchForbiddenRequests(page)
  const firstFrame = await watchFirstDraftFrame(page)
  await page.locator('.new-launcher-btn').click()
  const frame = await firstFrame()
  expect(seen, 'the open path must be network-free').toEqual([])
  expect(frame, 'the first frame after the click draws the whole draft, and nothing moves').toEqual({
    framesBefore: 0, cards: true, composer: true, focused: true, opacity: 1,
    width: frame.settledWidth, settledWidth: frame.settledWidth,
    columns: frame.settledColumns, settledColumns: frame.settledColumns,
    motion: [],
    // A column that narrows re-wraps its composer's placeholder: no scrollbar shows meanwhile.
    scrollable: 0,
  })
}

test('New task on an empty Home: the whole draft in the first frame', async ({ page }) => {
  await serveProductionBundle(page)
  await loadHome(page)
  await openAndJudge(page)
})

test('New task beside open chat columns: the whole draft in the first frame, no column slides', async ({ page }) => {
  await serveProductionBundle(page)
  await seedColumns(page, ['pw-normal-session', 'pw-plan-session-completed'])
  await loadHome(page)
  await expect(page.locator('.main-page-session-column .session-panel')).toHaveCount(2, { timeout: 30_000 })
  await openAndJudge(page)
  // The draft's header is as tall as its neighbours', so the header lines meet across the strip.
  const bottoms = await page.evaluate(() => [...document.querySelectorAll('.main-page-session-column .session-panel-header')]
    .map((h) => Math.round(h.getBoundingClientRect().bottom)))
  expect(bottoms).toHaveLength(3)
  expect(new Set(bottoms).size, `header bottoms ${bottoms.join(', ')}`).toBe(1)
})

test('closing the draft beside open chat columns: gone in the first frame, nothing left behind it', async ({ page }) => {
  await serveProductionBundle(page)
  await seedColumns(page, ['pw-normal-session', 'pw-plan-session-completed'])
  await loadHome(page)
  await expect(page.locator('.main-page-session-column .session-panel')).toHaveCount(2, { timeout: 30_000 })
  await page.locator('.new-launcher-btn').click()
  const close = page.locator('.main-page-session-column .draft-session-panel .session-panel-close')
  await expect(close).toBeVisible()
  await page.waitForTimeout(800)
  // The draft's x stands where each column's close is: on the tool row, the same size.
  const at = (l: typeof close) => l.evaluate((el) => { const r = el.getBoundingClientRect(); const c = el.closest('.main-page-session-column')!.getBoundingClientRect(); return [r.top - c.top, c.right - r.right, r.width, r.height].map(Math.round) })
  const theirs = await at(page.locator('.main-page-session-column .session-panel:not(.draft-session-panel) .session-panel-close').first())
  expect(await at(close), 'where a column close is').toEqual(theirs)
  // The column animator puts a removed node back until its effect ends; with no motion that must
  // be over before the frame after the click paints (animation events go out before rAF callbacks).
  const frame = page.evaluate(() => new Promise<{ columns: number; drafts: number }>((resolve) => {
    const btn = document.querySelector('.main-page-session-column .draft-session-panel .session-panel-close')
    btn?.addEventListener('click', () => requestAnimationFrame(() => resolve({
      columns: document.querySelectorAll('.main-page-session-column').length,
      drafts: document.querySelectorAll('.main-page-sessions-area .draft-session-panel').length,
    })), { once: true })
  }))
  await close.click()
  expect(await frame).toEqual({ columns: 2, drafts: 0 })
})

test('the draft model menu, the folder picker and New task again give the caret to the composer in the same event', async ({ page }) => {
  await loadHome(page)
  await page.locator('.new-launcher-btn').click()
  const draft = page.locator('.main-page-session-column .draft-session-panel')
  const pill = draft.locator('.draft-model-select')
  await expect(pill).toBeVisible()
  // Where focus is once the event that closed the menu is done, before any frame: a frame can be
  // long in coming on a busy main thread, and the caret must not wait for it. The listener is on
  // document, added after the menu's own Escape listener there, so it runs right after that one.
  const focusAfter = (type: 'keydown' | 'click') => page.evaluate((t) => new Promise<string>((resolve) => {
    document.addEventListener(t, () => {
      const a = document.activeElement as HTMLElement | null
      resolve(a?.matches('.draft-session-panel textarea.chat-input-textarea') ? 'composer' : a?.className || a?.tagName || 'none')
    }, { once: true })
  }), type)

  await pill.click()
  await expect(page.locator('.model-picker')).toBeVisible()
  const onEscape = focusAfter('keydown')
  await page.waitForTimeout(100)
  await page.keyboard.press('Escape')
  expect(await onEscape).toBe('composer')
  await expect(page.locator('.model-picker')).toHaveCount(0)

  await pill.click()
  const row = page.locator('.model-picker .model-picker-row:not(.model-picker-row-active)').first()
  await expect(row).toBeVisible()
  const onPick = focusAfter('click')
  await page.waitForTimeout(100)
  await row.click()
  expect(await onPick).toBe('composer')
  await expect(page.locator('.model-picker')).toHaveCount(0)

  await draftCwdPill(draft).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  const onFolderEscape = focusAfter('keydown')
  await page.waitForTimeout(100)
  await page.keyboard.press('Escape')
  expect(await onFolderEscape).toBe('composer')
  await expect(page.locator('.session-path-selector')).toHaveCount(0)

  // New task while this empty draft is open: the same draft, its caret in place at once.
  await page.locator('.new-launcher-btn').focus()
  const onNewAgain = focusAfter('click')
  await page.waitForTimeout(100)
  await page.locator('.new-launcher-btn').click()
  expect(await onNewAgain).toBe('composer')
  await expect(draft).toHaveCount(1)
})
