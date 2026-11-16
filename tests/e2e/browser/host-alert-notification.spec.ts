/**
 * A host that cannot connect is a notification, never a card on the page
 * (2026-11-16, the user: "this shoudl not show on top of quick chat pannel",
 * then "please unified, shodl as notificaiton in the notificaiton bar").
 *
 * Two hosts fail to connect (routed client-side, host-problems-helpers.ts), on
 * Home with the Ask Walnut slot open:
 *   (a) task panel hidden, (b) task panel shown, (c) a draft column open: no
 *       host problem row or its words in the slot, a session or draft column,
 *       or the task panel;
 *   (d) a toast in the corner stack says it, with Retry all and Show details;
 *       Show details opens the notification panel, whose problem list names
 *       both hosts with Retry; a row's Retry dials that host; a row's x removes
 *       it, and it stays gone after a reload;
 *   (e) a reload with the same hosts still failing does not toast again;
 *   the toast's Retry all dials both hosts.
 */
import { test, expect, type Page } from '@playwright/test'
import { failed, chatShownLayout, slotLayout, type Hosts } from './host-problems-helpers'
import { bell, resetServerHostFixture } from './host-problems-fixture-helpers'
import { bpSetup, hostRowsOutsidePanel, openProblems, problemRow, problemRowHosts } from './host-attention-helpers'
import { draftPanels, openDraft } from './draft-helpers'

const TWO = () => [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'unreachable')]
const DISMISS_KEY = 'open-walnut-host-banner-dismissed'
const TOASTED_KEY = 'walnut.host-problem-toasted.v1'

const hostToast = (page: Page) => page.locator('[data-testid="corner-stack"] [data-testid="notification-toast"]', { hasText: /remote hosts need attention|Could not connect/ })
/** Every page area a card used to sit in: the slot, the session / draft columns, the task panel. */
const AREAS = ['.ask-walnut-slot', '.main-page-session-column', '.todo-panel'] as const

/** No host problem row, and none of its words, in any page area. */
async function expectNoHostCard(page: Page, label: string): Promise<void> {
  await expect(hostRowsOutsidePanel(page), `${label}: no host row outside the notification panel`).toHaveCount(0)
  for (const area of AREAS) {
    const el = page.locator(area)
    await expect(el.locator('.hpb, [data-testid^="hpb-"], li.hpb-row'), `${label}: no host row in ${area}`).toHaveCount(0)
    await expect(el.getByText(/Remote hosts need attention|Could not connect to/), `${label}: no host words in ${area}`).toHaveCount(0)
  }
}

/** The bell names the host reason once the store has the two failures (the toast reads the same store). */
async function waitForHostReason(page: Page): Promise<void> {
  await expect(bell(page)).toHaveAttribute('aria-label', /remote hosts need attention/, { timeout: 20_000 })
}

test.beforeEach(async ({ request }) => { await resetServerHostFixture(request) })

test('(a) task panel hidden, slot open: no host card anywhere on the page, the toast says it', async ({ page }) => {
  await bpSetup(page, { hosts: TWO(), before: slotLayout })
  await expect(page.locator('.ask-walnut-slot')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.todo-panel')).toBeHidden()
  await waitForHostReason(page)
  await expect(hostToast(page)).toHaveCount(1, { timeout: 10_000 })
  await expectNoHostCard(page, 'slot only')
})

test('(b) task panel and slot both open: no host card in either, the toast says it', async ({ page }) => {
  await bpSetup(page, { hosts: TWO(), before: chatShownLayout })
  await expect(page.locator('.ask-walnut-slot')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.todo-panel')).toBeVisible()
  await waitForHostReason(page)
  await expect(hostToast(page)).toHaveCount(1, { timeout: 10_000 })
  await expectNoHostCard(page, 'task panel + slot')
})

test('(c) a draft column open beside the slot and the task panel: no host card in the draft', async ({ page }) => {
  await bpSetup(page, { hosts: TWO(), before: chatShownLayout })
  await waitForHostReason(page)
  await openDraft(page)
  await expect(draftPanels(page)).toHaveCount(1)
  await expectNoHostCard(page, 'draft column open')
})

test('(d, e) the toast opens the panel; a row Retry dials its host; a row x stays gone after a reload, which toasts nothing again', async ({ page }) => {
  const h: Hosts = await bpSetup(page, { hosts: TWO(), before: chatShownLayout })
  await waitForHostReason(page)

  // (d) One toast for both hosts, with the words the rows lead with and both buttons.
  const toast = hostToast(page)
  await expect(toast).toHaveCount(1, { timeout: 10_000 })
  await expect(toast.locator('.notification-toast-title')).toHaveText('2 remote hosts need attention')
  await expect(toast.locator('.notification-toast-body')).toContainText('Could not connect to Net box')
  await expect(toast.locator('.notification-toast-body')).toContainText('Could not connect to Key box')
  await expect(toast.getByRole('button', { name: 'Retry all' })).toBeVisible()
  await toast.getByRole('button', { name: 'Show details' }).click()

  // Show details opens the notification panel on All, whose problem list names both hosts.
  await expect(page.locator('.notification-panel')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(['netbox', 'keybox'])
  for (const host of ['netbox', 'keybox']) {
    await expect(problemRow(page, host).getByTestId('hpb-retry')).toBeVisible()
  }

  // A row's Retry is one POST /api/hosts/netbox/connect, and only for that host.
  expect(h.connects.get('netbox') ?? 0).toBe(0)
  await problemRow(page, 'netbox').getByTestId('hpb-retry').click()
  await expect.poll(() => h.connects.get('netbox') ?? 0).toBe(1)
  expect(h.connects.get('keybox') ?? 0).toBe(0)
  // The same failure comes back: the row stays, with its receipt.
  await expect(problemRow(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })

  // The row x: Key box leaves the list and its key is stored.
  await problemRow(page, 'keybox').getByRole('button', { name: 'Dismiss Key box' }).click()
  await expect(problemRow(page, 'keybox')).toHaveCount(0)
  await expect(problemRow(page, 'netbox')).toHaveCount(1)
  await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '[]') as string[], DISMISS_KEY)).toContain('keybox|connect')

  // (e) Reload with both hosts still failing. setup() clears stored dismissals on a load
  // unless the session says keep (hp-keep): this reload is the same user coming back.
  await page.evaluate(() => sessionStorage.setItem('hp-keep', '1'))
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await waitForHostReason(page)
  // The toast memory outlived the reload; give the toast the time it took on the first load.
  expect(await page.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k) ?? '{}')).map((id) => id.split('#')[0]).sort(), TOASTED_KEY)).toEqual(['host:keybox', 'host:netbox'])
  await page.waitForTimeout(2_000)
  await expect(hostToast(page)).toHaveCount(0)
  await expectNoHostCard(page, 'after the reload')

  // The dismissed row stays gone; the other is still listed.
  await openProblems(page)
  await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(['netbox'])
})

test("the toast's Retry all dials both hosts", async ({ page }) => {
  const h = await bpSetup(page, { hosts: TWO(), before: chatShownLayout })
  await waitForHostReason(page)
  const toast = hostToast(page)
  await expect(toast).toHaveCount(1, { timeout: 10_000 })
  await toast.getByRole('button', { name: 'Retry all' }).click()
  await expect.poll(() => [h.connects.get('netbox') ?? 0, h.connects.get('keybox') ?? 0]).toEqual([1, 1])
})
