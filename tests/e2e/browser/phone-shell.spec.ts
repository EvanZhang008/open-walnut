/**
 * The phone shell (spec 4.1, 4.2, 4.7; C19-C21, C28-C30, C41, C52, C72, C85,
 * C92, C93): the top bar and its safe areas, heights in dvh, toasts inside the
 * screen and one at a time, a phone held sideways, the touch iPad on desktop
 * columns, and the Home Screen app's file links. Playwright draws no notch and
 * no keyboard, so the specs write the CSS variables the phone rules read.
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import {
  PHONE, expectNoHorizontalOverflow, findSmallTargets, findSmallText, injectSafeArea,
  menuButton, openDrawer, setKeyboardInset,
} from './phone-helpers'

const SHOTS = '/tmp/mobile-web/phone-shell'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

async function bootHome(page: Page): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('phone-shell-seeded')) return
      sessionStorage.setItem('phone-shell-seeded', '1')
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
    } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  return errors
}

const bar = (page: Page) => page.locator('.phone-topbar')

async function rect(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`${selector} has no box`)
  return b
}

test('with no safe area the bar is 44 px, fixed, opaque, and its targets are finger sized', async ({ page }, info) => {
  const errors = await bootHome(page)
  const b = await rect(page, '.phone-topbar')
  expect(Math.round(b.y)).toBe(0)
  expect(Math.round(b.height)).toBe(44)
  const style = await bar(page).evaluate((el) => {
    const cs = getComputedStyle(el)
    return { position: cs.position, top: cs.top, bg: cs.backgroundColor, paddingTop: cs.paddingTop }
  })
  expect(style.position).toBe('fixed')
  expect(style.top).toBe('0px')
  expect(style.paddingTop).toBe('0px')
  expect(style.bg).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)|transparent/)
  const m = await menuButton(page).boundingBox()
  expect(m!.width).toBeGreaterThanOrEqual(44)
  expect(m!.height).toBeGreaterThanOrEqual(44)
  expect(await findSmallTargets(page, '.phone-topbar')).toEqual([])
  expect(await findSmallText(page, 12, '.phone-topbar')).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-bar.png`, scale: 'css' })
  expect(errors).toEqual([])
})

test('a notch and a home indicator: the bar grows by the top inset, the drawer ends above the bottom one', async ({ page }, info) => {
  await bootHome(page)
  await injectSafeArea(page, { top: 47, bottom: 34 })
  await expect.poll(async () => Math.round((await rect(page, '.phone-topbar')).height)).toBe(91)
  expect((await menuButton(page).boundingBox())!.y).toBeGreaterThanOrEqual(47)
  const title = await rect(page, '.phone-topbar-title')
  expect(title.y).toBeGreaterThanOrEqual(47)
  // The page starts under the taller bar.
  expect((await rect(page, '.main-page-todo')).y).toBeGreaterThanOrEqual(91 - 0.5)
  await openDrawer(page)
  const vp = page.viewportSize()!
  const last = await page.locator('#primary-sidebar').evaluate((aside) => {
    const items = Array.from(aside.querySelectorAll<HTMLElement>('a[href], button')).filter((el) => el.getClientRects().length > 0)
    const end = items[items.length - 1]
    aside.scrollTop = aside.scrollHeight
    return end.getBoundingClientRect().bottom
  })
  expect(last).toBeLessThanOrEqual(vp.height - 34 + 0.5)
  await expect.poll(() => page.locator('#primary-sidebar').evaluate((el) => el.getAnimations().length)).toBe(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-notch-drawer.png`, scale: 'css' })
})

test('phone-reachable heights use dvh, and the page never rubber-bands', async ({ page }) => {
  await bootHome(page)
  // Each 100vh rule a phone reaches has a 100dvh twin in a phone media rule.
  const covered = await page.evaluate(() => {
    const wanted = ['.memory-split-view', '.chat-page', '.popout-root', '.cal-page', '.scd-modal',
      '.mail-add-dialog', '.mail-unsub-plan', '.session-control-menu', '.task-kebab-menu', '.dp-popover',
      '.cal-cals-popover', '.cal-item-popover', '.sidebar', '.app-shell']
    const found = new Set<string>()
    const walk = (rules: CSSRuleList, inPhone: boolean) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSMediaRule) walk(r.cssRules, inPhone || r.conditionText.includes('max-height: 500px'))
        else if (r instanceof CSSStyleRule && inPhone && r.cssText.includes('100dvh')) {
          for (const w of wanted) if (r.selectorText.includes(w)) found.add(w)
        }
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules, false) } catch { /* cross-origin sheet */ }
    }
    return wanted.filter((w) => !found.has(w))
  })
  expect(covered, 'selectors without a 100dvh phone rule').toEqual([])
  const vpH = page.viewportSize()!.height
  expect((await rect(page, '.app-shell')).height).toBeLessThanOrEqual(vpH + 0.5)
  const over = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overscrollBehaviorY,
    body: getComputedStyle(document.body).overscrollBehaviorY,
  }))
  expect(over).toEqual({ html: 'none', body: 'none' })
  await openDrawer(page)
  const d = await rect(page, '#primary-sidebar')
  expect(d.y + d.height).toBeLessThanOrEqual(vpH + 0.5)
  expect(d.width).toBeLessThanOrEqual(Math.min(320, page.viewportSize()!.width * 0.85) + 0.5)
})

