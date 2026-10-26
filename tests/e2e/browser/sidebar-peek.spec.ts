import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

/**
 * The collapsed rail peeks open on hover (useRailPeek.ts + sidebar-peek.css): it widens
 * over the page, every icon shows its name, and it folds back when the pointer leaves.
 * Pinned here: it opens fast, never moves the page or an icon, ignores a pointer passing
 * through, closes at once on a click (the panels it opens sit beside the NARROW rail),
 * works from the keyboard, never opens for touch, and the hamburger pins it.
 */

const SHOTS = '/tmp/sidebar-peek'
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'default' })
test.setTimeout(120_000)

const rail = (page: Page) => page.locator('#primary-sidebar')
// The open peek's own class, exactly: not `rail-peek-out` (closing) or `rail-peek-snap` (closed by a click).
const PEEK = /(?:^|\s)rail-peek(?:\s|$)/
const notes = (page: Page) => page.getByTestId('sidebar-core-app-notes')

async function boot(page: Page, baseURL: string) {
  await isolateUiPrefs(page)
  await openHome(page, baseURL)
  await expect(rail(page)).toHaveClass(/\bcollapsed\b/)
  // Park the pointer on the page, away from the rail.
  await page.mouse.move(700, 400)
}

/** Every rail icon's position: they must not move when the rail peeks. */
async function iconSpots(page: Page) {
  return rail(page).locator('.sidebar-link > svg, .sidebar-link > img, .sidebar-collapse-btn > svg').evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2] }))
}
const railWidth = (page: Page) => rail(page).evaluate((el) => el.getBoundingClientRect().width)
const mainLeft = (page: Page) => page.locator('.main-content').evaluate((el) => el.getBoundingClientRect().left)
async function centerOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`no box for ${testId}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('hover opens the rail over the page at once, names every icon, and leaving folds it back', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await boot(page, baseURL!)
  // The rail's app list settles after boot (plugin apps arrive later): wait for two equal reads.
  let before = await iconSpots(page)
  await expect.poll(async () => { const now = await iconSpots(page); const same = JSON.stringify(now) === JSON.stringify(before); before = now; return same }, { intervals: [300] }).toBe(true)
  const left = await mainLeft(page)
  expect(await railWidth(page)).toBeLessThan(60)

  const at = await centerOf(page, 'sidebar-core-app-notes')
  const t0 = Date.now()
  await page.mouse.move(at.x, at.y)
  await expect(rail(page)).toHaveClass(PEEK, { timeout: 1000 })
  const openedMs = Date.now() - t0
  // Intent delay 80ms + one frame; generous for a loaded machine.
  expect(openedMs).toBeLessThan(600)
  await expect.poll(() => railWidth(page)).toBeGreaterThan(235)
  await expect(notes(page).locator('.sidebar-label')).toBeVisible()
  expect(await notes(page).locator('.sidebar-label').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(20)
  // The page did not move, and no icon did.
  expect(await mainLeft(page)).toBe(left)
  expect(await iconSpots(page)).toEqual(before)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-open.png`, clip: { x: 0, y: 0, width: 420, height: 800 } })

  // Moving within the wide rail (over a name) keeps it open.
  await page.mouse.move(180, at.y)
  await page.waitForTimeout(400)
  await expect(rail(page)).toHaveClass(PEEK)

  // Every frame of the way back, the page stays put.
  const sample = () => page.evaluate(() => new Promise<number[]>((resolve) => {
    const main = document.querySelector('.main-content')!
    const lefts: number[] = []
    const t0 = performance.now()
    const tick = () => { lefts.push(main.getBoundingClientRect().left); if (performance.now() - t0 < 700) requestAnimationFrame(tick); else resolve(lefts) }
    requestAnimationFrame(tick)
  }))
  const leaving = sample()
  await page.mouse.move(700, 400)
  expect(new Set(await leaving)).toEqual(new Set([left]))
  await expect(rail(page)).not.toHaveClass(PEEK, { timeout: 1500 })
  await expect.poll(() => railWidth(page)).toBeLessThan(60)
  expect(await iconSpots(page)).toEqual(before)
  // And when a click closes it.
  const cal = await centerOf(page, 'sidebar-core-app-calendar')
  await page.mouse.move(cal.x, cal.y)
  await expect(rail(page)).toHaveClass(PEEK)
  const clicking = sample()
  await page.mouse.down()
  await page.mouse.up()
  expect(new Set(await clicking)).toEqual(new Set([left]))
  expect(errors).toEqual([])
})

