/**
 * The card and the System host list by keyboard (slice spec 5.1 to 5.3): where
 * Tab enters and leaves (in the notification panel: the header, then the
 * rail, then the System section: the Claude Code card when it shows, then the
 * first problem row), where focus goes when the last row folds away, that
 * Escape still closes the panel, and that no two dismiss controls sit close.
 * Host frames and local health are routed client-side.
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-keyboard --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-keyboard --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { banner, failed, resetServerHostFixture, row, signedOut } from './host-problems-helpers'
import { panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, boxGap, bpSetup, openSystemHosts, railButton, systemHostRow, systemHosts, systemLocalCard, toolbarHide,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
/** The first and last keyboard stops inside a card. */
const stops = (card: Locator) => card.evaluate((el, sel) => {
  const f = Array.from(el.querySelectorAll<HTMLElement>(sel)).filter((e) => e.offsetParent !== null)
  const name = (e: HTMLElement | undefined) => e ? (e.getAttribute('aria-label') ?? e.textContent ?? '').trim() : null
  return { first: name(f[0]), last: name(f[f.length - 1]), count: f.length }
}, FOCUSABLE)
const activeIn = (page: Page, selector: string) => page.evaluate((sel) => !!document.activeElement?.closest(sel), selector)
const activeName = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  return a ? (a.getAttribute('aria-label') ?? a.textContent ?? '').trim() : null
})
/** Controls focus must never fall onto when the card goes: the tier +, filter chips, AI lane buttons. */
const FORBIDDEN = '.todo-group-action-btn-plus, [class*="filter-chip"], [data-testid="agent-search-panel"] button'

test.describe('Tab order around the task panel card', () => {
  test('BP-C24: from Hide task panel Tab enters the card; Dismiss all is its last stop; Tab then leaves forward into the task panel', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth'), signedOut('signbox', 'Sign box')], local: 'sign-in' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const s = await stops(banner(page))
    expect(s.last).toBe('Dismiss all')
    await toolbarHide(page).focus()
    await page.keyboard.press('Tab')
    expect(await activeIn(page, '[data-testid="attention-banner"][data-mount="tasks"]')).toBe(true)
    expect(await activeName(page)).toBe(s.first)
    await banner(page).getByRole('button', { name: 'Dismiss all' }).focus()
    await page.keyboard.press('Tab')
    const where = await page.evaluate(() => {
      const a = document.activeElement
      return {
        body: a === document.body, inCard: !!a?.closest('[data-testid="attention-banner"]'),
        inToolbar: !!a?.closest('.todo-panel-toolbar'), inPanel: !!a?.closest('.todo-panel'),
      }
    })
    expect(where).toEqual({ body: false, inCard: false, inToolbar: false, inPanel: true })
  })

  test('BP-C25: in the panel Tab goes Close, then the rail from Needs Action to All, then System\'s Claude Code card, then the first problem row\'s control', async ({ page, browserName }) => {
    // WebKit on macOS moves Tab through every button only with Option held (the Safari default).
    const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')], local: 'sign-in' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openSystemHosts(page)
    const local = await stops(systemLocalCard(page))
    expect(local.count, 'the Claude Code card has controls').toBeGreaterThan(0)
    await page.locator('.notification-panel .notification-panel-close').focus()
    await page.keyboard.press(TAB)
    // No card between the header and the rail any more: Close hands over to the first rail entry.
    await expect(railButton(page, 'Needs Action')).toBeFocused()
    const rail: string[] = []
    for (let i = 0; i < 12 && await activeIn(page, '.nfc-rail'); i++) {
      rail.push((await activeName(page)) ?? '')
      await page.keyboard.press(TAB)
    }
    expect(rail[0], JSON.stringify(rail)).toMatch(/^Needs Action/)
    expect(rail[rail.length - 1], JSON.stringify(rail)).toMatch(/^All/)
    expect(rail.some((r) => /^System/.test(r)), JSON.stringify(rail)).toBe(true)
    // The section's first block: this machine's Claude Code notice, whole, before the hosts.
    const now = await activeName(page)
    expect(await activeIn(page, '[data-testid="nfc-local-claude"]'), `after All focus is on: ${now}`).toBe(true)
    expect(now).toBe(local.first)
    for (let i = 0; i < local.count + 2 && await activeIn(page, '[data-testid="nfc-local-claude"]'); i++) await page.keyboard.press(TAB)
    // Then the host list, in its order: Net box's Retry, the first problem row's first control.
    await expect(systemHostRow(page, 'netbox').getByTestId('hpb-retry')).toBeFocused()
  })
})