test('the keyboard inset never moves the bar, and a focused field pulls a panned page back', async ({ page }) => {
  await bootHome(page)
  await page.locator('.todo-search-input').click()
  // On a phone the home field hands focus to the full-screen search.
  await expect(page.locator('.phone-search-input')).toBeFocused()
  const zoom = await page.evaluate(() => ({ scale: window.visualViewport?.scale ?? 1, size: parseFloat(getComputedStyle(document.activeElement as Element).fontSize) }))
  expect(zoom.size).toBeGreaterThanOrEqual(16)
  expect(zoom.scale).toBe(1)
  await setKeyboardInset(page, 336)
  expect(Math.round((await rect(page, '.phone-topbar')).y)).toBe(0)
  await page.evaluate(() => { document.documentElement.style.minHeight = '3000px'; window.scrollTo(0, 120) })
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await page.evaluate(() => { document.documentElement.style.minHeight = '' })
  await setKeyboardInset(page, 0)
})

/** A socket in the middle, so the spec can hand the page server events. */
async function routeSocket(page: Page): Promise<() => WebSocketRoute | null> {
  let socket: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => { socket = route; route.connectToServer() })
  return () => socket
}

/** A refused agent turn toasts (a routine's notice, or a plain failed turn, only goes to the feed). */
function agentErrorEvent(agentId: string, error: string): string {
  return JSON.stringify({ type: 'event', name: 'agent:error', data: { agentId, error }, seq: -1 })
}

test('toasts stay inside the screen under the bar, one at a time, with a 44 px close and swipe up', async ({ page }, info) => {
  const sock = await routeSocket(page)
  await bootHome(page)
  await expect.poll(() => sock() !== null).toBe(true)
  // Freeze the page's timers: these toasts expire after 6 s, and a loaded
  // machine takes longer than that to measure them.
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 1_000)
  sock()!.send(agentErrorEvent('agent-one', '401 unauthorized (first test notice)'))
  sock()!.send(agentErrorEvent('agent-two', '401 unauthorized (second test notice)'))
  const toasts = page.locator('.notification-toaster .notification-toast')
  await expect(toasts).toHaveCount(1, { timeout: 10_000 })
  const vp = page.viewportSize()!
  // Measured once its entrance has settled.
  await expect.poll(async () => (await toasts.first().evaluate((el) => el.getAnimations().length))).toBe(0)
  const t = (await toasts.first().boundingBox())!
  expect(t.x).toBeGreaterThanOrEqual(8 - 0.5)
  expect(t.x + t.width).toBeLessThanOrEqual(vp.width - 8 + 0.5)
  expect(t.y).toBeGreaterThanOrEqual(44 + 8 - 0.5)
  const close = (await toasts.first().locator('.notification-toast-close').boundingBox())!
  expect(close.width).toBeGreaterThanOrEqual(44)
  expect(close.height).toBeGreaterThanOrEqual(44)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-toast.png`, scale: 'css' })
  await expect(toasts.first()).toContainText('first test notice')
  // The x dismisses it; the queued one takes its place.
  await toasts.first().locator('.notification-toast-close').click()
  await expect(toasts).toHaveCount(1)
  await expect(toasts.first()).toContainText('second test notice')
  // Swipe up dismisses the next one.
  await expect.poll(async () => (await toasts.first().evaluate((el) => el.getAnimations().length))).toBe(0)
  const t2 = (await toasts.first().boundingBox())!
  const cx = t2.x + t2.width / 2
  await page.mouse.move(cx, t2.y + 20)
  await page.mouse.down()
  await page.mouse.move(cx, t2.y - 40, { steps: 5 })
  await page.mouse.up()
  await expect(toasts).toHaveCount(0)
})

test('a phone held sideways is still a phone, and the drawer stays open across the turn', async ({ page }, info) => {
  await bootHome(page)
  await openDrawer(page)
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(bar(page)).toBeVisible()
  await expect(page.locator('#primary-sidebar')).toHaveClass(/\bopen\b/)
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true')
  await menuButton(page).click()
  await expect(page.locator('#primary-sidebar')).not.toHaveClass(/\bopen\b/)
  await expectNoHorizontalOverflow(page)
  await injectSafeArea(page, { left: 47, right: 47 })
  await expect.poll(async () => (await menuButton(page).boundingBox())!.x).toBeGreaterThanOrEqual(47)
  const b = await rect(page, '.phone-topbar')
  const slot = await rect(page, '.phone-topbar-right')
  expect(slot.x + slot.width).toBeLessThanOrEqual(b.width - 47 + 0.5)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-landscape.png`, scale: 'css' })
})

