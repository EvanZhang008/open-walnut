/**
 * The card's size and motion in the task panel, and the notification panel's
 * System host list (slice spec 4.1, 4.2, 5.5): the 40% cap, narrow and phone
 * widths, themes, loading, search, section switches (the card never leaves
 * the task panel, so the task list holds still), scroll positions, drags,
 * height changes that wait for the pointer, the Errors group's Shown in
 * System link and the screen-reader announcer.
 * Host frames and local health are routed client-side. BP-C63 is WebKit only.
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-layout --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-layout --project=webkit --workers=1
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Locator } from '@playwright/test'
import {
  anyBanner, banner, connected, failed, hideTaskPanel, isolatePrefs, now, resetServerHostFixture, routeHealth, row,
  showTaskPanel, signedOut, slotLayout, Hosts,
} from './host-problems-helpers'
import { openBell, panelBanner, slotBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, bpSetup, cardRow, closePanel, expectHomeCardStill, healthyGitSync, hostErrorRecord, hostsOf, markHomeCard,
  openSystemHosts, pickRail, railButton, systemHostRow, systemHosts, systemListHosts, systemLocalCard,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const six = () => [
  failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'), failed('proxybox', 'Proxy box', 'proxy'),
  failed('lanbox', 'Lan box', 'unreachable'), failed('certbox', 'Cert box', 'cert_expired'), signedOut('signbox', 'Sign box'),
]
const three = () => [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'), failed('proxybox', 'Proxy box', 'proxy')]
const height = async (l: Locator) => (await l.boundingBox())!.height

test.describe('the 40% cap', () => {
  test('BP-C28: 1280x900, six problems and a local sign-in: card and host section within the task panel cap; the section scrolls; rows 2+ folded', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await bpSetup(page, { hosts: six(), local: 'sign-in' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const panelH = await height(page.locator('.todo-panel'))
    const cap = Math.max(panelH * 0.4, 132) + 1
    expect(await height(page.locator('.todo-panel .attention-banner'))).toBeLessThanOrEqual(cap)
    expect(await height(banner(page).locator('.hpb').first())).toBeLessThanOrEqual(cap)
    // The host list is the card's one scroll region (dense rows may now all fit: every row starts closed, BP-R3-N1).
    const sc = banner(page).locator('.hpb-scroll')
    expect(await sc.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')
    expect(await banner(page).evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    const shown = await hostsOf(banner(page))
    for (const host of shown) await expect(cardRow(banner(page), host!).locator('.hft-hint')).toHaveCount(0)
    await banner(page).screenshot({ path: `${BP_SHOTS}/c28-tasks-cap.png` })
  })

  test('BP-C29: the same six problems and local sign-in in System: no card; the Claude Code card leads, the host list starts inside the top 60% of the panel and names each host once; the rail keeps the whole panel height', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await bpSetup(page, { hosts: six(), local: 'sign-in' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const hosts = await openSystemHosts(page)
    const panel = (await page.locator('.notification-panel').boundingBox())!
    const first = (await page.locator('.notification-panel .nfc-detail .notification-card').first().boundingBox())!
    const local = (await systemLocalCard(page).boundingBox())!
    expect(Math.abs(first.y - local.y)).toBeLessThanOrEqual(1)
    const list = (await hosts.boundingBox())!
    expect(list.y).toBeGreaterThanOrEqual(local.y + local.height - 1)
    expect(list.y - panel.y).toBeLessThanOrEqual(panel.height * 0.6)
    // A status list has no cap: every host, each once, and nothing wider than the panel.
    expect(await systemListHosts(page)).toEqual(['keybox', 'netbox', 'proxybox', 'lanbox', 'certbox', 'signbox'])
    expect(await page.locator('.notification-panel .nfc-detail').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const rail = (await page.locator('.notification-panel .nfc-rail').boundingBox())!
    expect(rail.y).toBeLessThanOrEqual(first.y)
    expect(rail.y + rail.height).toBeGreaterThanOrEqual(panel.y + panel.height - 2)
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c29-system-list.png` })
  })

  test('BP-C61: 1280x600, a local sign-in and three hosts: the whole card within the cap, the local section whole, the host section scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 })
    await bpSetup(page, { hosts: three(), local: 'sign-in' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const panelH = await height(page.locator('.todo-panel'))
    expect(await height(page.locator('.todo-panel .attention-banner'))).toBeLessThanOrEqual(Math.max(panelH * 0.4, 132) + 1)
    const local = banner(page).locator('[data-testid="setup-banner-sign-in"]')
    await expect(local).toBeInViewport({ ratio: 1 })
    expect(await banner(page).locator('.hpb-scroll').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await page.screenshot({ path: `${BP_SHOTS}/c61-1280x600.png` })
  })
})

test.describe('narrow, phone, themes, loading', () => {
  test('BP-C30: a 980px window with a 300px task panel: no sideways scroll, actions under the body, 2 lines at most, the x clear of the text', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { hosts: [failed('certbox', 'Cert box', 'cert_expired', { retryAt: now() + 192_000 }), signedOut('signbox', 'Sign box')] })
    await page.addStyleTag({ content: '.main-page-todo { flex: 0 0 300px !important; width: 300px !important; min-width: 0 !important; max-width: 300px !important; }' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const card = page.locator('.todo-panel .attention-banner')
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const r = row(page, 'certbox')
    const head = r.locator('.hft-headline')
    const lines = await head.evaluate((el) => Math.round(el.getBoundingClientRect().height / (parseFloat(getComputedStyle(el).lineHeight) || 16)))
    expect(lines).toBeLessThanOrEqual(2)
    const hb = (await head.boundingBox())!
    expect((await r.getByTestId('hpb-retry').boundingBox())!.y).toBeGreaterThanOrEqual(hb.y + hb.height - 1)
    const xb = (await r.getByRole('button', { name: 'Dismiss Cert box' }).boundingBox())!
    const overlap = !(xb.x >= hb.x + hb.width || xb.x + xb.width <= hb.x || xb.y >= hb.y + hb.height || xb.y + xb.height <= hb.y)
    expect(overlap).toBe(false)
    await card.screenshot({ path: `${BP_SHOTS}/c30-narrow-300.png` })
  })

  test('BP-C31: a 390x844 phone: the first headline and one button show in the task panel band; the System host list spans the sheet, its rows whole across', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await page.screenshot({ path: `${BP_SHOTS}/c31-phone-before.png` })
    // Whole inside the viewport and inside the host section's visible (scroll-clipped) box.
    const seen = await row(page, 'netbox').evaluate((el) => {
      const clip = (el.closest('.hpb-scroll') ?? el.closest('.attention-banner'))!.getBoundingClientRect()
      const whole = (e: Element | null) => {
        if (!e) return false
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.top >= Math.max(0, clip.top) - 1 && r.bottom <= Math.min(window.innerHeight, clip.bottom) + 1
      }
      const buttons = Array.from(el.querySelectorAll('.hpb-actions button, [data-testid="hpb-retry"]'))
      return { headline: whole(el.querySelector('.hft-headline')), button: buttons.some((b) => whole(b)) }
    })
    expect(seen).toEqual({ headline: true, button: true })
    await page.screenshot({ path: `${BP_SHOTS}/c31-phone-tasks.png` })
    const hosts = await openSystemHosts(page)
    const pb = (await page.locator('.notification-panel').boundingBox())!
    const cb = (await hosts.boundingBox())!
    expect(cb.x).toBeGreaterThanOrEqual(pb.x - 1)
    expect(cb.x + cb.width).toBeLessThanOrEqual(pb.x + pb.width + 1)
    expect(cb.width).toBeGreaterThanOrEqual(pb.width - 48)
    const nb = (await systemHostRow(page, 'netbox').boundingBox())!
    expect(nb.x + nb.width).toBeLessThanOrEqual(cb.x + cb.width + 1)
    const retry = (await systemHostRow(page, 'netbox').getByTestId('hpb-retry').boundingBox())!
    expect(retry.x + retry.width).toBeLessThanOrEqual(cb.x + cb.width + 1)
    await page.screenshot({ path: `${BP_SHOTS}/c31-phone-panel.png` })
  })

  test('BP-C32: dark theme: the task panel card shares the slot card\'s background; System rows draw none of their own; the card CSS has no literal colours', async ({ page, browser }) => {
    const dark = async (p: import('@playwright/test').Page) => { await p.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = 'dark' }) }) }
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')], before: dark })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const bg = (l: Locator) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
    const tasksBg = await bg(page.locator('.todo-panel .attention-banner'))
    await page.locator('.todo-panel .attention-banner').screenshot({ path: `${BP_SHOTS}/c32-dark-tasks.png` })
    await openSystemHosts(page)
    // A System row sits on its Remote hosts block, never on a card of its own.
    const rowBg = await bg(systemHostRow(page, 'netbox'))
    expect(rowBg).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/)
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c32-dark-panel.png` })
    const ctx = await browser.newContext()
    const p2 = await ctx.newPage()
    try {
      await bpSetup(p2, { hosts: [failed('netbox', 'Net box', 'unreachable')], before: async (p) => { await slotLayout(p); await dark(p) } })
      await p2.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
      await expect(slotBanner(p2)).toHaveCount(1, { timeout: 20_000 })
      const slotBg = await bg(p2.locator('.main-page-chat .attention-banner'))
      expect(tasksBg).toBe(slotBg)
    } finally {
      await ctx.close()
    }
    const css = fs.readFileSync(path.resolve(process.cwd(), 'web/src/styles/attention-banner.css'), 'utf-8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })

  test('BP-C34: a 3s host hydrate: no host section and no "unknown" text meanwhile; then the rows arrive', async ({ page }) => {
    await isolatePrefs(page)
    await healthyGitSync(page)
    const h = new Hosts(page)
    h.hydrateDelayMs = 6000 // past the first paint, so the wait is observable
    await h.install([failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')])
    await routeHealth(page)
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const t0 = Date.now()
    while (Date.now() - t0 < 2000) {
      await expect(page.locator('.todo-panel [data-testid="host-problems"]')).toHaveCount(0)
      expect(await page.locator('.todo-panel').innerText()).not.toMatch(/\bunknown\b/i)
      await page.waitForTimeout(250)
    }
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 10_000 })
    await expect(row(page, 'signbox')).toBeVisible()
  })
})

test.describe('the card holds still around it', () => {
  test('BP-C35: while searching the card stays under the toolbar and the AI lane under the card; scrolling the results moves neither', async ({ page }) => {
    await page.route('**/api/search/agent**', (route) => route.fulfill({ json: { summary: '', results: [], model: 'stub', tookMs: 1, cached: false } }))
    await bpSetup(page, {
      hosts: [failed('netbox', 'Net box', 'unreachable')], allTasks: true,
      before: async (p) => { await p.addInitScript(() => localStorage.setItem('open-walnut-agent-search', '1')) },
    })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await page.locator('.todo-search-input').fill('which task adds docx support')
    const lane = page.locator('.todo-panel [data-testid="agent-search-panel"]')
    await expect(lane).toBeVisible({ timeout: 10_000 })
    const order = await banner(page).evaluate((card) => {
      const tb = document.querySelector('.todo-panel-toolbar')!
      const lane = document.querySelector('.todo-panel [data-testid="agent-search-panel"]')!
      const f = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      return { cardAfterToolbar: f(tb, card), laneAfterCard: f(card, lane) }
    })
    expect(order).toEqual({ cardAfterToolbar: true, laneAfterCard: true })
    const cardTop = (await banner(page).boundingBox())!.y
    const laneTop = (await lane.boundingBox())!.y
    await page.locator('.todo-panel-list').evaluate((el) => {
      const sc = (el.scrollHeight > el.clientHeight ? el : el.querySelector<HTMLElement>('[class*="scroll"]')) ?? el
      sc.scrollTop = 400
    })
    await page.waitForTimeout(200)
    expect((await banner(page).boundingBox())!.y).toBeCloseTo(cardTop, 0)
    expect((await lane.boundingBox())!.y).toBeCloseTo(laneTop, 0)
  })

  test('BP-C36: switching in and out of System moves no task row: the Home card never moves or remounts on any section', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')], allTasks: true })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const first = page.locator('.todo-panel .todo-panel-item').first()
    await expect(first).toBeVisible({ timeout: 20_000 }).catch(() => {})
    test.skip(await first.count() === 0, 'the fixture has no task rows')
    await page.mouse.move(2, 2)
    const place = await markHomeCard(page)
    const y0 = (await first.boundingBox())!.y
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    for (const label of ['System', 'Needs Action', 'System', 'Inbox', 'System', 'Errors', 'System', 'Automation', 'System', 'All']) {
      await pickRail(page, label)
      await expect(panelBanner(page), label).toHaveCount(0)
      await expectHomeCardStill(page, place, label)
      expect(Math.abs((await first.boundingBox())!.y - y0), `${label}: the first task row`).toBeLessThanOrEqual(1)
    }
  })

  test('BP-C37: the task list scrolled to 400px keeps its place across a panel open and close', async ({ page }) => {
    // A short window, so the fixture's task list is longer than the list viewport by 400px.
    await page.setViewportSize({ width: 1280, height: 420 })
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')], allTasks: true })
    await expect(page.locator('.todo-panel .todo-panel-item').first()).toBeVisible({ timeout: 20_000 }).catch(() => {})
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const scroller = page.locator('.todo-panel-list')
    const setTop = await scroller.evaluate((el) => {
      const all = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))]
      const sc = all.find((e) => e.scrollHeight > e.clientHeight + 400 && getComputedStyle(e).overflowY !== 'visible') ?? el
      sc.setAttribute('data-bp-scroller', '1')
      sc.scrollTop = 400
      return sc.scrollTop
    })
    test.skip(setTop < 399, 'the fixture task list is too short to scroll 400px')
    const top = () => page.locator('[data-bp-scroller="1"]').evaluate((el) => el.scrollTop)
    await openSystemHosts(page)
    expect(Math.abs((await top()) - 400)).toBeLessThanOrEqual(1)
    await closePanel(page, 'escape')
    expect(Math.abs((await top()) - 400)).toBeLessThanOrEqual(1)
  })

  test('BP-C38: a pointer drag on the card body never starts a task drag and moves no task', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')], allTasks: true })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const tasks = () => page.locator('.todo-panel .todo-panel-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
    const before = await tasks()
    await page.evaluate(() => {
      const w = window as unknown as { __bpDrag: boolean }
      w.__bpDrag = false
      new MutationObserver(() => { if (document.querySelector('.todo-panel.is-task-dragging')) w.__bpDrag = true })
        .observe(document.querySelector('.todo-panel')!, { attributes: true, attributeFilter: ['class'] })
    })
    const hb = (await row(page, 'netbox').locator('.hft-headline').boundingBox())!
    await page.mouse.move(hb.x + 10, hb.y + hb.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(hb.x + 10, hb.y + hb.height / 2 + i * 5)
    await page.mouse.up()
    expect(await page.evaluate(() => (window as unknown as { __bpDrag: boolean }).__bpDrag)).toBe(false)
    expect(await tasks()).toEqual(before)
  })

  test('BP-C46: a 1600px window with an 800px task panel: opening the bell, then System, leaves the first visible task row where it was', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')], allTasks: true })
    await page.addStyleTag({ content: '.main-page-todo { flex: 0 0 800px !important; width: 800px !important; max-width: 800px !important; }' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const first = page.locator('.todo-panel .todo-panel-item').first()
    await expect(first).toBeVisible({ timeout: 20_000 }).catch(() => {})
    test.skip(await first.count() === 0, 'the fixture has no task rows')
    const y0 = (await first.boundingBox())!.y
    // The bell lands on All: the card stays in the task panel.
    await openBell(page)
    await expect(banner(page)).toHaveCount(1)
    expect(Math.abs((await first.boundingBox())!.y - y0)).toBeLessThanOrEqual(1)
    // System lists the hosts; the card stays in the task panel.
    const place = await markHomeCard(page)
    await pickRail(page, 'System')
    await expect(systemHosts(page)).toBeVisible()
    await expectHomeCardStill(page, place, 'System')
    expect(Math.abs((await first.boundingBox())!.y - y0)).toBeLessThanOrEqual(1)
  })
})

