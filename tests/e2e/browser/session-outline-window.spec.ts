/**
 * The outline over a transcript LONGER than the panel's lazy tail.
 *
 * The panel loads the newest HISTORY_TAIL_LIMIT (400) rows; the fixture here has 460.
 * A pin on one of the first rows is therefore a pin whose message is NOT loaded, and
 * two things were wrong about it (reported 2026-09-18, with a screenshot of the rail):
 *
 *  · it sorted LAST. The outline claims transcript order, and a two-day-old pin sat
 *    under a pin made an hour ago ("the activator one is really the later one");
 *  · its row was dead: the jump found no such message in the loaded array and
 *    silently returned.
 *
 * Now it is placed by its message's timestamp (before the whole loaded window, in
 * this case), its time label carries the DATE because a bare "3:08 PM" on another
 * day's row is what made the order look impossible, and clicking it loads the full
 * history and lands on the row.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'

const SESSION_ID = 'pw-outline-window-session'
const TASK_ID = 'pw-task-outline-window'
/** Transcript uuids (test-server.ts longTranscript, prefix 0199bd): pair n is
 *  1-based, written under `…-<n-1>`. */
const replyUuid = (n: number) => `0199bd03-0000-4aaa-8bbb-${String(n - 1).padStart(12, '0')}`
/** Row 3 of 460: two days old, well outside the 400-row tail. */
const EARLY = 3
/** Row 228: inside the tail, today. */
const LATE = 228
const LAST_REPLY = 'outline filler reply 230'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/threads/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(SESSION_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-history')).toContainText(LAST_REPLY, { timeout: 30_000 })
  return panel
}

test.describe('Outline over a lazy tail', () => {
  test.setTimeout(120_000)

  test('a pin older than the loaded window sorts first, shows its date, and its jump loads the history', async ({ page, request }) => {
    // Two pins, pinned in the WRONG order on purpose (the late one first): a sort
    // by pin time would keep them this way, a sort by transcript order flips them.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000)
    const res = await request.patch(`/api/sessions/${SESSION_ID}`, {
      data: {
        pinned_messages: [
          {
            msgId: replyUuid(LATE), role: 'assistant', label: `outline filler reply ${LATE}`,
            timestamp: new Date(Date.now() - 20_000).toISOString(),
            pinnedAt: new Date(Date.now() - 10_000).toISOString(),
          },
          {
            msgId: replyUuid(EARLY), role: 'assistant', label: `outline filler reply ${EARLY}`,
            timestamp: twoDaysAgo.toISOString(),
            pinnedAt: new Date(Date.now() - 5_000).toISOString(),
          },
        ],
      },
    })
    expect(res.ok(), await res.text()).toBe(true)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)
    const history = panel.locator('.session-history')

    // The early row is genuinely NOT loaded: it is outside the 400-row tail.
    await expect(panel.locator(`[data-message-id="${replyUuid(EARLY)}"]`)).toHaveCount(0)
    await expect(history).toContainText(`outline filler reply ${LATE}`)

    // 1. The rail reads in TRANSCRIPT order: the early (unloaded) pin first.
    const toc = panel.locator('.session-toc')
    await expect(toc.locator('.session-toc-tick')).toHaveCount(2)
    await toc.locator('.session-toc-rail').hover()
    const rows = toc.locator('.session-toc-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toContainText(`reply ${EARLY}`)
    await expect(rows.nth(1)).toContainText(`reply ${LATE}`)

    // 2. The other-day row says which day; today's row is a bare clock.
    const earlyTime = (await rows.nth(0).locator('.session-toc-time').textContent()) ?? ''
    const lateTime = (await rows.nth(1).locator('.session-toc-time').textContent()) ?? ''
    expect(earlyTime, 'a row from another day carries its date').toMatch(/[A-Z][a-z]{2} \d/)
    expect(lateTime, "today's row is just the clock").not.toMatch(/[A-Z][a-z]{2} \d/)
    expect(lateTime).toMatch(/\d:\d\d/)
    await shot(page, '16-outline-unloaded-pin-first')

    // 3. Clicking the early pin is a real jump: the full history loads and the row
    //    is centred. Generous wait: the fetch is the whole 460-row transcript plus
    //    the two frames the jump chases after the rows mount.
    await rows.nth(0).click()
    const earlyRow = panel.locator(`[data-message-id="${replyUuid(EARLY)}"]`)
    await expect(earlyRow).toBeAttached({ timeout: 30_000 })
    await expect.poll(async () => history.evaluate((el, id) => {
      const box = el.getBoundingClientRect()
      const node = el.querySelector(`[data-message-id="${id}"]`)
      if (!node) return null
      const r = node.getBoundingClientRect()
      return Math.abs((r.top + r.height / 2) - (box.top + box.height / 2)) / box.height
    }, replyUuid(EARLY)), { timeout: 15_000 }).toBeLessThan(0.5)
    await shot(page, '17-outline-unloaded-pin-jump-landed')
  })
})
