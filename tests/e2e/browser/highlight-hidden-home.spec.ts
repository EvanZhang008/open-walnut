/**
 * Marks of a Home chat never paint on another page (2026-11-03, the user: "why u
 * like to have highlight and underline for so many headers even this plugin").
 *
 * Home stays mounted off its route under `visibility: hidden`, and WebKit paints a
 * Highlight whose words are hidden that way onto the next words it renders: the
 * title of the page on show (utils/highlight-visibility.ts). So while another page
 * is open, no range the highlight registry paints may sit in hidden words, and
 * back on Home the chat's marks paint again.
 *
 * Chromium and WebKit (the Mac app's engine). The dense threads fixture holds
 * questions on many passages, painted in Conversation Mode.
 */
import { expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { DENSE_SESSION, openThreadsSession, resetThreadsFixture, test } from './threads-helpers'

const TASK = 'pw-task-threads-dense'

/** What the registry paints now (its own entries, not what `get` answers): marks
 *  in all, and those whose words are hidden by `visibility`. */
const painted = (page: Page) => page.evaluate(() => {
  const reg = (window as unknown as { CSS: { highlights: Map<string, Iterable<Range>> } }).CSS.highlights
  let marks = 0
  const hidden: string[] = []
  for (const [name, h] of reg) {
    for (const r of h) {
      if (name.startsWith('thread-mark')) marks++
      const n = r.startContainer
      const el = (n.nodeType === 1 ? n : n.parentElement) as Element | null
      if (el?.isConnected && el.checkVisibility() && !el.checkVisibility({ visibilityProperty: true })) hidden.push(`${name}: ${r.toString().slice(0, 40)}`)
    }
  }
  return { marks, hidden }
})

test.describe('a hidden Home chat paints no marks on the page on show', () => {
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  test('leaving Home withdraws its marks, coming back paints them again', async ({ page }) => {
    await page.goto('/')
    const panel = await openThreadsSession(page, DENSE_SESSION, TASK, undefined, { view: 'linear' })
    await expect(panel.locator('.session-history [data-message-id]').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await painted(page)).marks, { timeout: 30_000, message: 'the chat paints its marks' }).toBeGreaterThan(0)

    // Another page through the rail, as a person goes there.
    await page.locator('a[href="/tasks"]').first().click()
    await expect(page).toHaveURL(/\/tasks$/)
    await expect(page.locator('.main-page-wrapper-hidden')).toHaveCount(1)
    await expect.poll(async () => (await painted(page)).hidden, { timeout: 10_000, message: 'no range in hidden words' }).toEqual([])
    expect((await painted(page)).marks).toBe(0)
    const dir = `/tmp/highlight-hidden-home/${test.info().project.name}`
    await fs.mkdir(dir, { recursive: true })
    await page.screenshot({ path: `${dir}/tasks-page.png`, clip: { x: 0, y: 0, width: 1280, height: 240 } })

    // Back on Home: the same marks paint again.
    await page.locator('a[href="/"]').first().click()
    await expect(page).toHaveURL(/\/$/)
    await expect.poll(async () => (await painted(page)).marks, { timeout: 15_000, message: 'the marks are back' }).toBeGreaterThan(0)
    expect((await painted(page)).hidden).toEqual([])
  })
})
