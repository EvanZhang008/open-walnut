import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

/**
 * The collapsed rail's item peek (useRailPeek.ts, RailItemPill.tsx): hovering ONE icon
 * grows that one item out over the page with its name (a pill laid over its row, same
 * icon on the same spot); the other icons stay plain, the rail stays 56px and the page
 * never moves. Moving to the next icon moves the pill there at once. Pinned here too:
 * a pointer passing through or resting shows nothing, a click on the pill does what the
 * icon does and closes it, panels the rail opens are never under it, the keyboard
 * works the same way, touch never shows it, the hamburger still docks the full sidebar,
 * and Org is its own entry.
 */

const SHOTS = '/tmp/sidebar-pill'
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'default' })
test.setTimeout(120_000)

const rail = (page: Page) => page.locator('#primary-sidebar')
const pill = (page: Page) => page.getByTestId('rail-item-pill')
const notes = (page: Page) => page.getByTestId('sidebar-core-app-notes')

async function boot(page: Page, baseURL: string) {
  await isolateUiPrefs(page)
  await openHome(page, baseURL)
  await expect(rail(page)).toHaveClass(/\bcollapsed\b/)
  // Park the pointer on the page, away from the rail.
  await page.mouse.move(700, 400)
}

const railWidth = (page: Page) => rail(page).evaluate((el) => el.getBoundingClientRect().width)
const mainLeft = (page: Page) => page.locator('.main-content').evaluate((el) => el.getBoundingClientRect().left)
async function centerOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  if (!box) throw new Error(`no box for ${testId}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** The pill's grow clips its hit area too: aim at the name only once it is out. */
const grown = (page: Page) => pill(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => true))
/** The row's icon box and the pill's copy of it: the copy must sit exactly on the original. */
async function iconsOf(page: Page, testId: string) {
  const row = await page.getByTestId(testId).evaluate((el) => {
    const icon = [...el.children].find((c) => !c.matches('.sidebar-label, .notification-badge-dot, .notification-badge-count, .sidebar-host-dot, .quiet-moon'))!
    const r = icon.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]
  })
  const copy = await pill(page).evaluate((el) => {
    const r = el.querySelector('.rail-item-pill-icon')!.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]
  })
  return { row: row.map((n) => Math.round(n * 2) / 2), copy: copy.map((n) => Math.round(n * 2) / 2) }
}

test('hovering one icon grows only that item out with its name; the next icon takes it at once', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await boot(page, baseURL!)
  const left = await mainLeft(page)

  // The grow lasts ~0.2s: watch for it instead of racing it.
  await page.evaluate(() => {
    const w = window as unknown as { __grew: string[] }
    w.__grew = []
    new MutationObserver(() => {
      const p = document.querySelector('[data-testid="rail-item-pill"]')
      if (p?.hasAttribute('data-grow')) w.__grew.push(p.textContent ?? '')
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-grow'] })
  })
  const grew = () => page.evaluate(() => [...new Set((window as unknown as { __grew: string[] }).__grew)])
  const at = await centerOf(page, 'sidebar-core-app-settings')
  await page.mouse.move(at.x, at.y)
  await expect(pill(page)).toHaveCount(1)
  await expect(pill(page)).toHaveText('Settings')
  await expect.poll(grew).toEqual(['Settings'])
  // It grows once, then stays as it is.
  await expect(pill(page)).not.toHaveAttribute('data-grow')
  // Laid exactly over its row, growing out past the rail.
  const icons = await iconsOf(page, 'sidebar-core-app-settings')
  expect(icons.copy).toEqual(icons.row)
  const box = (await pill(page).boundingBox())!
  expect(box.x + box.width).toBeGreaterThan(70)
  // The rail did not widen, no other name shows, and the page did not move.
  expect(await railWidth(page)).toBeLessThan(60)
  await expect(rail(page).locator('.sidebar-label').filter({ visible: true })).toHaveCount(0)
  expect(await mainLeft(page)).toBe(left)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-settings.png`, clip: { x: 0, y: 0, width: 360, height: 800 } })

  // The next icon: the one pill moves there, whole, with no grow.
  const n = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(n.x, n.y)
  await expect(pill(page)).toHaveText('Notes')
  await expect(pill(page)).toHaveCount(1)
  await expect(pill(page)).not.toHaveAttribute('data-grow')
  expect(await grew()).toEqual(['Settings'])
  const again = await iconsOf(page, 'sidebar-core-app-notes')
  expect(again.copy).toEqual(again.row)

  // A Home toggle (a smaller row, a 16px icon) and Org, its own entry.
  const ag = await centerOf(page, 'sidebar-toggle-calendar')
  await page.mouse.move(ag.x, ag.y, { steps: 3 })
  await expect(pill(page)).toHaveText('Agenda')
  const agIcons = await iconsOf(page, 'sidebar-toggle-calendar')
  expect(agIcons.copy).toEqual(agIcons.row)
  const org = await centerOf(page, 'sidebar-org')
  await page.mouse.move(org.x, org.y, { steps: 3 })
  await expect(pill(page)).toHaveText('Org')

  // Leaving the rail takes it away.
  await page.mouse.move(700, 400)
  await expect(pill(page)).toHaveCount(0)
  expect(await mainLeft(page)).toBe(left)
  expect(errors).toEqual([])
})

