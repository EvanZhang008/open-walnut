/**
 * The notification panel's host problems by keyboard and pointer: the panel is
 * a dialog on every section (header, then the rail, then the section); in All
 * the problems block comes first (the Claude Code notice when it shows, then
 * the first problem row), then the feed; in System the first problem row;
 * Tab never leaves the panel and Escape returns to the bell; clicks on a row's
 * text or a block label keep the panel open.
 * Host frames and local health are routed client-side.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { failed, resetServerHostFixture, signedOut } from './host-problems-helpers'
import { bell } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, bpSetup, fixtureHosts, hostErrorRecord, openProblems, panelLocalCard, pickRail, problemHosts, problemRow, problemRowHosts,
  railButton, systemHostRow, systemHosts,
} from './host-attention-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })

// WebKit on macOS moves Tab through every button only with Option held (the Safari default).
const TAB = (browserName: string): string => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
const where = (page: Page): Promise<string> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  const inPanel = !!a?.closest('.notification-panel')
  return `${inPanel ? 'panel' : 'out'}:${a?.getAttribute('aria-label') || (a?.textContent ?? '').trim().slice(0, 24) || a?.tagName}`
})
const activeIn = (page: Page, selector: string) => page.evaluate((sel) => !!document.activeElement?.closest(sel), selector)
const activeName = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  return a ? (a.getAttribute('aria-label') ?? a.textContent ?? '').trim() : null
})
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
/** The first keyboard stop inside a block and how many it has. */
const stops = (block: Locator) => block.evaluate((el, sel) => {
  const f = Array.from(el.querySelectorAll<HTMLElement>(sel)).filter((e) => e.offsetParent !== null)
  return { first: f[0] ? (f[0].getAttribute('aria-label') ?? f[0].textContent ?? '').trim() : null, count: f.length }
}, FOCUSABLE)

