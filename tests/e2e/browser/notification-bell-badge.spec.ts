/**
 * Bell badge semantics: the number counts what WAITS ON THE HUMAN — pending
 * permission/question asks plus unread inbox letters — rendered amber. Errors
 * never badge a number: before this, every unread error kept the bell a
 * permanent red counter that survived recoveries and buried real asks.
 *
 * Seeded through a `GET /api/notifications` route stub (same reasoning as
 * notification-cause-group.spec.ts): the fixture server's feed is shared global
 * state, so absolute count assertions against the real feed would be a race.
 * The stub alone is NOT enough for exact assertions — `notification:new` is a
 * global WS broadcast, so a parallel spec's letter/permission would still land
 * in this page's feed. routeWebSocket dead-ends the live lane: the socket
 * opens (no degraded-UI churn) but no server frame ever arrives.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import type { FeedRecord } from '../../../web/src/contexts/notifications/NotificationProvider'

const SCREENSHOT_DIR = '/tmp/notif-bell-badge'

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function stubNotifications(page: Page, feed: FeedRecord[]): Promise<void> {
  // Dead-end the live lane (see header): connect the page-side socket to
  // nothing, so other specs' broadcasts can't inflate the seeded counts.
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('**/api/notifications', async (route) => {
    await route.fulfill({
      json: { feed, unreadCount: feed.filter((f) => !f.read).length },
    })
  })
  await page.route('**/api/notifications/mark-read', async (route) => {
    await route.fulfill({ json: { unreadCount: 0 } })
  })
}

function errorRecord(id: string, t: number): FeedRecord {
  return {
    id, kind: 'operation-error', severity: 'error',
    title: `PW BADGE error ${id}`, body: 'fixture failure',
    timestamp: t, read: false, dedupKey: `error:pwb-${id}`,
    recoveryKey: 'git', category: 'Data & Sync',
  }
}

test('asks + unread letters badge amber; read state of the ask is irrelevant', async ({ page }) => {
  const t = Date.now()
  await stubNotifications(page, [
    // Pending permission, already READ — the session is still blocked, so it counts.
    {
      id: 'pwb-perm', kind: 'permission', severity: 'warning',
      title: 'Bash', body: 'PW BADGE pending ask',
      timestamp: t - 30_000, read: true, dedupKey: 'perm:pwb-r1',
      requestId: 'pwb-r1', toolName: 'Bash', sessionId: 'pwb-s1',
    },
    // Unread letter envelope.
    {
      id: 'pwb-letter', kind: 'letter', severity: 'info',
      title: 'PW BADGE a letter', timestamp: t - 20_000, read: false,
      dedupKey: 'letter:pwb-l1', letterId: 'pwb-l1',
    },
    // Three unread errors — must not move the number.
    errorRecord('e1', t - 15_000), errorRecord('e2', t - 10_000), errorRecord('e3', t - 5_000),
  ])
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()

  const badge = page.locator('.sidebar-notification-btn .notification-badge-count')
  await expect(badge).toHaveText('2')
  await expect(badge).toHaveClass(/notification-badge-attention/)
  await page.locator('.sidebar-notification-btn').screenshot({
    path: `${SCREENSHOT_DIR}/1-amber-badge-2.png`,
  })

  // Opening the panel marks the feed read (real markAllRead path) — the badge
  // must survive it: a pending ask counts regardless of read, and letters are
  // exempt from the sweep. This is the invariant that keeps the amber count
  // from vanishing the first time the user glances at the panel.
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.locator('.notification-panel')).toBeVisible()

  // Rail semantics inside the panel: Errors badge is RED (live failures), and
  // All carries NO badge — the feed's length is history depth, not a signal.
  const railBtn = (label: string) =>
    page.locator('.nfc-rail .nfc-rail-btn', { has: page.locator('.nfc-rail-name', { hasText: label }) })
  const errorsBadge = railBtn('Errors').locator('.nfc-rail-badge')
  await expect(errorsBadge).toHaveText('3')
  await expect(errorsBadge).toHaveClass(/nfc-danger/)
  await expect(railBtn('All').locator('.nfc-rail-badge')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(page.locator('.notification-panel')).toBeHidden()
  await expect(badge).toHaveText('2')
  await expect(badge).toHaveClass(/notification-badge-attention/)
})

test('a feed of unread errors alone shows NO count badge', async ({ page }) => {
  const t = Date.now()
  await stubNotifications(page, [
    errorRecord('e1', t - 15_000), errorRecord('e2', t - 10_000),
  ])
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()

  const bell = page.locator('.sidebar-notification-btn')
  await expect(bell).toBeVisible()
  await expect(bell.locator('.notification-badge-count')).toHaveCount(0)
  await bell.screenshot({ path: `${SCREENSHOT_DIR}/2-errors-no-badge.png` })
})