test('a pointer passing through, a drag, or a page changing under a resting pointer shows nothing', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  // Synthetic pointer events in ONE task: a real sweep's timing is at the mercy of a loaded machine.
  const seen = await page.evaluate(async () => {
    const item = document.querySelector('[data-testid="sidebar-core-app-notes"]')!
    const main = document.querySelector('.main-content')!
    const box = item.getBoundingClientRect()
    const at = { x: box.left + 10, y: box.top + box.height / 2 }
    let shown = false
    new MutationObserver(() => { if (document.querySelector('[data-testid="rail-item-pill"]')) shown = true })
      .observe(document.body, { childList: true, subtree: true })
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
    into(at.x); out(); await wait(300)
    const passThrough = shown
    into(at.x, 1); fire('pointermove', item, null, at.x + 2, at.y, 1); await wait(300); out(1); await wait(300)
    const drag = shown
    // Over a row with no movement (the page reflowed under a resting pointer).
    into(700); fire('pointermove', item, null, 700, at.y); await wait(300); out(); await wait(300)
    const resting = shown
    // Control: the same events with a real move, held there, do show it.
    fire('pointermove', main, null, 700, at.y); into(at.x); await wait(300)
    const control = shown
    out()
    return { passThrough, drag, resting, control }
  })
  expect(seen).toEqual({ passThrough: false, drag: false, resting: false, control: true })
})

test('clicking the pill does what the icon does and closes it; panels open beside the narrow rail', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const at = await centerOf(page, 'sidebar-core-app-calendar')
  await page.mouse.move(at.x, at.y)
  await expect(pill(page)).toHaveText('Calendar')
  // Click on the NAME, past the rail's edge: it is the item, not the page under it.
  await grown(page)
  const box = (await pill(page).boundingBox())!
  await page.mouse.click(box.x + box.width - 12, at.y)
  await expect(page).toHaveURL(/\/calendar/)
  await expect(pill(page)).toHaveCount(0)
  // Resting on the clicked item keeps it quiet; another item shows its own.
  await page.mouse.move(at.x + 2, at.y + 1)
  await page.waitForTimeout(300)
  await expect(pill(page)).toHaveCount(0)
  const n = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(n.x, n.y, { steps: 3 })
  await expect(pill(page)).toHaveText('Notes')

  // The bell's panel slides out beside the rail with no pill over it.
  const bell = rail(page).locator('.sidebar-notification-btn')
  const bb = (await bell.boundingBox())!
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 3 })
  await expect(pill(page)).toContainText('Notifications')
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await expect(pill(page)).toHaveCount(0)
  await expect.poll(async () => Math.round((await panel.boundingBox())!.x)).toBe(56)
  await page.mouse.move(n.x, n.y, { steps: 3 })
  await page.waitForTimeout(300)
  await expect(pill(page)).toHaveCount(0)
  // Escape closes the panel and hands focus back to the bell: no pill for that.
  await page.mouse.move(700, 400)
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(pill(page)).toHaveCount(0)
})