test('a pointer passing through the rail does not open it, nor does a drag, nor a page changing under a resting pointer', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  // Synthetic pointer events in ONE task: a real sweep's timing is at the mercy of a loaded machine.
  const seen = await page.evaluate(async () => {
    const railEl = document.getElementById('primary-sidebar')!
    const item = railEl.querySelector('[data-testid="sidebar-core-app-notes"]')!
    const main = document.querySelector('.main-content')!
    const box = item.getBoundingClientRect()
    const at = { x: box.left + 10, y: box.top + box.height / 2 }
    let opened = false
    new MutationObserver(() => { if (railEl.classList.contains('rail-peek')) opened = true })
      .observe(railEl, { attributes: true, attributeFilter: ['class'] })
    const fire = (type: string, target: Element, related: Element | null, x: number, y: number, buttons = 0) =>
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'mouse', relatedTarget: related, buttons, clientX: x, clientY: y }))
    const into = (x: number, buttons = 0) => {
      fire('pointerout', main, item, x, at.y, buttons); fire('pointerover', item, main, x, at.y, buttons)
      fire('pointermove', item, null, x, at.y, buttons)
    }
    const out = (buttons = 0) => {
      fire('pointerout', item, main, 700, at.y, buttons); fire('pointerover', main, item, 700, at.y, buttons)
      fire('pointermove', main, null, 700, at.y, buttons)
    }
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    fire('pointermove', main, null, 700, at.y)
    // 1. In and out in one go.
    into(at.x); out(); await wait(400)
    const passThrough = opened
    // 2. Button held: a drag or a text selection sweeping onto the rail and resting there.
    into(at.x, 1); fire('pointermove', item, null, at.x + 2, at.y, 1); await wait(400); out(1); await wait(300)
    const drag = opened
    // 3. Over the rail with no movement (the page reflowed under a resting pointer).
    into(700); fire('pointermove', item, null, 700, at.y); await wait(400); out(); await wait(300)
    const resting = opened
    // 4. Control: the same events with a real move, held there, do open it.
    fire('pointermove', main, null, 700, at.y); into(at.x); await wait(400)
    const control = opened
    out()
    return { passThrough, drag, resting, control }
  })
  expect(seen).toEqual({ passThrough: false, drag: false, resting: false, control: true })
})

test('a click closes it at once; another item reopens it; panels sit beside the narrow rail', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const at = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(at.x, at.y)
  await expect(rail(page)).toHaveClass(PEEK)
  await page.mouse.down()
  await page.mouse.up()
  // Snap: no animation out, the narrow rail is back in the click's own frame.
  await expect(rail(page)).not.toHaveClass(PEEK)
  expect(await railWidth(page)).toBeLessThan(60)
  await expect(page).toHaveURL(/\/notes/)
  // Resting on the clicked item keeps it closed.
  await page.mouse.move(at.x + 2, at.y + 1)
  await page.waitForTimeout(400)
  await expect(rail(page)).not.toHaveClass(PEEK)
  // Moving to another item is a new look.
  const cal = await centerOf(page, 'sidebar-core-app-calendar')
  await page.mouse.move(cal.x, cal.y, { steps: 3 })
  await expect(rail(page)).toHaveClass(PEEK)

  // The bell's panel slides out beside the narrow rail, and the rail stays narrow under it.
  const bell = rail(page).locator('.sidebar-notification-btn')
  await bell.hover()
  await bell.click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await expect(rail(page)).not.toHaveClass(PEEK)
  // After its slide-in (a translate) settles.
  await expect.poll(async () => Math.round((await panel.boundingBox())!.x)).toBe(56)
  await page.mouse.move(cal.x, cal.y, { steps: 3 })
  await page.waitForTimeout(400)
  await expect(rail(page)).not.toHaveClass(PEEK)
  // Escape closes the panel and puts focus back on the bell: that is not a keyboard visit,
  // so the rail stays narrow (it once opened here and stuck).
  await page.mouse.move(700, 400)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await page.waitForTimeout(400)
  await expect(rail(page)).not.toHaveClass(PEEK)
})

