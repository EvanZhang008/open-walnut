/**
 * Dismiss on the card, hidden on every card (slice spec 2.1, 5.1, 7): the task
 * panel card and the slot and draft fallbacks read one dismiss store, and so
 * does the notification panel's problems block (All, Errors): a host dismissed
 * on the card leaves it and the Errors count. Neither the problems block nor
 * System has an x or Dismiss all, and System's host list (the inventory)
 * ignores dismissals. A row x leaves an undo row; expiry runs without any card
 * mounted; Settings can bring a hidden row back.
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
  BP_SHOTS, FIXTURE_ORDER, bellDot, bpSetup, cardRow, closePanel, countInFirstFrameAfterClick, errorsBadge, expectTasksCard, goRail,
  hostsOf, openProblems, panelLocalCard, panelProblems, pickRail, problemHosts, problemRow, problemRowHosts, railButton,
  systemHostRow, systemHosts, systemRowHosts,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

test.describe('one dismiss store behind the card and the panel\'s problems; System ignores it', () => {
  test('BP-C9: a Home card row x is stored and survives a reload; the host leaves All\'s problems and the Errors count, before and after the reload, while System keeps listing it as its row, with no x', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const others = FIXTURE_ORDER.filter((h) => h !== 'netbox')
    await row(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(row(page, 'netbox')).toHaveCount(0)
    expect(await storedKeys(page)).toContain('netbox|connect')
    // "I know" on the card is heard by the panel too: the other problems lead All, one fewer on Errors.
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(others)
    await expect(problemRow(page, 'netbox')).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveText(String(others.length))
    // System is the inventory: the host keeps its row there, with no x.
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'netbox')).toBeVisible()
    await expect(systemHostRow(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' })).toHaveCount(0)
    await closePanel(page, 'escape')
    await expect(banner(page)).toHaveCount(1)
    await expect(row(page, 'netbox')).toHaveCount(0)
    await page.evaluate(() => sessionStorage.setItem('hp-keep', '1'))
    await page.reload()
    await loadHome(page)
    await expect(row(page, 'keybox')).toBeVisible({ timeout: 20_000 })
    await expect(row(page, 'netbox')).toHaveCount(0)
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(others)
    await expect(errorsBadge(page)).toHaveText(String(others.length))
  })

  test('BP-C10: a row x in the task panel takes that host out of All\'s problems and the Errors count (the others stay, in the card\'s order); System still gives every problem host its row', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await row(page, 'certbox').getByRole('button', { name: 'Dismiss Cert box' }).click()
    await expect(row(page, 'certbox')).toHaveCount(0)
    // All: the card's order and the card's dismissals.
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page)).toEqual(['keybox', 'netbox', 'signbox'])
    await expect(problemRow(page, 'certbox')).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveText('3')
    // System: Settings order, dismissals ignored.
    await pickRail(page, 'System')
    await expect.poll(() => systemRowHosts(page)).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    await expect(systemHostRow(page, 'certbox')).toBeVisible()
  })

  test('BP-C11: the panel has no x and no Dismiss all; Dismiss all on the Home card hides its host rows and keeps the local section, and All then leads with the Claude Code card alone (Errors counts 1), while System still lists every problem host', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expectTasksCard(page)
    await openProblems(page)
    const panel = page.locator('.notification-panel')
    await expect(panel.getByRole('button', { name: 'Dismiss all' })).toHaveCount(0)
    await expect(panel.locator('.hpb-x')).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(panel.getByRole('button', { name: 'Dismiss all' })).toHaveCount(0)
    await expect(panel.locator('.hpb-x')).toHaveCount(0)
    await closePanel(page, 'escape')
    await banner(page).getByRole('button', { name: 'Dismiss all' }).click()
    await expect(banner(page).locator('li.hpb-row[data-host]')).toHaveCount(0)
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
    await expect(banner(page).getByText('Hidden until they change.')).toBeVisible()
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    await expect(panelLocalCard(page)).toBeVisible()
    // Every host row was dismissed on the card: no host card here, and no undo line either.
    await expect(problemHosts(page)).toHaveCount(0)
    await expect(page.locator('.notification-panel').locator('.hpb-undo-row, [data-testid="hpb-undo-row"]')).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveText('1')
    await pickRail(page, 'System')
    await expect.poll(() => systemRowHosts(page)).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    await expect(systemHosts(page).locator('.hpb-undo-row, [data-testid="hpb-undo-row"]')).toHaveCount(0)
    await closePanel(page, 'escape')
    await expect(banner(page)).toHaveCount(1)
    await expect(banner(page).locator('li.hpb-row[data-host]')).toHaveCount(0)
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible()
  })

  test('BP-C12: Dismiss Claude Code notice in All\'s Claude Code card on /notes: the bell dot goes in the next frame, the card leaves the panel and the Errors count; Home shows no local section', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box')], local: 'sign-in' })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await goRail(page, 'notes')
    await expect(bellDot(page)).toHaveCount(1)
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: Claude Code needs attention')
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    await expect(errorsBadge(page)).toHaveText('1')
    const x = panelLocalCard(page).getByRole('button', { name: 'Dismiss Claude Code notice' })
    expect(await countInFirstFrameAfterClick(page, x, '.sidebar-notification-btn .notification-badge-dot')).toBe(0)
    await expect(panelLocalCard(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await closePanel(page, 'escape')
    await goRail(page, 'home')
    await page.mouse.move(2, 2)
    await expect(page.locator('[data-testid="setup-banner-sign-in"]')).toHaveCount(0)
    await expect(banner(page)).toHaveCount(0, { timeout: 12_000 })
  })
})

test.describe('expiry, undo and the way back', () => {
  test('BP-C47: a dismissed connect row stays out of All on /notes, expires there with no card mounted, and the next failure lights the bell and leads All again', async ({ page }) => {
    test.setTimeout(150_000) // the pruner's 60s interval is the slow path
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')] })
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 20_000 })
    await row(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    expect(await storedKeys(page)).toContain('netbox|connect')
    await goRail(page, 'notes')
    await expect(bellDot(page)).toHaveCount(0)
    // Dismissed: the bell opens on All with nothing leading it and nothing on Errors; System still lists the host.
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    await expect(panelProblems(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'netbox')).toBeVisible()
    await closePanel(page, 'escape')
    // Connected for 11 minutes: the always-on pruner drops the key on this frame (no card is mounted).
    await h.push(connected('netbox', 'Net box', undefined, 11 * 60_000))
    await expect.poll(() => storedKeys(page), { timeout: 65_000 }).not.toContain('netbox|connect')
    await h.push(failed('netbox', 'Net box', 'unreachable'))
    await expect(bell(page)).toHaveAttribute('aria-label', 'Notifications: remote hosts need attention', { timeout: 10_000 })
    await expect(bellDot(page)).toHaveCount(1)
    // Nothing on /notes covers it: the bell opens on All, led by its row.
    await openProblems(page)
    await expect(problemRow(page, 'netbox')).toBeVisible()
    await expect(panelBanner(page)).toHaveCount(0)
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
