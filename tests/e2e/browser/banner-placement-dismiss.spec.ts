/**
 * Dismiss in one place, hidden in every place (slice spec 2.1, 5.1, 7): the
 * task panel card and the notification panel card read one dismiss store;
 * a row x leaves an undo row; expiry runs without any card mounted; Settings
 * can bring a hidden row back.
 * Host frames and local health are routed client-side (BP-C55 uses the
 * server's host fixture, since Settings lists the server's hosts).
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-dismiss --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-dismiss --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  DISMISS_KEY, banner, connected, failed, isolatePrefs, loadHome, resetServerHostFixture, row, signedOut, storedKeys,
} from './host-problems-helpers'
import { bell, hostRow, loadApp, loadFixture, openBell, openRemoteHosts, panelBanner, tasksBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, bellDot, bpSetup, cardRow, closePanel, countInFirstFrameAfterClick, expectTasksCard, goRail, hostsOf,
  openPanelCard, railButton,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

test.describe('one dismiss store behind both cards', () => {
  test('BP-C9: a row x in the panel hides the row in the task panel too, is stored, and survives a reload', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const card = await openPanelCard(page)
    await cardRow(card, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(cardRow(card, 'netbox')).toHaveCount(0)
    await closePanel(page, 'escape')
    await expect(banner(page)).toHaveCount(1)
    await expect(row(page, 'netbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('netbox|connect')
    await page.evaluate(() => sessionStorage.setItem('hp-keep', '1'))
    await page.reload()
    await loadHome(page)
    await expect(row(page, 'keybox')).toBeVisible({ timeout: 20_000 })
    await expect(row(page, 'netbox')).toHaveCount(0)
  })

  test('BP-C10: a row x in the task panel is hidden in the panel card', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await row(page, 'certbox').getByRole('button', { name: 'Dismiss Cert box' }).click()
    await expect(row(page, 'certbox')).toHaveCount(0)
    const card = await openPanelCard(page)
    await expect(cardRow(card, 'keybox')).toBeVisible()
    await expect(cardRow(card, 'certbox')).toHaveCount(0)
  })

  test('BP-C11: Dismiss all in the panel hides every host row in both cards, keeps the local section; focus ends on Needs Action', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expectTasksCard(page)
    const card = await openPanelCard(page)
    await card.getByRole('button', { name: 'Dismiss all' }).click()
    await expect(card.locator('li.hpb-row[data-host]')).toHaveCount(0)
    await expect(card.locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
    await expect(card.getByText('Hidden until they change.')).toBeVisible()
    // Off the card and off the panel body (the header): the undo line folds after 5s.
    await page.locator('.notification-panel-title').hover()
    await expect(card.getByText('Hidden until they change.')).toHaveCount(0, { timeout: 12_000 })
    await expect(railButton(page, 'Needs Action')).toBeFocused()
    await closePanel(page, 'escape')
    await expect(banner(page)).toHaveCount(1)
    await expect(banner(page).locator('li.hpb-row[data-host]')).toHaveCount(0)
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
  })

  test('BP-C12: Dismiss Claude Code notice in the panel on /notes: the bell dot goes in the next frame; Home shows no local section', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'sign-in' })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await goRail(page, 'notes')
    await expect(bellDot(page)).toHaveCount(1)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: Claude Code needs attention')
    const card = await openPanelCard(page)
    const x = card.getByRole('button', { name: 'Dismiss Claude Code notice' })
    expect(await countInFirstFrameAfterClick(page, x, '.sidebar-notification-btn .notification-badge-dot')).toBe(0)
    await closePanel(page, 'escape')
    await goRail(page, 'home')
    await page.mouse.move(2, 2)
    await expect(page.locator('[data-testid="setup-banner-sign-in"]')).toHaveCount(0)
    await expect(banner(page)).toHaveCount(0, { timeout: 12_000 })
  })
})

test.describe('expiry, undo and the way back', () => {
  test('BP-C47: a dismissed connect row expires on /notes with no card mounted, and the next failure lights the bell', async ({ page }) => {
    test.setTimeout(150_000) // the pruner's 60s interval is the slow path
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')] })
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 20_000 })
    await row(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    expect(await storedKeys(page)).toContain('netbox|connect')
    await goRail(page, 'notes')
    await expect(bellDot(page)).toHaveCount(0)
    // Connected for 11 minutes: the always-on pruner drops the key on this frame (no card is mounted).
    await h.push(connected('netbox', 'Net box', undefined, 11 * 60_000))
    await expect.poll(() => storedKeys(page), { timeout: 65_000 }).not.toContain('netbox|connect')
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: remote hosts need attention', { timeout: 10_000 })
    await expect(bellDot(page)).toHaveCount(1)
    await openBell(page)
    await expect(cardRow(panelBanner(page), 'netbox')).toBeVisible()
    expect(await storedKeys(page)).not.toContain('netbox|connect')
  })

  test('BP-C54: a row x leaves a same-height undo row; Undo inside 400ms does nothing, later it restores the row; untouched it folds', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box'), failed('keybox', 'Key box', 'auth')] })
    await expect.poll(() => hostsOf(banner(page)), { timeout: 20_000 }).toEqual(['netbox', 'keybox', 'signbox'])
    const before = (await row(page, 'netbox').boundingBox())!
    // The pointer rests on the row (the undo line keeps the row's height only
    // while the pointer is in the card: nothing moves under it; BP-N7).
    await page.mouse.move(before.x + before.width / 2, before.y + 8)
    // x, then Undo in the very next frame: inside the 400ms guard, so ignored.
    await page.evaluate(() => new Promise<void>((resolve) => {
      const card = document.querySelector('[data-testid="attention-banner"][data-mount="tasks"]')!
      card.querySelector<HTMLButtonElement>('li.hpb-row[data-host="netbox"] button[aria-label="Dismiss Net box"]')!.click()
      requestAnimationFrame(() => {
        const undo = Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Undo')
        undo?.click()
        resolve()
      })
    }))
    const undoRow = banner(page).locator('li', { hasText: 'Hidden until it changes.' })
    await expect(undoRow).toHaveCount(1)
    await expect(row(page, 'netbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('netbox|connect')
    const held = (await undoRow.boundingBox())!
    expect(Math.abs(held.y - before.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(held.height - before.height)).toBeLessThanOrEqual(1)
    await page.waitForTimeout(450)
    await undoRow.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => hostsOf(banner(page))).toEqual(['netbox', 'keybox', 'signbox'])
    expect(await storedKeys(page)).not.toContain('netbox|connect')
    // Untouched: 5s after the pointer leaves the card the undo row folds away.
    await row(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(undoRow).toHaveCount(1)
    await page.mouse.move(2, 2)
    await expect(undoRow).toHaveCount(0, { timeout: 12_000 })
    expect(await storedKeys(page)).toContain('netbox|connect')
  })

  test('BP-C55: Settings shows Hidden from the banner with Show again for a dismissed host only; Show again brings the row back', async ({ page, request }) => {
    await isolatePrefs(page)
    await page.addInitScript((k) => localStorage.removeItem(k), DISMISS_KEY)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(cardRow(tasksBanner(page), 'certbox')).toBeVisible({ timeout: 20_000 })
    await cardRow(tasksBanner(page), 'certbox').getByRole('button', { name: 'Dismiss Cert box' }).click()
    await expect(cardRow(tasksBanner(page), 'certbox')).toHaveCount(0)
    await openRemoteHosts(page)
    await expect(hostRow(page, 'certbox')).toContainText('Hidden from the banner.')
    await expect(hostRow(page, 'keybox')).not.toContainText('Hidden from the banner.')
    await expect(hostRow(page, 'keybox').getByRole('button', { name: 'Show again' })).toHaveCount(0)
    await hostRow(page, 'certbox').screenshot({ path: `${BP_SHOTS}/c55-settings-hidden.png` })
    await hostRow(page, 'certbox').getByRole('button', { name: 'Show again' }).click()
    await expect(hostRow(page, 'certbox')).not.toContainText('Hidden from the banner.')
    await goRail(page, 'home')
    await expect(cardRow(tasksBanner(page), 'certbox')).toBeVisible({ timeout: 20_000 })
    await resetServerHostFixture(request)
  })
})
