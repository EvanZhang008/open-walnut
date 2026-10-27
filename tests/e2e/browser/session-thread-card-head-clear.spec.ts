/**
 * A tall card never hides its head under the panel's glass header (2026-10-27
 * live run, both engines: a long answer's card opened from a mark near the top
 * of the timeline grew, scrolled itself "whole" into view, and its title, Quote
 * in chat and × sat under the header, out of reach until the reader scrolled).
 * The head stays below the header and the body scrolls inside the card.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, switchView } from './threads-helpers'
import { buildMapSession, MAP_PASSAGES, MAP_SESSION, MAP_TITLES } from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
const MAP_READY = 'Summarize the open risks.'
const IDS = buildMapSession(Date.now()).ids

const LONG_ANSWER = [
  'Here is how the three layers line up:',
  '',
  '| Layer | Who writes | What the reader sees |',
  '| --- | --- | --- |',
  '| Buffer | the flush worker, once per tick | nothing until the page lands |',
  '| Page | one worker per slot | the newest version it can prove |',
  '',
  ...Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: the flush worker hands each page to the index writer only after the seal, so a reader never sees a half-written slot, and a restart replays the log from the last sealed page.\n`),
].join('\n')

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/card-head-clear/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, height: number): Promise<Locator> {
  await page.setViewportSize({ width: 1400, height })
  await page.route(`**/api/sessions/${MAP_SESSION}/history**`, async (route) => {
    const res = await route.fetch()
    const json = await res.json() as { messages?: Array<Record<string, unknown>> }
    for (const m of json.messages ?? []) {
      if (m.role === 'assistant' && [m.msgId, m.id, m.uuid].includes(IDS.Q1.a)) m.text = LONG_ANSWER
    }
    await route.fulfill({ response: res, json })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  const panel = await openThreadsSession(page, MAP_SESSION, MAP_TASK, MAP_READY, { view: 'linear' })
  await switchView(panel, 'linear')
  return panel
}

/** The passage's reply rendered: it sits behind "Load earlier turns". */
async function ensurePassage(panel: Locator, phrase: string): Promise<void> {
  const history = panel.locator('.session-history')
  await expect.poll(async () => {
    const found = await panel.evaluate((root, needle) => Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))
      .some((b) => (b.textContent ?? '').includes(needle)), phrase)
    if (found) return true
    const more = history.getByRole('button', { name: 'Load earlier turns', exact: true })
    // A DOM click: the timeline holds its bottom, so a scrolled click can miss.
    if (await more.count()) await more.first().evaluate((el) => (el as HTMLElement).click())
    else await history.evaluate((el) => { el.scrollTop = 0 })
    return false
  }, { timeout: 30_000, intervals: [300] }).toBe(true)
}

/** The card's head is below the panel header and the topmost thing at its ×. */
async function expectHeadClear(page: Page, panel: Locator): Promise<void> {
  const card = panel.locator('.thread-card')
  const header = (await panel.locator('.session-panel-header').boundingBox())!
  const head = (await card.locator('.thread-card-head').boundingBox())!
  expect(head.y, 'the card head starts below the panel header').toBeGreaterThanOrEqual(header.y + header.height - 1)
  const hit = await card.locator('.thread-card-close').evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!top && (top === el || el.contains(top))
  })
  expect(hit, 'the × takes a click where it is drawn').toBe(true)
  // The card ends inside the timeline; a long answer scrolls in its own body.
  const history = (await panel.locator('.session-history').boundingBox())!
  const box = (await card.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(history.y + history.height + 1)
  const body = await card.locator('.thread-card-body').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
  expect(body.sh).toBeGreaterThan(body.ch)
}

test.describe('A tall question card keeps its head below the panel header', () => {
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })
  test.afterEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })

  for (const height of [900, 700]) {
    test(`a long answer's card opened from a mark near the top (viewport ${height})`, async ({ page }) => {
      const panel = await open(page, height)
      await ensurePassage(panel, MAP_PASSAGES.Q1)
      await centreInHistory(page, panel, MAP_PASSAGES.Q1, { at: 0.2 })
      const r = (await passageRects(panel, MAP_PASSAGES.Q1))[0]
      await page.mouse.click(r.left + 10, r.top + r.height / 2)
      const card = panel.locator('.thread-card')
      await expect(card.locator('.thread-card-title')).toHaveText(MAP_TITLES.Q1)
      await expect(card).toHaveAttribute('data-expanded', 'true')
      // The grow glides, then scrolls the card into view.
      await page.waitForTimeout(800)
      await shot(page, `01-opened-${height}`)
      await expectHeadClear(page, panel)
      // Its own controls work from there: shrink, then close.
      await card.locator('.thread-card-expand').click()
      await expect(card).not.toHaveAttribute('data-expanded', 'true')
      await page.waitForTimeout(500)
      const header = (await panel.locator('.session-panel-header').boundingBox())!
      expect((await card.locator('.thread-card-head').boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1)
      await card.locator('.thread-card-close').click()
      await expect(card).toHaveCount(0)
    })
  }
})