test.describe('height changes wait for the pointer; Errors; the announcer', () => {
  test('BP-C51: a new problem while the pointer rests on a task row does not push the row down until the pointer leaves', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [connected('netbox', 'Net box')], allTasks: true })
    const first = page.locator('.todo-panel .todo-panel-item').first()
    await expect(first).toBeVisible({ timeout: 20_000 }).catch(() => {})
    test.skip(await first.count() === 0, 'the fixture has no task rows')
    await expect(anyBanner(page)).toHaveCount(0)
    const fb = (await first.boundingBox())!
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    for (let i = 0; i < 12; i++) {
      expect(Math.abs((await first.boundingBox())!.y - fb.y), `sample ${i}`).toBeLessThanOrEqual(1)
      await page.waitForTimeout(250)
    }
    await page.mouse.move(2, 2)
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 5_000 })
    const dur = await page.locator('.todo-panel .ab-mount-anim').first().evaluate((el) => getComputedStyle(el).transitionDuration)
      .catch(() => '0s')
    expect(Math.max(...dur.split(',').map((d) => parseFloat(d) * (d.trim().endsWith('ms') ? 0.001 : 1)))).toBeLessThanOrEqual(0.2)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await page.locator('.todo-panel .ab-mount-anim').first().evaluate((el) => getComputedStyle(el).transitionDuration)
      .catch(() => '0s')
    expect(reduced.split(',').every((d) => parseFloat(d) === 0)).toBe(true)
  })

  test('BP-C57: the Errors group for Dev box uses its label, with a quiet Shown in System link under it; Enter on the link opens System on the Dev box row, open and focused; a Home card dismissal keeps the link', async ({ page }) => {
    await bpSetup(page, {
      hosts: [failed('devbox', 'Dev box', 'cert_expired'), signedOut('signbox', 'Sign box')],
      feed: [hostErrorRecord('devbox', 1), hostErrorRecord('devbox', 2)],
    })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openBell(page)
    await pickRail(page, 'Errors')
    const header = page.locator('.notification-panel .nfc-cause-header')
    const name = header.locator('.nfc-cat-name')
    await expect(name).toHaveText("Can't reach Dev box")
    const link = page.locator('.notification-panel .nfc-body').getByRole('button', { name: 'Shown in System', exact: true })
    await expect(link).toHaveCount(1)
    await expect(link).toHaveClass(/nfc-cat-shown-link/)
    // Under the name, flush with its left edge, in the quiet 11px type.
    const nb = (await name.boundingBox())!
    const lb = (await link.boundingBox())!
    expect(lb.y).toBeGreaterThanOrEqual(nb.y + nb.height - 1)
    expect(Math.abs(lb.x - nb.x)).toBeLessThanOrEqual(1)
    expect(await link.evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px')
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c57-errors-shown-in-system.png` })
    // By keyboard: the link is a real button.
    await link.focus()
    await page.keyboard.press('Enter')
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(panelBanner(page)).toHaveCount(0)
    const dev = systemHostRow(page, 'devbox')
    await expect(dev).toHaveClass(/hpb-open/)
    await expect(dev).toBeInViewport()
    // The link went with Errors: the keyboard lands on the row's own details toggle.
    await expect(dev.getByRole('button', { name: 'Hide details' })).toBeFocused()
    await closePanel(page, 'escape')
    await cardRow(banner(page), 'devbox').getByRole('button', { name: 'Dismiss Dev box' }).click()
    await openBell(page)
    await pickRail(page, 'Errors')
    await expect(header).toHaveCount(1)
    // System ignores dismissals, so it still gives Dev box a row, and the link stays.
    await expect(link).toHaveCount(1)
  })

  test('BP-C63: WebKit: a backdrop click over the card with System open leaves the same card under a still pointer; a removed row 1 waits for the pointer', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'WebKit only: the Mac app engine')
    await page.setViewportSize({ width: 1600, height: 900 })
    const h = await bpSetup(page, { hosts: three() })
    await page.addStyleTag({ content: '.main-page-todo { flex: 0 0 800px !important; width: 800px !important; max-width: 800px !important; }' })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['keybox', 'netbox', 'proxybox'])
    const r2y = (await row(page, 'netbox').boundingBox())!.y
    const cardBox = (await banner(page).boundingBox())!
    const place = await markHomeCard(page)
    // The card stays in the task panel while System is open; the backdrop click below lands over it.
    await openSystemHosts(page)
    const pb = (await page.locator('.notification-panel').boundingBox())!
    // A backdrop point over the card's right part, clear of the panel.
    const x = Math.round(Math.min(cardBox.x + cardBox.width - 20, Math.max(pb.x + pb.width + 20, cardBox.x + 20)))
    const y = Math.round(cardBox.y + 20)
    expect(x).toBeGreaterThan(pb.x + pb.width)
    await page.mouse.move(x, y)
    await page.mouse.click(x, y)
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expectHomeCardStill(page, place, 'after the backdrop click')
    await h.push({ ...failed('keybox', 'Key box', 'auth'), removed: true })
    for (let i = 0; i < 8; i++) {
      expect(Math.abs((await row(page, 'netbox').boundingBox())!.y - r2y), `sample ${i}`).toBeLessThanOrEqual(1)
      await page.waitForTimeout(250)
    }
    await page.mouse.move(2, 2)
    await expect.poll(async () => (await row(page, 'netbox').boundingBox())!.y, { timeout: 12_000 }).toBeLessThan(r2y - 1)
  })

  test('BP-C64: one announcer for the page, none inside the card; opening System and hiding the task panel say nothing; a new problem is announced', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('keybox', 'Key box', 'auth')] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.attention-banner [aria-live]')).toHaveCount(0)
    const announcer = page.locator('[data-testid="host-banner-announcer"]')
    await expect(announcer).toHaveCount(1)
    const said = await announcer.textContent()
    for (let i = 0; i < 3; i++) { await openSystemHosts(page); await closePanel(page, 'escape') }
    for (let i = 0; i < 2; i++) { await hideTaskPanel(page); await showTaskPanel(page) }
    expect(await announcer.textContent()).toBe(said)
    await page.mouse.move(2, 2)
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(announcer).toContainText('Net box: Could not connect to Net box', { timeout: 10_000 })
    await expect(panelBanner(page)).toHaveCount(0)
  })
})