test('the row under the pill keeps its own events, and the pill follows the row\'s content', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const at = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(at.x, at.y)
  await expect(pill(page)).toHaveText('Notes')
  // The pill lets the pointer through over its row: the row itself is what is under it.
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), at)
  expect(under).toBe('sidebar-core-app-notes')
  // A change inside the row (a badge, a ticking ring) shows on the pill.
  await notes(page).evaluate((el) => { el.querySelector('.sidebar-label')!.textContent = 'Notes 2' })
  await expect(pill(page)).toHaveText('Notes 2')
  await notes(page).evaluate((el) => { el.querySelector('.sidebar-label')!.textContent = 'Notes' })
  // A press that lands as the pill appears is still the row's click.
  await page.mouse.move(700, 400)
  await expect(pill(page)).toHaveCount(0)
  const mail = await centerOf(page, 'sidebar-core-app-mail')
  await page.mouse.move(mail.x, mail.y)
  await page.mouse.down()
  await expect(pill(page)).toHaveText('Mail')
  await page.mouse.up()
  await expect(page).toHaveURL(/\/mail/)
})

test('right-clicking the pill opens that item\'s menu, and the pill stays while the menu is up', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const at = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(at.x, at.y)
  await expect(pill(page)).toHaveText('Notes')
  await grown(page)
  const box = (await pill(page).boundingBox())!
  await page.mouse.click(box.x + box.width - 12, at.y, { button: 'right' })
  const menu = page.getByTestId('sidebar-app-ctx-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('Notes')
  const mb = (await menu.boundingBox())!
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height - 6, { steps: 3 })
  await page.waitForTimeout(400)
  await expect(pill(page)).toHaveText('Notes')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.mouse.move(700, 400)
  await expect(pill(page)).toHaveCount(0)
})

test('keyboard: the focused item shows its pill, it follows focus, Escape and focus leaving hide it', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  // WebKit leaves links out of the Tab order (Safari's default), so focus moves by script
  // right after a key press, which makes it :focus-visible in both engines.
  const keyFocus = async (selector: string) => {
    await page.keyboard.press('Shift')
    await page.locator(selector).first().focus()
  }
  await keyFocus('[data-testid="sidebar-core-app-notes"]')
  await expect(notes(page)).toBeFocused()
  await expect(pill(page)).toHaveText('Notes')
  await keyFocus('[data-testid="sidebar-core-app-calendar"]')
  await expect(pill(page)).toHaveText('Calendar')
  await page.keyboard.press('Escape')
  await expect(pill(page)).toHaveCount(0)
  await keyFocus('[data-testid="sidebar-core-app-mail"]')
  await expect(pill(page)).toHaveText('Mail')
  await keyFocus('#home-task-navigation .todo-search-input')
  await expect(pill(page)).toHaveCount(0)
})

test('the hamburger still docks the full sidebar, and the docked sidebar shows no pill', async ({ page, baseURL }) => {
  await boot(page, baseURL!)
  const left = await mainLeft(page)
  const ham = rail(page).locator('.sidebar-collapse-btn')
  await expect(ham).toHaveAttribute('title', 'Expand sidebar')
  await ham.click()
  await expect(rail(page)).not.toHaveClass(/\bcollapsed\b/)
  await expect.poll(() => mainLeft(page)).toBeGreaterThan(left + 150)
  const at = await centerOf(page, 'sidebar-core-app-notes')
  await page.mouse.move(at.x, at.y, { steps: 3 })
  await page.waitForTimeout(300)
  await expect(pill(page)).toHaveCount(0)
  await ham.click()
  await expect(rail(page)).toHaveClass(/\bcollapsed\b/)
})

test('Org is its own top-level entry, right under the Home group', async ({ page, baseURL }) => {
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
  await expect(pill(page)).toHaveText('Org')
  await page.mouse.click(at.x, at.y)
  await expect(page).toHaveURL(/\/org$/)
  await expect(org).toHaveAttribute('aria-current', 'page')
})

test.describe('touch', () => {
  test.use({ hasTouch: true })
  test('a tap never shows a pill; it just does what the icon does', async ({ page, baseURL }) => {
    await boot(page, baseURL!)
    const at = await centerOf(page, 'sidebar-core-app-notes')
    await page.touchscreen.tap(at.x, at.y)
    await expect(page).toHaveURL(/\/notes/)
    await page.waitForTimeout(300)
    await expect(pill(page)).toHaveCount(0)
  })
})