test('keyboard: focus in the rail opens it, Escape closes it, focus leaving folds it', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  // WebKit leaves links out of the Tab order (Safari's default), so focus moves by script
  // right after a key press, which makes it :focus-visible in both engines.
  const keyFocus = async (selector: string) => {
    await page.keyboard.press('Shift')
    await page.locator(selector).first().focus()
  }
  await keyFocus('[data-testid="sidebar-core-app-notes"]')
  await expect(notes(page)).toBeFocused()
  await expect(rail(page)).toHaveClass(PEEK)
  await page.keyboard.press('Escape')
  await expect(rail(page)).not.toHaveClass(PEEK)
  await keyFocus('[data-testid="sidebar-core-app-calendar"]')
  await expect(rail(page)).toHaveClass(PEEK)
  // Out of the rail into the page.
  await keyFocus('#home-task-navigation .todo-search-input')
  await expect(rail(page)).not.toHaveClass(PEEK, { timeout: 1500 })
})

test('a right-click menu keeps it open while the pointer is in the menu', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const at = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(at.x, at.y)
  await expect(rail(page)).toHaveClass(PEEK)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const menu = page.getByTestId('sidebar-app-ctx-menu')
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 6, { steps: 3 })
  await page.waitForTimeout(500)
  await expect(rail(page)).toHaveClass(PEEK)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.mouse.move(700, 400)
  await expect(rail(page)).not.toHaveClass(PEEK, { timeout: 1500 })
})

test('the hamburger pins it open; the docked sidebar does not peek', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const left = await mainLeft(page)
  const at = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(at.x, at.y)
  await expect(rail(page)).toHaveClass(PEEK)
  const pin = rail(page).locator('.sidebar-collapse-btn')
  await expect(pin).toHaveAttribute('title', 'Keep sidebar open')
  await pin.hover()
  await pin.click()
  await expect(rail(page)).not.toHaveClass(/\bcollapsed\b/)
  await expect(rail(page)).not.toHaveClass(PEEK)
  await expect.poll(() => mainLeft(page)).toBeGreaterThan(left + 150)
  await page.mouse.move(700, 400)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(300)
  await expect(rail(page)).not.toHaveClass(PEEK)
  await pin.click()
  await expect(rail(page)).toHaveClass(/\bcollapsed\b/)
  // The pointer still rests on the rail after un-pinning: the click itself does not reopen it.
  await page.waitForTimeout(300)
  await expect(rail(page)).not.toHaveClass(PEEK)
})

test.describe('touch', () => {
  test.use({ hasTouch: true })
  test('a tap never opens the peek; it just does what the icon does', async ({ page, baseURL }) => {
    await boot(page, baseURL!)
    const at = await centerOf(page, 'sidebar-core-app-notes')
    await page.touchscreen.tap(at.x, at.y)
    await expect(page).toHaveURL(/\/notes/)
    await page.waitForTimeout(400)
    await expect(rail(page)).not.toHaveClass(PEEK)
  })
})

test('Org is its own top-level entry, right under the Home group, and the peek names it', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const org = page.getByTestId('sidebar-org')
  await expect(page.locator('.sidebar-home-group [data-testid="sidebar-org"]')).toHaveCount(0)
  await expect(page.locator('.sidebar-nav > .sidebar-home-group + [data-testid="sidebar-org"]')).toHaveCount(1)
  // Same box as the other top-level rows (Notes), not a Home panel toggle's smaller one.
  const [orgBox, notesBox] = [await org.boundingBox(), await notes(page).boundingBox()]
  expect(orgBox!.height).toBe(notesBox!.height)
  expect(orgBox!.x).toBe(notesBox!.x)
  const at = await centerOf(page, 'sidebar-org')
  await page.mouse.move(at.x, at.y)
  await expect(rail(page)).toHaveClass(PEEK)
  await expect(org.locator('.sidebar-label')).toBeVisible()
  await expect(org.locator('.sidebar-label')).toHaveText('Org')
  await page.mouse.down()
  await page.mouse.up()
  await expect(page).toHaveURL(/\/org$/)
  await expect(org).toHaveAttribute('aria-current', 'page')
})
