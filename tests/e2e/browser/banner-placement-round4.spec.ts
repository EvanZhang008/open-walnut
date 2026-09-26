/**
 * The attention card, fixer round 4 (nitpick round 3, BP-R4-N3-<n>, and the
 * verifier's C22 / C42 items). Host frames and local health are routed
 * client-side (host-problems-helpers.ts); nothing dials a real host.
 *
 * Run: PW_TEST_PORT=35962 PW_IGNORE_LOAD=1 ./node_modules/.bin/playwright test banner-placement-round4 --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35962 PW_IGNORE_LOAD=1 ./node_modules/.bin/playwright test banner-placement-round4 --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { banner, connected, failed, isolatePrefs, resetServerHostFixture, routeHealth, row, signedOut } from './host-problems-helpers'
import { loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, bellDot, bpSetup, cardRow, openPanelCard, openRow, railButton, settingsDot, toolbarHide,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })
test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

const box = async (l: Locator) => (await l.boundingBox())!
const dismissed = (page: Page): Promise<string[]> => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('open-walnut-host-banner-dismissed') ?? '[]') } catch { return [] }
})

test.describe('undo lines (N3-1, N3-12, N3-13)', () => {
  test('BP-R4-N3-1: a row hidden in the panel keeps its height in the task panel card; the pointer coming back moves nothing; Dismiss all dismisses', async ({ page }) => {
    await bpSetup(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const card = await openPanelCard(page)
    const rowH = (await box(cardRow(card, 'certbox'))).height
    await card.getByRole('button', { name: 'Dismiss Cert box' }).click()
    await page.waitForTimeout(450)
    await page.locator('.notification-panel-close').click()
    await expect(panelBanner(page)).toHaveCount(0)
    const undo = banner(page).getByTestId('hpb-undo-row')
    await expect(undo).toHaveCount(1)
    await expect(undo).toContainText('Cert box hidden until it changes.')
    expect(Math.abs((await box(undo)).height - rowH)).toBeLessThanOrEqual(1)
    const all = banner(page).getByRole('button', { name: 'Dismiss all' })
    const before = await box(all)
    await page.mouse.move(before.x + 20, before.y + before.height / 2)
    await page.waitForTimeout(400)
    const after = await box(all)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    expect(Math.abs((await box(undo)).height - rowH)).toBeLessThanOrEqual(1)
    await page.mouse.down(); await page.mouse.up()
    // f15: the click used to land on Check again, leaving only certbox dismissed.
    await expect.poll(async () => {
      const keys = await dismissed(page)
      return ['keybox|connect', 'certbox|connect', 'netbox|connect'].every((k) => keys.includes(k)) && keys.some((k) => k.startsWith('signbox|'))
    }).toBe(true)
  })

  test('BP-R4-N3-12/13: Dismiss all holds the card height until the line collapses; the title stops saying "need attention"; the line counts the hosts', async ({ page }) => {
    await bpSetup(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    const h0 = (await box(banner(page))).height
    await banner(page).getByRole('button', { name: 'Dismiss all' }).click()
    const line = banner(page).getByTestId('hpb-undo-row')
    await expect(line).toHaveText(/4 hosts hidden until they change\./)
    await expect(banner(page).locator('.hpb .setup-banner-title')).toHaveText('Remote hosts')
    await page.waitForTimeout(300)
    expect(Math.abs((await box(banner(page))).height - h0)).toBeLessThanOrEqual(1)
    const lineBox = await box(line)
    const text = await box(line.locator('.hpb-undo-text'))
    // The words sit in the middle of the held space, not at its top (N3-13).
    expect(Math.abs((text.y + text.height / 2) - (lineBox.y + lineBox.height / 2))).toBeLessThanOrEqual(2)
    await page.mouse.move(700, 400)
    await expect(banner(page)).toHaveCount(0, { timeout: 12_000 })
  })
})

test.describe('landing and the cap (N3-2, N3-3, N3-18, N3-21)', () => {
  test('BP-R4-N3-2: Open Settings lands the host row in the upper part of the pane, stays there, and takes focus', async ({ page, request }) => {
    // The server fixture: Settings lists these hosts from the config (routed frames alone have no Settings row).
    await isolatePrefs(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(row(page, 'certbox')).toBeVisible({ timeout: 20_000 })
    await openRow(row(page, 'certbox'))
    await row(page, 'certbox').getByRole('button', { name: 'Open Settings' }).click()
    await expect(page).toHaveURL(/\/settings#rh-host-certbox$/)
    const target = page.locator('#rh-host-certbox')
    await expect(target).toBeVisible({ timeout: 10_000 })
    const vh = page.viewportSize()!.height
    for (const wait of [600, 1500, 2500]) {
      await page.waitForTimeout(wait === 600 ? 600 : wait - 600)
      const b = await box(target)
      expect(b.y, `row top at ${wait}ms`).toBeLessThanOrEqual(vh / 3)
      expect(b.y + Math.min(b.height, 160)).toBeLessThanOrEqual(vh)
    }
    // A section above arriving late (seconds in, on a busy machine) pushes the row down; the landing still holds it.
    await target.evaluate((el) => {
      let sc: HTMLElement | null = el.parentElement
      while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement
      const first = (sc ?? document.body).firstElementChild as HTMLElement
      first.dataset.lateLayout = '1'
      first.style.paddingTop = '400px'
    })
    await page.waitForTimeout(500)
    const late = await box(target)
    expect(late.y, 'row top after a late section above').toBeLessThanOrEqual(vh / 3)
    await page.locator('[data-late-layout]').evaluate((el) => { (el as HTMLElement).style.paddingTop = '' })
    await expect(target).toBeFocused()
  })

  test('BP-R4-N3-3: 980x600, the local sign-in and four hosts: the whole card within max(40%, 132px); one-line rows; the local section whole', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.setViewportSize({ width: 980, height: 600 })
    await bpSetup(page, { local: 'sign-in' })
    await expect(banner(page).locator('li.hpb-row').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(800)
    const panelH = (await box(page.locator('.todo-panel'))).height
    const card = await box(banner(page))
    expect(card.height).toBeLessThanOrEqual(Math.max(panelH * 0.4, 132) + 1)
    await expect(banner(page)).toHaveClass(/\bab-fit\b/)
    const first = await box(banner(page).locator('li.hpb-row').first())
    expect(first.height).toBeLessThanOrEqual(30)
    await expect(banner(page).getByTestId('setup-banner-check')).toBeVisible()
    await expect(banner(page).getByTestId('hpb-below')).toBeVisible()
    await banner(page).screenshot({ path: `${BP_SHOTS}/r4-n3-3-980x600.png` })
    // N3-21: the Mac app engine throws nothing while the card lays out.
    expect(errors).toEqual([])
  })

  test('BP-R4-N3-18: 1280x800, local sign-in and hosts: the visible list ends on a whole row', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expect(banner(page).locator('li.hpb-row').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(800)
    const cut = await banner(page).locator('.hpb-scroll').evaluate((sc) => {
      const b = sc.getBoundingClientRect()
      return Array.from(sc.querySelectorAll('li')).filter((li) => {
        const r = li.getBoundingClientRect()
        return r.top < b.bottom - 1 && r.bottom > b.bottom + 1
      }).length
    })
    expect(cut).toBe(0)
  })
})

test.describe('C22 in the panel with the pointer resting in it', () => {
  test('BP-R4-C22: the success line replaces the row at once and never shows the old failure again', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    h.connectDelayMs = 1500
    h.connectAnswer = (host) => connected(host, 'Net box')
    const card = await openPanelCard(page)
    await cardRow(card, 'netbox').getByTestId('hpb-retry').click()
    // The pointer rests in the panel body, below the card (the layout hold is on).
    const body = await box(page.locator('.notification-panel .nfc-body'))
    await page.mouse.move(body.x + body.width / 2, body.y + body.height - 40, { steps: 4 })
    const net = card.locator('li.hpb-row[data-host="netbox"]')
    await expect(net).toContainText('Net box is ready', { timeout: 10_000 })
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(700)
      const text = await net.count() ? await net.innerText() : ''
      expect(text).not.toContain('Could not connect')
    }
  })
})

test.describe('row polish (N3-5, N3-6, N3-7, N3-16, N3-17, N3-19)', () => {
  test('BP-R4-N3-5/6/16/17: whole headlines on two lines, Show details centred on its button, one count format, x in one column, named action groups', async ({ page, request }) => {
    // 1280x800 (the report's size; at the default 720 the card takes its fitted form) and the
    // server fixture (its rows carry hints, so Show details exists).
    await page.setViewportSize({ width: 1280, height: 800 })
    await isolatePrefs(page)
    await routeHealth(page, 'sign-in')
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(banner(page).locator('li.hpb-row').first()).toBeVisible({ timeout: 20_000 })
    const clipped = await banner(page).locator('li.hpb-row .hft-headline').evaluateAll((hs) => hs
      .filter((h) => h.getBoundingClientRect().height > 0)
      .filter((h) => h.scrollHeight > h.clientHeight + 1 || h.scrollWidth > h.clientWidth + 1).map((h) => h.textContent))
    expect(clipped, 'the cause at the end of each headline shows').toEqual([])
    const cert = banner(page).locator('li.hpb-row', { has: page.getByRole('button', { name: 'Show details' }) }).first()
    const retry = await box(cert.locator('.hpb-actions .hpb-btn').first())
    const details = await box(cert.getByRole('button', { name: 'Show details' }))
    expect(Math.abs((retry.y + retry.height / 2) - (details.y + details.height / 2))).toBeLessThanOrEqual(1.5)
    await expect(banner(page).locator('.hpb-subhead-row .hpb-count')).toHaveText(/^\(\d+\)$/)
    const localX = await box(banner(page).locator('.ab-local-x'))
    const hostX = await box(cert.locator('.hpb-x'))
    // A classic (always shown) scrollbar, as Playwright's WebKit draws, narrows the rows by its width.
    const bar = await banner(page).locator('.hpb-scroll').evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)
    expect(Math.abs((localX.x + localX.width) - (hostX.x + hostX.width))).toBeLessThanOrEqual(1 + bar)
    // Screen readers: the dot does not repeat the headline; the buttons sit in a group named for the host.
    await expect(cert.locator('.hpb-dot [role="img"]')).toHaveCount(0)
    const label = await cert.locator('.hpb-body').getAttribute('data-label')
    await expect(cert.getByRole('group', { name: label! })).toBeVisible()
  })

  test('BP-R4-N3-7/19: an opened row keeps the 24px buttons; a retry time long past (no attempt came) does not say Trying again', async ({ page }) => {
    // Seven minutes after its retryAt, with frames still arriving (f2): a stale promise.
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page, { hosts: [failed('keybox', 'Key box', 'auth'), failed('certbox', 'Cert box', 'cert_expired', { retryAt: Date.now() - 7 * 60_000 })] })
    await expect(row(page, 'certbox')).toBeVisible({ timeout: 20_000 })
    const closedH = (await box(row(page, 'keybox').getByTestId('hpb-retry'))).height
    await openRow(row(page, 'certbox'))
    const heights = await row(page, 'certbox').locator('.hpb-btn').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
    for (const h of heights) expect(Math.abs(h - closedH)).toBeLessThanOrEqual(1)
    await expect(row(page, 'certbox')).not.toContainText('Trying again')
    await expect(row(page, 'certbox')).not.toContainText('tries again')
  })
})

test.describe('narrow, phone, scrolled (N3-8, N3-9, N3-10, N3-11)', () => {
  test('BP-R4-N3-8/9: 980x600: after N more below, N more above; the scrollbar stays 8px clear of the x', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 600 })
    await bpSetup(page, { before: async (p) => { await p.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false')) } })
    await expect(banner(page).getByTestId('hpb-below')).toBeVisible({ timeout: 20_000 })
    const sc = await box(banner(page).locator('.hpb-scroll'))
    const x = await box(banner(page).locator('li.hpb-row .hpb-x').first())
    expect(sc.x + sc.width - (x.x + x.width)).toBeGreaterThanOrEqual(8)
    for (let i = 0; i < 4 && await banner(page).getByTestId('hpb-below').count(); i++) {
      await banner(page).getByTestId('hpb-below').click()
      await page.waitForTimeout(200)
    }
    await expect(banner(page).getByTestId('hpb-above')).toHaveText(/^\d+ more above$/)
  })

  test('BP-R4-N3-10: a task panel dragged to 10% of 980px: nothing wider than the card, one-line rows, within the cap', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { before: async (p) => { await p.addInitScript(() => localStorage.setItem('open-walnut-todo-width', '10')) } })
    await expect(banner(page).locator('li.hpb-row').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(600)
    const c = await banner(page).evaluate((el) => {
      const r = el.getBoundingClientRect()
      const wider = Array.from(el.querySelectorAll<HTMLElement>('.hpb-count, .setup-banner-title, .ab-dismiss-all')).filter((e) => e.getBoundingClientRect().right > r.right + 1).length
      return { wider, h: r.height, rowH: el.querySelector('li.hpb-row')!.getBoundingClientRect().height }
    })
    expect(c.wider).toBe(0)
    const panelH = (await box(page.locator('.todo-panel'))).height
    expect(c.h).toBeLessThanOrEqual(Math.max(panelH * 0.4, 132) + 1)
    expect(c.rowH).toBeLessThanOrEqual(64)
  })

  test('BP-R4-N3-11: phone 390x844: a one-line row puts its headline on its own line, the action under it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await bpSetup(page)
    await expect(banner(page).locator('li.hpb-row').first()).toBeVisible({ timeout: 20_000 })
    const r = banner(page).locator('li.hpb-row').first()
    const head = await box(r.locator('.hft-headline'))
    const act = await box(r.locator('.hpb-actions'))
    expect(act.y).toBeGreaterThanOrEqual(head.y + head.height - 1)
  })
})

test.describe('signals and the panel (N3-14, N3-15, N3-22, C42)', () => {
  test('BP-R4-N3-14: on /notes the bell dot and the Settings rail dot wear the same colour', async ({ page }) => {
    await bpSetup(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await page.getByTestId('sidebar-core-app-notes').click()
    await expect(settingsDot(page)).toBeVisible({ timeout: 10_000 })
    await expect(bellDot(page)).toHaveClass(/is-host-warn/)
    const colour = (l: Locator) => l.evaluate((e) => {
      const inner = e.querySelector<HTMLElement>('.hsd') ?? e
      return getComputedStyle(inner).backgroundColor
    })
    expect(await colour(bellDot(page))).toBe(await colour(settingsDot(page)))
  })

  test('BP-R4-N3-15: System pane: a failed connect reads in its red dot tone, a sign-in problem in warn, the outdated host stays quiet', async ({ page, request }) => {
    await isolatePrefs(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await openBell(page)
    await railButton(page, 'System').click()
    const status = (host: string) => page.locator(`.nfc-daemon-row[data-host="${host}"] .nfc-daemon-status`)
    await expect(status('certbox')).toHaveClass(/\berror\b/, { timeout: 20_000 })
    await expect(status('signbox')).toHaveClass(/\bwarn\b/)
    await expect(status('buildbox')).not.toHaveClass(/\b(warn|error)\b/)
    const [dot, text] = await page.locator('.nfc-daemon-row[data-host="certbox"]').evaluate((el) => [
      getComputedStyle(el.querySelector<HTMLElement>('.hsd')!).backgroundColor, getComputedStyle(el.querySelector<HTMLElement>('.nfc-daemon-status')!).color,
    ])
    expect(text).toBe(dot)
  })

  test('BP-R4-N3-22: with the task panel hidden, the slot card keeps its rows near their words (at most 720px)', async ({ page }) => {
    await bpSetup(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await toolbarHide(page).click()
    const slot = page.locator('[data-testid="attention-banner"][data-mount="slot"]')
    await expect(slot).toHaveCount(1, { timeout: 10_000 })
    expect((await box(slot)).width).toBeLessThanOrEqual(721)
  })

  test('BP-R4-C42: the panel is a dialog through the card mount (its own file untouched); Tab walks every rail button, WebKit included', async ({ page }) => {
    await bpSetup(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openPanelCard(page)
    const panel = page.locator('.notification-panel')
    await expect(panel).toHaveAttribute('role', 'dialog')
    await expect(panel).toHaveAttribute('aria-modal', 'true')
    await railButton(page, 'Needs Action').focus()
    // Plain Tab (the Mac app's own key, no Alt): the next rail button, not past the rail.
    await page.keyboard.press('Tab')
    await expect(railButton(page, 'Inbox')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(railButton(page, 'Needs Action')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  })
})
