/**
 * The session transcript never scrolls sideways.
 *
 * Regression guarded (2026-09-03): every message's time label carried an
 * always-rendered hover tooltip (`.msg-time::after`, opacity 0, centred on a
 * ~33px label with `left:50%; translateX(-50%)`). The label is the LAST item of
 * a strip that hugs the message's right edge, so the invisible ~140px tooltip
 * poked ~55px past `.session-history`, whose `overflow-x` was implicitly `auto`
 * — an opacity-0 box still counts as scrollable overflow — and a two-finger
 * swipe slid the whole transcript to the right (a horizontal scrollbar showed up
 * under the last message). The fix hides the tooltip with `display` until hover,
 * anchors it to the label's right edge so it stays inside the scroller when
 * shown, and pins `.session-history` to `overflow-x: hidden`.
 */
import { expect, test, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

async function openHomepageSession(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // Positional, not by label: the row's text tracks live session state.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

interface HistoryGeometry {
  scrollWidth: number
  clientWidth: number
  scrollLeft: number
  overflowX: string
}

async function historyGeometry(page: Page): Promise<HistoryGeometry> {
  return page.locator(`.session-panel[data-session-id="${SESSION_ID}"] .session-history`).evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollLeft: el.scrollLeft,
    overflowX: getComputedStyle(el).overflowX,
  }))
}

test('the transcript has no sideways overflow and a horizontal swipe does not move it', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openHomepageSession(page)
  await expect(panel.locator('.session-msg').first()).toBeVisible()
  // Every rendered message carries a time label; that is where the overflow came from.
  const times = panel.locator('.msg-time')
  expect(await times.count()).toBeGreaterThan(0)

  const before = await historyGeometry(page)
  expect(before.overflowX).toBe('hidden')
  expect(before.scrollWidth, 'nothing may poke past the transcript\'s right edge').toBeLessThanOrEqual(before.clientWidth)

  // A real two-finger swipe to the right over the transcript.
  const box = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(400, 0)
  await page.waitForTimeout(200)
  const after = await historyGeometry(page)
  expect(after.scrollLeft, 'the transcript must not slide sideways').toBe(0)

  // The tooltip contributes nothing while idle...
  const idleDisplay = await times.last().evaluate((el) => getComputedStyle(el, '::after').display)
  expect(idleDisplay).toBe('none')

  // ...and stays inside the scroller when it shows. The action strip only takes
  // the pointer once its message is hovered, so hover the message first.
  const lastMsg = panel.locator('.session-msg').last()
  await lastMsg.hover()
  const lastTime = lastMsg.locator('.msg-time')
  await lastTime.hover()
  const shown = await lastTime.evaluate((el) => {
    const cs = getComputedStyle(el, '::after')
    const host = el.closest('.session-history') as HTMLElement
    const hostRight = host.getBoundingClientRect().left + host.clientWidth
    // The pseudo-element has no rect of its own: derive its right edge from the
    // label's right edge (right:0 anchoring) and its resolved width.
    const label = el.getBoundingClientRect()
    return { display: cs.display, width: parseFloat(cs.width), labelRight: label.right, hostRight }
  })
  expect(shown.display).toBe('block')
  expect(shown.width).toBeGreaterThan(0)
  expect(shown.labelRight, 'right-anchored tooltip ends where the label ends, inside the scroller')
    .toBeLessThanOrEqual(shown.hostRight + 0.5)
  const hovered = await historyGeometry(page)
  expect(hovered.scrollWidth).toBeLessThanOrEqual(hovered.clientWidth)
  expect(hovered.scrollLeft).toBe(0)
})