for (const size of [{ width: 375, height: 667 }, { width: 320, height: 568 }]) {
  test(`at ${size.width} x ${size.height} the bar and the drawer fit, with finger targets and legible text`, async ({ page }, info) => {
    await page.setViewportSize(size)
    await bootHome(page)
    await expectNoHorizontalOverflow(page)
    expect(await findSmallTargets(page, '.phone-topbar')).toEqual([])
    expect(await findSmallText(page, 12, '.phone-topbar')).toEqual([])
    await openDrawer(page)
    await expectNoHorizontalOverflow(page)
    expect(await findSmallTargets(page, '#primary-sidebar')).toEqual([])
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-drawer-${size.width}.png`, scale: 'css' })
  })
}

test('standalone: a link to a Walnut file stays in the app (no window.open, no new tab)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
    const w = window as unknown as { __opens: number }
    w.__opens = 0
    window.open = () => { w.__opens += 1; return null }
  })
  await bootHome(page)
  let popups = 0
  page.on('popup', () => { popups += 1 })
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.href = '/api/dashboard'
    a.target = '_blank'
    a.textContent = 'Open the file'
    a.id = 'standalone-file-link'
    a.style.cssText = 'position:fixed;left:100px;top:300px;z-index:99999;padding:16px;background:#fff'
    document.querySelector('.app-shell')!.appendChild(a)
  })
  const download = page.waitForEvent('download', { timeout: 10_000 })
  await page.locator('#standalone-file-link').click()
  expect((await download).suggestedFilename()).toMatch(/^dashboard/)
  expect(popups).toBe(0)
  expect(await page.evaluate(() => (window as unknown as { __opens: number }).__opens)).toBe(0)
  await expect(page).toHaveURL(/\/$/)
})

test.describe('touch iPad, portrait', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, screen: { width: 820, height: 1180 } })

  test('runs the desktop columns: no phone bar, the rail beside the page', async ({ page }) => {
    await isolateUiPrefs(page)
    await page.goto('/')
    await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.phone-topbar')).toHaveCount(0)
    const rail = await rect(page, '#primary-sidebar')
    expect(rail.y).toBe(0)
    expect(rail.x).toBe(0)
    expect((await rect(page, '.main-page-todo')).x).toBeGreaterThanOrEqual(rail.width - 1)
  })
})

test('a tap on the page name scrolls the page to the top (Settings, a long page)', async ({ page }) => {
  await bootHome(page)
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  await expect(page.locator('.settings-container')).toBeVisible()
  // The page's scroll box: the largest scrollable element in <main> (what the
  // title tap scrolls too).
  const found = await page.evaluate(() => {
    let best: HTMLElement | null = null
    let area = 0
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('main.main-content *'))) {
      const oy = getComputedStyle(el).overflowY
      if ((oy !== 'auto' && oy !== 'scroll') || el.scrollHeight <= el.clientHeight + 1) continue
      const r = el.getBoundingClientRect()
      if (r.width * r.height > area) { best = el; area = r.width * r.height }
    }
    best?.setAttribute('data-test-scroller', '1')
    return !!best
  })
  test.skip(!found, 'nothing on the Settings page scrolls at this size')
  const scroller = page.locator('[data-test-scroller]')
  await scroller.evaluate((el) => { el.scrollTop = 400 })
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.locator('.phone-topbar-title').click()
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(0)
})
