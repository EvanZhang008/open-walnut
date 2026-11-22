/**
 * Every column on Home's row keeps its floor (2026-11-22, the header-fit check on the user's data:
 * at 1280 with the task panel, the Scratchpad, Quick question and one session column, Quick
 * question got 145px; its header's Fork was clipped and out of reach, its name and its kebab broke
 * onto two lines, and "17 threads (8 need you)" wrapped to three lines).
 *
 * A short row takes the room from the session area's share first, then from the side bar
 * (columnSizing.ts homeRowFloorVars, globals.css "Floors"); no column goes under its floor and no
 * header tool runs past its column's edge. Chromium; the numbers are in tests/web/column-sizing.test.ts.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const FLOOR = 280
const SHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? 'test-results/home-column-floors'

test.use({ viewport: { width: 1280, height: 800 } })

/** Home with Quick question and the Scratchpad open, the task panel at a third of the window. */
async function boot(page: Page, baseURL: string) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', 'true')
      localStorage.setItem('open-walnut-home-scratchpad-visible', 'true')
      localStorage.setItem('open-walnut-todo-width', '33')
      for (const k of ['walnut-session-panel-width-v2', 'open-walnut-todo-width-alone']) {
        localStorage.removeItem(k); localStorage.removeItem(`${k}:dragged`)
      }
    } catch { /* storage off */ }
  })
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await page.waitForLoadState('networkidle')
}

test('Home at 1280 with the Scratchpad, Quick question and a session: every column at its floor, no header tool cut', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  await boot(page, baseURL!)
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toBeVisible()
  await expect(page.locator('.main-page-chat')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.home-companion .side-bar-pane').first()).toBeVisible()
  await page.waitForTimeout(800)

  const m = await page.evaluate(() => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width } }
    const cols = [...document.querySelectorAll('.main-page-chat, .main-page-session-column')].map((c) => {
      const b = box(c)
      const cut = [...c.querySelectorAll('.session-panel-header button, .session-panel-header [role="button"]')]
        .filter((el) => !(el as HTMLElement).closest('[data-hidden="true"]') && el.getBoundingClientRect().width > 0)
        .filter((el) => { const r = el.getBoundingClientRect(); return r.right > b.right + 0.5 || r.left < b.left - 0.5 })
        .map((el) => (el.textContent || el.getAttribute('aria-label') || '?').trim().slice(0, 30))
      return { kind: c.classList.contains('main-page-chat') ? 'quick question' : 'session column', ...b, cut }
    })
    const main = document.querySelector('.main-page')!
    return {
      cols,
      sideBars: [...document.querySelectorAll('.home-companion .side-bar-pane')].map((e) => box(e).width),
      todo: box(document.querySelector('.main-page-todo')!).width,
      overflow: main.scrollWidth - main.clientWidth,
      rightEdge: box(document.querySelector('.main-page-right')!).right,
    }
  })
  const why = JSON.stringify(m)
  expect(m.cols.map((c) => c.kind), why).toEqual(['quick question', 'session column'])
  for (const c of m.cols) {
    expect(c.width, `${c.kind} keeps its floor: ${why}`).toBeGreaterThanOrEqual(FLOOR - 1)
    expect(c.cut, `${c.kind}: no header tool past its edge`).toEqual([])
  }
  // The room came from the side bar, never from past the window's edge.
  expect(m.overflow, why).toBeLessThanOrEqual(0)
  expect(m.rightEdge, why).toBeLessThanOrEqual(1280.5)
  expect(Math.min(...m.sideBars), why).toBeGreaterThanOrEqual(200)
  // Quick question's name stays on one line with the kebab beside it, when it shows a session.
  const chatRow = page.locator('.main-page-chat .session-panel-header-top').first()
  if (await chatRow.count()) {
    const lines = await chatRow.locator('.session-panel-title').first().evaluate((el) => {
      const r = document.createRange(); r.selectNodeContents(el)
      return new Set([...r.getClientRects()].map((x) => Math.round(x.y))).size
    })
    expect(lines, 'Quick question\'s name on one line').toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: `${SHOT_DIR}/home-1280-floors.png` })
})
