/**
 * The column the keys act on (`.main-page-session-column.is-current`, useHomeKeyboard.ts) wears no
 * mark of its own: a clicked column's header and composer look as every other column's do
 * (2026-11-10, the user, after a click turned a header blue: "who add this active when i clcik?
 * so ugly why u add so many feature without ask"). Real fixture columns, real click.
 */
import { test, expect, type Page } from '@playwright/test'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'
import { holdPanelCountLock } from './panel-count-lock'

const SID = (k: 'a' | 'b') => `pw-kbd-${k}-session`
const SHOTS = process.env.KBD_SHOTS ?? '/tmp/current-column-no-highlight'

holdPanelCountLock('test')

const col = (page: Page, k: 'a' | 'b') => page.locator(`.main-page-session-column[data-column-id="${SID(k)}"]`)

test('a clicked column looks as every column does: no tinted header, no accent line, no composer ring', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* off */ } })
  await setPanelMode(page, '3')
  await seedColumns(page, [SID('a'), SID('b')])
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 30_000 })
  await expect(col(page, 'a').getByText('kbd a answer 44')).toBeVisible({ timeout: 30_000 })
  // An unread column wears a red composer ring until the person's first press in it, which marks
  // it read through a task write (SessionPanel markRead). The shared fixture sessions can be unread
  // here (other specs run turns in them), so both columns are pressed first and read before the
  // look is compared: the ring this test is about is the current column's, not the unread one
  // (CI 2026-11-10: column a still unread a moment after its click).
  await col(page, 'b').getByText('kbd b answer 44').click()
  await col(page, 'a').getByText('kbd a answer 44').click()
  for (const k of ['a', 'b'] as const) {
    await expect(col(page, k).locator('.session-panel').first(), `column ${k} is read`).not.toHaveClass(/session-panel-unread/, { timeout: 10_000 })
  }
  // Whether or not this engine's keys marked it, the mark itself must draw nothing.
  await col(page, 'a').evaluate((el) => el.classList.add('is-current'))
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const look = (k: 'a' | 'b') => col(page, k).evaluate((el) => {
    const header = el.querySelector('.session-panel > .session-panel-header') as HTMLElement
    const box = el.querySelector('.session-panel-input .chat-input-box') as HTMLElement | null
    const after = getComputedStyle(header, '::after')
    return {
      after: `${after.content}|${after.backgroundImage}|${after.backgroundColor}`,
      header: getComputedStyle(header).backgroundColor,
      ring: box ? `${getComputedStyle(box).boxShadow}|${getComputedStyle(box).borderColor}` : '',
    }
  })
  expect(await look('a')).toEqual(await look('b'))
  const a = (await col(page, 'a').boundingBox())!
  const b = (await col(page, 'b').boundingBox())!
  await page.screenshot({ path: `${SHOTS}/clicked-column-no-highlight.png`, clip: { x: a.x, y: a.y, width: b.x + b.width - a.x, height: 140 } })
})
