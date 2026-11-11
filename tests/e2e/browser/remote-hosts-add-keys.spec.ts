/**
 * Settings > Remote Hosts: Add host's menu, from the mouse and the keyboard, again and again in
 * one page (2026-11-05 reviews, WebKit: after a close by a click on blank page, Enter on Add host
 * opened nothing, or a menu that closed itself within half a second; ArrowDown to the SSH host item
 * and Enter opened the menu again at its first item instead of adding an SSH host; a click on Add
 * host while its menu was open left it open). The user's own report started this: "this button
 * doesn't wrok can we make sure it wroks?".
 *
 * The cause was a close's deferred focus move (useMenuButton.ts): one frame after a close it put
 * the focus back on the button "if it fell", and it counted a focus inside the menu as fallen, so
 * when the next open came inside that frame it took the focus out of the new menu, which closed.
 * WebKit spaces frames up to half a second apart under load; `slowFrames` makes every frame that
 * late here, so the race is not left to the machine's load.
 *
 * Run: walnut-dev run -e PW_WEBKIT=1 bun x playwright test tests/e2e/browser/remote-hosts-add-keys.spec.ts --project webkit --retries=0
 */
import { expect, test, type Page } from '@playwright/test'
import { resetServerHostFixture } from './host-problems-fixture-helpers'
import { openFixturePane, row } from './remote-hosts-every-button-helpers'
import { ADD_ITEMS, addButton } from './remote-hosts-every-button-steps'

test.setTimeout(300_000)
test.use({ actionTimeout: 15_000 })

const menu = (page: Page) => page.getByTestId('remote-hosts-add-menu')
const draft = (page: Page) => page.locator('#remote-hosts .rh-host-row[data-unsaved="true"]')
const hostname = (page: Page) => page.locator('input[id^="rh-hostname-"]')

/** Every animation frame comes this late (WebKit under load), so a deferred focus move races the next key. */
async function slowFrames(page: Page, ms: number): Promise<void> {
  await page.evaluate((delay) => {
    const raf = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb: FrameRequestCallback) => raf(() => { window.setTimeout(() => cb(performance.now()), delay) })
  }, ms)
}

/**
 * Resolves once `n` animation frames ran in the page after the call. A deferred focus move runs in
 * the frame after the press that queued it, and frames run in order, so once these ran every move
 * queued before them has run too: the wait is the signal itself, not a guess at how long it takes.
 */
async function framesPass(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => new Promise<void>((done) => {
    let left = count
    const tick = () => { if (--left <= 0) done(); else window.requestAnimationFrame(tick) }
    window.requestAnimationFrame(tick)
  }), n)
}

/** The menu is open with `item` highlighted, and stays open through the frames after the press. */
async function staysOpen(page: Page, item: number): Promise<void> {
  await expect(menu(page)).toBeVisible()
  for (const frames of [1, 2, 3]) {
    await framesPass(page, 1)
    await expect(menu(page), `menu still open ${frames} frame(s) after the press`).toBeVisible({ timeout: 100 })
  }
  await expect(menu(page).getByRole('menuitem').nth(item)).toHaveClass(/\bfocused\b/)
  await expect(menu(page)).toBeFocused()
}

/** A click at the middle of `el`, whatever lies on top of it there. */
async function clickAt(page: Page, el: ReturnType<Page['locator']>): Promise<void> {
  const b = (await el.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

/**
 * A point on the pane that holds nothing: the middle of the Overview's head, between its toggle
 * and when the hosts were read (the head spreads them to its two ends). Checked to hold no control
 * and no part of the open menu, so the click is on blank page.
 */
async function blankPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator('[data-testid="host-fleet"] .hf-dash-head').boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    const what = el?.closest('button, a[href], input, select, textarea, [role="button"], [role="menu"], [role="menuitem"]')
    return what ? what.outerHTML.slice(0, 120) : null
  }, at)
  expect(hit, 'the blank point holds no control').toBeNull()
  return at
}

