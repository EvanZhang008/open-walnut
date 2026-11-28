/**
 * A pop-up hung on its key by CSS stays inside the window (web/src/utils/inline-overlay-fit.ts).
 * 2026-11-28, the UI audit: on the Agents page at 390 x 844 the last card's ⋮ menu opened at
 * y 833 to 975, under the window's edge. Here every card's key on screen on the Agents and Commands
 * pages is pressed, before and after a wheel turn, the ones on the window's foot included: its menu
 * opens inside the window (above its key there), and its last row takes the pointer. At a wide
 * window and at the phone's width.
 *
 * `page.goto` is the initial load (the repo's sanctioned exception); every other step is a press.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
test.setTimeout(120_000)

async function makeAgent(): Promise<string> {
  const id = `pw-fit-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: `Fit ${id}`, runner: 'embedded', console: true, description: 'window fit fixture' }),
  })
  if (!res.ok) throw new Error(`POST agent failed: ${res.status} ${await res.text()}`)
  return id
}

/** Press every key on screen in turn (the last ones sit on the window's foot): each menu must be wholly inside the window. */
async function everyMenuInside(page: Page, key: string, menu: string, item: string) {
  const keys = page.locator(key)
  await expect(keys.first()).toBeVisible({ timeout: 20_000 })
  const { height, width } = page.viewportSize()!
  let nearFoot = 0
  let pressed = 0
  for (const pass of ['first screen', 'scrolled'] as const) {
    if (pass === 'scrolled') {
      // A wheel turn over the list: the keys now on screen move, and the menus are placed again.
      await page.mouse.move(width / 2, height / 2)
      await page.mouse.wheel(0, 260)
      await page.waitForTimeout(300)
    }
    const n = await keys.count()
    for (let i = 0; i < n; i += 1) {
      const k = keys.nth(i)
      const kb = await k.boundingBox()
      if (!kb || kb.y < 0 || kb.y + kb.height > height) continue
      // Its menu, hung below it, would not fit under it here.
      if (kb.y + kb.height + 100 > height) nearFoot += 1
      await k.click()
      pressed += 1
      const m = page.locator(menu).filter({ visible: true }).first()
      await expect(m).toBeVisible()
      await expect.poll(async () => {
        const b = (await m.boundingBox())!
        return b.y >= 0 && b.y + b.height <= height + 0.5 && b.x >= 0 && b.x + b.width <= width + 0.5
      }, { message: `${pass}: the menu of key ${i} (at y ${Math.round(kb.y)}) inside the ${width}x${height} window` }).toBe(true)
      // Its last row is on screen and takes the pointer (not covered, not clipped).
      const last = m.locator(item).last()
      await expect(last).toBeVisible()
      const lb = (await last.boundingBox())!
      const hit = await page.evaluate(([x, y]) => String(document.elementFromPoint(x, y)?.closest('[class]')?.className ?? ''), [lb.x + lb.width / 2, lb.y + lb.height / 2])
      expect(hit).toContain(item.replace(/^\./, ''))
      await page.keyboard.press('Escape')
      await expect(m).toBeHidden()
    }
  }
  expect(pressed).toBeGreaterThan(3)
  // The case that broke: a key on the window's foot (without one this proves nothing).
  expect(nearFoot, "keys pressed on the window's foot").toBeGreaterThan(0)
}

for (const size of [{ width: 1280, height: 640 }, { width: 390, height: 844 }]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size })
    // Enough cards to fill the window, so the last ones sit on its last line.
    const agents: string[] = []
    test.beforeAll(async () => { for (let i = 0; i < 12; i += 1) agents.push(await makeAgent()) })
    test.afterAll(async () => { for (const id of agents) await fetch(`${API}/api/agents/${id}`, { method: 'DELETE' }).catch(() => {}) })
    test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

    test('a card menu on the Agents page opens inside the window, the last card included', async ({ page }) => {
      await page.goto('/agents')
      await page.waitForLoadState('networkidle')
      await everyMenuInside(page, '.agent-menu-btn', '.agent-menu', '.agent-menu-item')
    })

    test('a card menu on the Commands page opens inside the window', async ({ page }) => {
      await page.goto('/commands')
      await page.waitForLoadState('networkidle')
      const keys = page.locator('.cmd-menu-btn')
      if (!(await keys.count())) test.skip(true, 'no command card in this fixture')
      await everyMenuInside(page, '.cmd-menu-btn', '.cmd-menu', '.cmd-menu-item')
    })
  })
}