test.describe('the panel is a dialog for the keyboard', () => {
  test('NK-1: Enter on the bell moves focus into the panel (All); Tab goes header, then the rail; Enter on System, then Tab past All reaches the first problem row and Shift+Tab goes back; Tab never leaves the panel; Escape returns to the bell', async ({ page, browserName }) => {
    await bpSetup(page, { hosts: fixtureHosts() })
    await bell(page).focus()
    await page.keyboard.press('Enter')
    const panel = page.locator('.notification-panel')
    await expect(panel).toHaveAttribute('role', 'dialog')
    await expect(panel).toHaveAttribute('aria-modal', 'true')
    await expect(panel).toHaveAttribute('aria-label', 'Notifications')
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    await expect.poll(() => where(page)).toMatch(/^panel:/)
    const seen: string[] = []
    for (let i = 0; i < 6; i++) { await page.keyboard.press(TAB(browserName)); seen.push(await where(page)) }
    // Header first (Clear All when the feed has items, Quiet, Close), then the rail from its first entry.
    expect(seen.every((s) => s.startsWith('panel:')), JSON.stringify(seen)).toBe(true)
    const close = seen.indexOf('panel:Close')
    expect(close, JSON.stringify(seen)).toBeGreaterThanOrEqual(0)
    expect(seen[close + 1], JSON.stringify(seen)).toMatch(/^panel:Needs you/)
    for (let i = 0; i < 12 && !(await where(page)).startsWith('panel:System'); i++) await page.keyboard.press(TAB(browserName))
    await expect(railButton(page, 'System')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(systemHosts(page).locator('li.hpb-row')).toHaveCount(4, { timeout: 10_000 })
    await page.keyboard.press(TAB(browserName))
    expect(await where(page)).toMatch(/^panel:All/)
    // Settings order: Dev box and Build box are plain lines; Sign box is the first row (Check again).
    await page.keyboard.press(TAB(browserName))
    await expect(systemHostRow(page, 'signbox').getByTestId('hpb-check')).toBeFocused()
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab')
    await expect(railButton(page, 'All')).toBeFocused()
    // Around the end and back: Tab never lands under the overlay.
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press(TAB(browserName))
      expect(await where(page)).toMatch(/^panel:/)
    }
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('sidebar-notification-btn'))).toBe(true)
  })

  test('NK-2: in All, Tab goes Close, then the rail from Needs Action to All, then the Claude Code notice, then the first problem row\'s control, and past the problems onto the feed', async ({ page, browserName }) => {
    await bpSetup(page, {
      // dns: a kind the person must clear, so Net box has a row in All (an unreachable host would not).
      hosts: [failed('netbox', 'Net box', 'dns'), signedOut('signbox', 'Sign box')], local: 'sign-in',
      feed: [hostErrorRecord('devbox', 1)],
    })
    await openProblems(page)
    const local = await stops(panelLocalCard(page))
    expect(local.count, 'the Claude Code notice has controls').toBeGreaterThan(0)
    const item = page.locator('.notification-panel .notification-feed-item').first()
    await expect(item).toBeVisible({ timeout: 10_000 })
    // Dev box has no problem row, so its error is a feed card of its own, not under a row.
    expect(await item.evaluate((el) => !el.closest('[data-testid="nfc-problems"]'))).toBe(true)
    await page.locator('.notification-panel .notification-panel-close').focus()
    await page.keyboard.press(TAB(browserName))
    await expect(railButton(page, 'Needs you')).toBeFocused()
    const rail: string[] = []
    for (let i = 0; i < 12 && await activeIn(page, '.nfc-rail'); i++) {
      rail.push((await activeName(page)) ?? '')
      await page.keyboard.press(TAB(browserName))
    }
    expect(rail[0], JSON.stringify(rail)).toMatch(/^Needs you/)
    expect(rail[rail.length - 1], JSON.stringify(rail)).toMatch(/^All/)
    expect(rail.some((r) => /^System/.test(r)), JSON.stringify(rail)).toBe(true)
    // The section's first block: this machine's Claude Code notice, whole, before the hosts.
    expect(await activeIn(page, '[data-testid="nfc-local-claude"]'), `after All focus is on: ${await activeName(page)}`).toBe(true)
    expect(await activeName(page)).toBe(local.first)
    for (let i = 0; i < local.count + 2 && await activeIn(page, '[data-testid="nfc-local-claude"]'); i++) await page.keyboard.press(TAB(browserName))
    await expect(problemRow(page, 'netbox').getByTestId('hpb-retry')).toBeFocused()
    for (let i = 0; i < 40 && await activeIn(page, '[data-testid="nfc-problems"]'); i++) await page.keyboard.press(TAB(browserName))
    await expect(item).toBeFocused()
  })

  test('NK-3: the dialog holds on every section, with host rows (All, System) or without them (Needs Action); plain Tab walks the rail buttons, WebKit included', async ({ page }) => {
    await bpSetup(page)
    await openProblems(page)
    const panel = page.locator('.notification-panel')
    // All lists the person's three; System lists Net box (unreachable, Walnut Health's) too.
    await expect(problemHosts(page).locator('li.hpb-row')).toHaveCount(FIXTURE_ORDER.length)
    for (const label of ['All', 'System', 'Needs you'] as const) {
      if (label !== 'All') await pickRail(page, label)
      if (label === 'System') await expect(systemHosts(page).locator('li.hpb-row')).toHaveCount(4)
      if (label === 'Needs you') await expect(panel.locator('li.hpb-row')).toHaveCount(0)
      await expect(panel, label).toHaveAttribute('role', 'dialog')
      await expect(panel, label).toHaveAttribute('aria-modal', 'true')
      await railButton(page, 'Needs you').focus()
      // Plain Tab (the Mac app's own key, no Alt): the next rail button, not past the rail.
      await page.keyboard.press('Tab')
      await expect(railButton(page, 'Inbox'), label).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(railButton(page, 'Needs you'), label).toBeFocused()
    }
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})

test.describe('clicks inside the panel', () => {
  test('NK-4: clicks on a problem row\'s headline, the Remote hosts labels and the Claude Code notice (All), and on a System row keep the panel open; Escape with focus in a row closes it', async ({ page }) => {
    // dns: the person's to clear, so the row is in All as well as System.
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'dns')], local: 'sign-in' })
    await openProblems(page)
    await problemRow(page, 'netbox').locator('.hft-headline').click()
    // The problems block's cards are notice cards: their titles are .wn-notice-who.
    await problemHosts(page).locator('.wn-notice-who').first().click()
    await panelLocalCard(page).locator('.wn-notice-who').first().click()
    await expect(page.locator('.notification-panel')).toBeVisible()
    await pickRail(page, 'System')
    await systemHostRow(page, 'netbox').locator('.hft-headline').click()
    await systemHosts(page).locator('.notification-card-label').click()
    await expect(page.locator('.notification-panel')).toBeVisible()
    await systemHostRow(page, 'netbox').getByTestId('hpb-retry').focus()
    expect(await activeIn(page, '.notification-panel li.hpb-row[data-host="netbox"]')).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator('.notification-panel')).toHaveCount(0)
  })
})