test.describe('Settings > Remote Hosts: Add host from the mouse and the keyboard', () => {
  test.describe.configure({ mode: 'serial' })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('every way in works every time, in one page, with late frames', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // A WebKit page that crashes answers nothing more: say so, or the next check reads as a timeout.
    page.on('crash', () => { errors.push('the WebKit page crashed'); console.error('[add-keys] the WebKit page crashed') })
    await openFixturePane(page, request)
    await slowFrames(page, 300)

    // Claude review, sequence 1, four rounds: open with the mouse, close with a click on blank
    // page (the focus comes back to Add host, not the page), then Enter opens it and it stays open.
    for (let round = 1; round <= 4; round++) {
      await addButton(page).click()
      await expect(menu(page)).toBeVisible()
      const blank = await blankPoint(page)
      await page.mouse.click(blank.x, blank.y)
      await expect(menu(page)).toHaveCount(0)
      await expect(addButton(page), `round ${round}: the focus is back on Add host`).toBeFocused()
      await addButton(page).focus()
      await page.keyboard.press('Enter')
      await staysOpen(page, 0)
      await page.keyboard.press('Escape')
      await expect(menu(page)).toHaveCount(0)
      await expect(addButton(page)).toBeFocused()
    }

    // Escape, then a key at once (inside the late frame of that close): the new menu stays.
    for (const key of ['Enter', 'Space', 'ArrowDown', 'Enter']) {
      await addButton(page).click()
      await expect(menu(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press(key)
      await staysOpen(page, 0)
      await page.keyboard.press('Escape')
      await expect(menu(page)).toHaveCount(0)
    }

    // second-model review, three rounds: Escape, ArrowDown opens at the first item, ArrowDown twice to the SSH host,
    // Enter adds an SSH host (its Hostname focused), never the menu again at its first item.
    for (let round = 1; round <= 3; round++) {
      await addButton(page).click()
      await expect(menu(page)).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(menu(page)).toHaveCount(0)
      await expect(addButton(page)).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(menu(page)).toBeVisible()
      await expect(menu(page).getByRole('menuitem').first()).toHaveClass(/\bfocused\b/)
      // The second item picks from ~/.ssh/config; the third adds a typed SSH host.
      await page.keyboard.press('ArrowDown')
      await expect(menu(page).getByRole('menuitem', { name: ADD_ITEMS[1] })).toHaveClass(/\bfocused\b/)
      await page.keyboard.press('ArrowDown')
      await expect(menu(page).getByRole('menuitem', { name: ADD_ITEMS[2] })).toHaveClass(/\bfocused\b/)
      await page.keyboard.press('Enter')
      await expect(draft(page), `round ${round}: Enter added the SSH host`).toHaveCount(1)
      await expect(hostname(page)).toBeFocused()
      // Past every move the close queued (each a frame later): the menu stays shut, the field keeps the focus.
      await framesPass(page, 3)
      await expect(menu(page)).toHaveCount(0)
      await expect(hostname(page)).toBeFocused()
      // Escape takes the untouched row away and gives the focus back to Add host.
      await hostname(page).press('Escape')
      await expect(draft(page)).toHaveCount(0)
      await expect(addButton(page)).toBeFocused()
    }

    // A click on Add host while its menu is open closes it, and it stays closed; the next opens it.
    // A person's click, where the button is: the menu's backdrop lies over it (Playwright's own
    // click would wait for the backdrop to go).
    for (let round = 1; round <= 3; round++) {
      await addButton(page).click()
      await expect(menu(page)).toBeVisible()
      await expect(addButton(page)).toHaveAttribute('aria-expanded', 'true')
      await clickAt(page, addButton(page))
      await expect(menu(page)).toHaveCount(0)
      await framesPass(page, 3)
      await expect(menu(page), `round ${round}: still closed`).toHaveCount(0)
      await expect(addButton(page)).toHaveAttribute('aria-expanded', 'false')
      await expect(addButton(page)).toBeFocused()
    }
    // Each way in, by the mouse after all of that: the link and the SSH host.
    await addButton(page).click()
    await menu(page).getByRole('menuitem', { name: ADD_ITEMS[2] }).click()
    await expect(hostname(page)).toBeFocused()
    await hostname(page).press('Escape')
    await expect(draft(page)).toHaveCount(0)

    // A row's More menu follows the same rules: a second press closes it, Escape gives the focus back.
    const more = row(page, 'devbox').getByTestId('rh-row-more')
    const rowMenu = page.getByTestId('rh-row-menu')
    for (let round = 1; round <= 2; round++) {
      await more.click()
      await expect(rowMenu).toBeVisible()
      await clickAt(page, more)
      await expect(rowMenu).toHaveCount(0)
      await framesPass(page, 3)
      await expect(rowMenu).toHaveCount(0)
      await more.focus()
      await page.keyboard.press('Enter')
      await expect(rowMenu).toBeVisible()
      await framesPass(page, 3)
      await expect(rowMenu).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(rowMenu).toHaveCount(0)
      await expect(more).toBeFocused()
    }
    expect(errors).toEqual([])
  })
})
