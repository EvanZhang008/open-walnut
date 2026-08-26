/**
 * Root-cause grouping in the Errors pane.
 *
 * One outage (a host's SSH/daemon link down) fans out into error cards under
 * unrelated conditions — a `task:` session-start failure, a `route:` 5xx, a
 * `session:` delivery failure. The server stamps all of them with the same
 * `causeKey` (`host:<alias>`), and the panel folds cards sharing an open cause
 * into ONE block headed by the cause ("Can't reach devbox") instead of four red
 * cards across four families. Once the cards resolve (the daemon reconnects →
 * publishRecovery retires the whole fan-out), they leave the Errors rail.
 *
 * Seeded through a `GET /api/notifications` route stub, same reasoning as
 * notification-center-redesign.spec.ts: the fixture server's feed is shared
 * global state, so absolute assertions against the real feed would be a race.
 * mark-read / dismiss are stubbed so this spec never mutates the shared feed.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
// The wire shape the panel actually parses — imported, never re-declared here.
import type { FeedRecord } from '../../../web/src/contexts/notifications/NotificationProvider'

const SCREENSHOT_DIR = '/tmp/notif-cause-group'
/** Every seeded record's title starts with this, so counts can scope to them. */
const SEED_TAG = 'PW CAUSE'
const CAUSE = 'host:devbox'
const CAUSE_LABEL = "Can't reach devbox"

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/**
 * Three conditions produced by one outage + one unrelated error. Distinct
 * recoveryKeys/origins on purpose: the fold under test is the CAUSE fold, not
 * the same-origin collapse.
 */
function causeFeed(t: number, opts?: { resolved?: boolean }): FeedRecord[] {
  const resolved = opts?.resolved
    ? { resolved: 'recovered' as const, severity: 'info' as const }
    : {}
  return [
    {
      id: 'pwc-start', kind: 'operation-error', severity: 'error',
      title: `${SEED_TAG} couldn't start a session`,
      body: 'Failed to deploy daemon source to devbox: Command failed: ssh',
      timestamp: t - 40_000, read: true, dedupKey: 'logerr:session:pwc-start',
      recoveryKey: 'task:pwc-t1', causeKey: CAUSE, taskId: 'pwc-t1',
      category: 'Sessions', ...resolved,
    },
    {
      id: 'pwc-route', kind: 'operation-error', severity: 'error',
      title: `${SEED_TAG} GET /api/sessions/:id/plan → 500`,
      body: 'This API endpoint is failing (HTTP 500).',
      timestamp: t - 30_000, read: true, dedupKey: 'logerr:web:pwc-route',
      recoveryKey: 'route:GET /api/sessions/:id/plan', causeKey: CAUSE,
      category: 'API', ...resolved,
    },
    {
      id: 'pwc-deliver', kind: 'operation-error', severity: 'error',
      title: `${SEED_TAG} message couldn't be delivered`,
      body: 'Connection to devbox failed 12s ago: connection refused',
      timestamp: t - 10_000, read: true, dedupKey: 'error:session:pwc-s1:delivery',
      recoveryKey: 'session:pwc-s1', causeKey: CAUSE, sessionId: 'pwc-s1',
      category: 'Sessions', ...resolved,
    },
    {
      // No causeKey: an ordinary standalone error that must stay in its family
      // block, proving the cause fold doesn't swallow bystanders.
      id: 'pwc-other', kind: 'operation-error', severity: 'error',
      title: `${SEED_TAG} data sync hiccup`,
      body: 'One-off fixture failure',
      timestamp: t - 20_000, read: true, dedupKey: 'error:pwc-other',
      recoveryKey: 'git', category: 'Data & Sync',
    },
  ]
}

/** Serve a deterministic feed; keep the mutators local to protect the shared feed. */
async function stubNotifications(page: Page, feed: FeedRecord[]): Promise<void> {
  await page.route('**/api/notifications', async (route) => {
    await route.fulfill({
      json: { feed, unreadCount: feed.filter((f) => !f.read).length },
    })
  })
  await page.route('**/api/notifications/mark-read', async (route) => {
    await route.fulfill({ json: { unreadCount: 0 } })
  })
  await page.route('**/api/notifications/dismiss', async (route) => {
    await route.fulfill({ json: { unreadCount: 0, removed: 0 } })
  })
}

async function openErrorsPane(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.locator('.notification-panel')).toBeVisible()
  await page.locator('.nfc-rail').getByRole('button', { name: /^Errors/ }).click()
}

test('one outage folds into a single cause block; bystanders keep their family', async ({ page }) => {
  await stubNotifications(page, causeFeed(Date.now()))
  await openErrorsPane(page)

  const panel = page.locator('.notification-panel')
  // The cause block: headed by the cause, counting all three conditions.
  const causeBlock = panel.locator('.nfc-cat-block', { has: page.locator('.nfc-cause-header') })
  await expect(causeBlock).toHaveCount(1)
  await expect(causeBlock.locator('.nfc-cat-name')).toHaveText(CAUSE_LABEL)
  await expect(causeBlock.locator('.nfc-cat-count')).toHaveText('3')

  // Collapsed: the newest card shows, the other two wait behind the toggle.
  await expect(causeBlock.locator('.notification-feed-item')).toHaveCount(1)
  await expect(causeBlock).toContainText("message couldn't be delivered")
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-cause-collapsed.png`, fullPage: false })

  await causeBlock.getByRole('button', { name: 'Show 2 more' }).click()
  await expect(causeBlock.locator('.notification-feed-item')).toHaveCount(3)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-cause-expanded.png`, fullPage: false })

  // The cause-grouped cards appear exactly once: no seeded title outside the
  // cause block, and the bystander stays in its own family block.
  const familyBlocks = panel.locator('.nfc-cat-block:not(:has(.nfc-cause-header))')
  await expect(familyBlocks.locator('.notification-feed-item', { hasText: SEED_TAG }))
    .toHaveCount(1)
  await expect(familyBlocks.locator('.notification-feed-item', { hasText: 'data sync hiccup' }))
    .toBeVisible()
})

test('recovered cause cards leave the Errors pane', async ({ page }) => {
  await stubNotifications(page, causeFeed(Date.now(), { resolved: true }))
  await openErrorsPane(page)

  const panel = page.locator('.notification-panel')
  // The whole fan-out is settled → no cause block, no seeded cards in Errors;
  // only the unresolved bystander remains.
  await expect(panel.locator('.nfc-cause-header')).toHaveCount(0)
  await expect(panel.locator('.notification-feed-item', { hasText: SEED_TAG })).toHaveCount(1)
  await expect(panel.locator('.notification-feed-item', { hasText: 'data sync hiccup' }))
    .toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-recovered-gone.png`, fullPage: false })
})