test.describe('where focus goes when the card folds away', () => {
  /** Enter on the only row's x, wait for the undo row to fold, and report where focus is. */
  async function dismissLastByKeyboard(page: Page): Promise<void> {
    const x = row(page, 'signbox').getByRole('button', { name: 'Dismiss Sign box' })
    await x.focus()
    await page.keyboard.press('Enter')
    await expect(banner(page).getByRole('button', { name: 'Undo' })).toBeFocused()
    await expect(banner(page)).toHaveCount(0, { timeout: 12_000 })
  }
  const tasksState = (page: Page) => page.locator('.todo-panel .todo-panel-item').evaluateAll((els) =>
    els.map((e) => `${e.getAttribute('data-task-id')}|${e.className}`))

  test('BP-C26: tab bar shown: after the last undo row folds focus is on the selected section tab; Enter again changes nothing', async ({ page }) => {
    await bpSetup(page, {
      hosts: [signedOut('signbox', 'Sign box')], allTasks: true,
      before: async (p) => { await p.addInitScript(() => localStorage.setItem('walnut-todo-quick-views-visible', 'true')) },
    })
    await expect(row(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.todo-section-tabs-list')).toBeVisible()
    const before = await tasksState(page)
    await dismissLastByKeyboard(page)
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.todo-section-tabs-list [role="tab"][aria-selected="true"]') ?? false), { timeout: 3_000 }).toBe(true)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await expect(page.locator('[role="menu"]:visible')).toHaveCount(0)
    expect(await tasksState(page)).toEqual(before)
  })

  test('BP-C65: tab bar closed: focus lands on the mount itself, then Tab reaches the tier heading or the list; never the tier +, a chip or the AI lane', async ({ page }) => {
    await bpSetup(page, {
      hosts: [signedOut('signbox', 'Sign box')], allTasks: true,
      before: async (p) => { await p.addInitScript(() => localStorage.setItem('walnut-todo-quick-views-visible', 'false')) },
    })
    await expect(row(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.todo-section-tabs-list')).toHaveCount(0)
    await dismissLastByKeyboard(page)
    const focusDesc = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return el ? `${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')}` : 'none'
    })
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.todo-panel .ab-mount') ?? false), { timeout: 3_000, message: 'focus on .ab-mount' }).toBe(true)
      .catch(async (e) => { throw new Error(`${String(e)}; focused: ${await focusDesc()}`) })
    expect(await page.evaluate((sel) => !!document.activeElement?.closest(sel), FORBIDDEN)).toBe(false)
    await page.keyboard.press('Tab')
    const next = await page.evaluate((sel) => {
      const a = document.activeElement
      const desc = a ? `${a.tagName.toLowerCase()}.${(a.className || '').toString().split(' ').join('.')} ${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 40)}` : 'none'
      // The next stop after the card is the tier heading or the first list control (spec 5.2 Tab order).
      const inList = !!a?.closest('.todo-panel-list') || (!!a?.closest('.todo-panel') && !!a?.matches('[class*="navigation-heading"]'))
      return { inList, forbidden: !!a?.closest(sel), body: a === document.body, desc }
    }, FORBIDDEN)
    expect({ inList: next.inList, forbidden: next.forbidden, body: next.body }, `focused: ${next.desc}`).toEqual({ inList: true, forbidden: false, body: false })
  })

  test('BP-C27: clicks on a System row\'s headline, the Remote hosts label and the Claude Code card keep the panel open; Escape with focus in a row closes it', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')], local: 'sign-in' })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openSystemHosts(page)
    await systemHostRow(page, 'netbox').locator('.hft-headline').click()
    await systemHosts(page).locator('.notification-card-label').click()
    await systemLocalCard(page).locator('.notification-card-label').click()
    await expect(page.locator('.notification-panel')).toBeVisible()
    await systemHostRow(page, 'netbox').getByTestId('hpb-retry').focus()
    await page.keyboard.press('Escape')
    await expect(page.locator('.notification-panel')).toHaveCount(0)
  })
})

test.describe('dismiss controls stay apart', () => {
  test('BP-C53: on the Home card every x and Dismiss all are 24px apart and from Hide task panel; each x is titled with its name; System has no row x and no Dismiss all, and its Claude Code x keeps 24px from Close', async ({ page }) => {
    await bpSetup(page, {
      hosts: [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'), failed('proxybox', 'Proxy box', 'proxy'),
        failed('lanbox', 'Lan box', 'unreachable'), signedOut('signbox', 'Sign box')],
      local: 'sign-in',
    })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const check = async (card: Locator, neighbour: Locator, where: string) => {
      const xs = card.locator('.hpb-x:visible, .hpb-dismiss:visible, .ab-local-x:visible, .ab-dismiss-all:visible')
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = []
      for (const x of await xs.all()) boxes.push((await x.boundingBox())!)
      expect(boxes.length, where).toBeGreaterThanOrEqual(5)
      const n = (await neighbour.boundingBox())!
      for (let i = 0; i < boxes.length; i++) {
        expect(boxGap(boxes[i], n), `${where}: control ${i} vs neighbour`).toBeGreaterThanOrEqual(24)
        for (let j = i + 1; j < boxes.length; j++) expect(boxGap(boxes[i], boxes[j]), `${where}: ${i} vs ${j}`).toBeGreaterThanOrEqual(24)
      }
      for (const x of await card.locator('.hpb-x:visible, .hpb-dismiss:visible, .ab-local-x:visible').all()) {
        expect(await x.getAttribute('title')).toBe(await x.getAttribute('aria-label'))
      }
      const all = card.locator('.ab-dismiss-all')
      await expect(all).toBeVisible()
      await expect(all).toHaveText('Dismiss all')
      expect(await card.evaluate((el) => {
        const more = el.querySelector('.hpb-more'); const all = el.querySelector('.ab-dismiss-all')
        return !!more && !!all && !!(more.compareDocumentPosition(all) & Node.DOCUMENT_POSITION_FOLLOWING)
      })).toBe(true)
    }
    await check(banner(page), toolbarHide(page), 'tasks')
    await openSystemHosts(page)
    const panel = page.locator('.notification-panel')
    await expect(panelBanner(page)).toHaveCount(0)
    await expect(panel.locator('.hpb-x, .hpb-dismiss, .ab-dismiss-all')).toHaveCount(0)
    const localX = systemLocalCard(page).locator('.ab-local-x')
    await expect(localX).toBeVisible()
    expect(await localX.getAttribute('title')).toBe(await localX.getAttribute('aria-label'))
    const close = (await panel.locator('.notification-panel-close').boundingBox())!
    expect(boxGap((await localX.boundingBox())!, close)).toBeGreaterThanOrEqual(24)
    await panel.screenshot({ path: `${BP_SHOTS}/c53-panel-controls.png` })
  })
})
