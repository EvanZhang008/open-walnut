/**
 * "Ask AI to fix" on an error notification card — the affordance that hands a
 * failure to a coding session in Walnut's own source.
 *
 * The feed is served through a route stub for the same reason the redesign spec
 * stubs it: `GET /api/notifications` is the panel's only input, and the real feed
 * is global state on a SHARED fixture server that other specs keep writing to, so
 * any claim about a specific card has to be about a seeded one. `stubNotifications`
 * is COPIED from notification-center-redesign.spec.ts rather than imported — a
 * spec file is not a helper module, and importing one would make its `beforeAll`
 * (fixture discovery) part of this file's setup.
 *
 * `/api/config` is deliberately NOT stubbed: whether the button may appear at all
 * is the server's answer (`selfRepair.available`), and the fixture server runs from
 * this checkout, so the honest test is to read the real answer and skip if the
 * environment can't offer a repair (a git-less checkout, a cloud replica).
 *
 * POST /api/notifications/fix is stubbed in the seeded-card tests (1-4), which
 * pin the card's behaviour against a controlled feed. Test 5 runs the REAL chain
 * once: a real error card (the mock CLI failing a real quick session) → the real
 * route → a real session in this checkout, run by the fixture's mock CLI.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftComposer, openDraftOnCwd } from './draft-helpers'
// The wire shape the panel actually parses — imported, never re-declared here, so
// a change to the server record can't leave this spec seeding a stale shape.
import type { FeedRecord } from '../../../web/src/contexts/notifications/NotificationProvider'

const SCREENSHOT_DIR = '/tmp/notif-fix'

/** The seeded record's dedupKey — the identity the fix route is addressed by. */
const DEDUP_KEY = 'error:git:repo-size-pw'
/** Every assertion scopes to this title: the shared feed is live. */
const ERROR_TITLE = 'Data repo growing too large'
/** A session id no fixture session can have, so the column is deterministic. */
const FIX_SESSION_ID = '11111111-2222-4333-8444-555555555555'

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

// ── Fixture record ──

/** One error card, the shape src/core/notifications/store.ts persists. */
function errorRecord(t: number, fix?: FeedRecord['fix']): FeedRecord {
  return {
    id: 'nfc-fix-repo-size',
    kind: 'operation-error',
    severity: 'error',
    title: ERROR_TITLE,
    body: 'The data repo is 1.2 GB, which slows every sync. Prune old history or move large files out.',
    timestamp: t - 90_000,
    lastTimestamp: t - 15_000,
    count: 2,
    read: false,
    dedupKey: DEDUP_KEY,
    category: 'Data & Sync',
    recoveryKey: 'git',
    ...(fix ? { fix } : {}),
  }
}

// ── Helpers (copied from notification-center-redesign.spec.ts) ──

/**
 * Serve a deterministic feed and keep the mutators local. mark-read / dismiss are
 * stubbed on purpose: they are server-wide writes, and this spec must not mark
 * another spec's notifications read or delete them.
 */
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

async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

async function openCenter(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  return panel
}

/** The Errors section, reached the way a user reaches it. */
async function showErrors(panel: Locator): Promise<void> {
  const errors = panel.locator('.nfc-rail-btn', { hasText: 'Errors' }).first()
  await errors.click()
  await expect(errors).toHaveAttribute('aria-current', 'true')
}

/** The ONE seeded card. Scoped by title — the shared feed carries real errors. */
const seededCard = (panel: Locator): Locator =>
  panel.locator('.nfc-detail .notification-feed-item').filter({ hasText: ERROR_TITLE })

/**
 * Can this environment start a repair at all? The button is deliberately absent
 * when it can't (a cloud replica, an install with no git), so a spec that
 * asserted the button unconditionally would be asserting the machine, not the code.
 */
async function selfRepairAvailable(page: Page): Promise<{ available: boolean; reason?: string }> {
  const res = await page.request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as {
    selfRepair?: { available?: boolean; reason?: string } | null
  }
  return {
    available: body.selfRepair?.available === true,
    ...(body.selfRepair?.reason ? { reason: body.selfRepair.reason } : {}),
  }
}

// ── 1. The button is on the card, and the card body still just expands ──

test('an error card offers Ask AI to fix, and the card body still expands instead of navigating', async ({ page }) => {
  const repair = await selfRepairAvailable(page)
  test.skip(
    !repair.available,
    `this checkout cannot start a repair session (selfRepair.reason=${repair.reason ?? 'none'}), so the button is correctly absent`,
  )

  await stubNotifications(page, [errorRecord(Date.now())])
  await loadHome(page)

  const panel = await openCenter(page)
  await showErrors(panel)

  const card = seededCard(panel)
  await expect(card).toHaveCount(1)
  const startBtn = card.locator('[data-testid=nfc-fix-start]')
  await expect(startBtn).toBeVisible()
  await expect(startBtn).toContainText('Ask AI to fix')
  // A record with no repair yet shows no "open" affordance.
  await expect(card.locator('[data-testid=nfc-fix-open]')).toHaveCount(0)

  await panel.screenshot({ path: `${SCREENSHOT_DIR}/card-with-button.png` })

  // The card is itself a click target. With no session/task to link to, that
  // click EXPANDS — it must not navigate away from the home page, and the panel
  // must stay open (the button lives inside it).
  const urlBefore = new URL(page.url()).pathname
  await card.locator('.notification-feed-item-title').click()
  await expect(card).toHaveClass(/expanded/)
  expect(new URL(page.url()).pathname).toBe(urlBefore)
  await expect(panel).toBeVisible()
})

// ── 2. Clicking it starts the session and opens it on the home page ──

test('clicking Ask AI to fix posts the dedupKey and opens the repair session', async ({ page }) => {
  const repair = await selfRepairAvailable(page)
  test.skip(!repair.available, `no repair source here (reason=${repair.reason ?? 'none'})`)

  let posted: Record<string, unknown> | undefined
  await page.route('**/api/notifications/fix', async (route) => {
    posted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      json: { taskId: 'task-pw-fix', sessionId: FIX_SESSION_ID, reused: false, cloned: false },
    })
  })
  await stubNotifications(page, [errorRecord(Date.now())])
  await loadHome(page)

  const panel = await openCenter(page)
  await showErrors(panel)
  await seededCard(panel).locator('[data-testid=nfc-fix-start]').click()

  // The route is addressed by dedupKey (the id a live WS card carries is
  // frontend-local), and a plain click never asks for a restart.
  await expect.poll(() => posted).toBeTruthy()
  expect(posted).toEqual({ dedupKey: DEDUP_KEY })

  // Opening the session closes the panel and lands on the home columns.
  await expect(page.locator('.notification-panel-backdrop')).toHaveCount(0)
  await expect(page.locator('.notification-panel')).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')

  // openSessionOrToast (MainPage) adds the column unconditionally — it only
  // toasts when every panel is locked — so the column IS the observable.
  const column = page.locator(`.main-page-session-column [data-session-id="${FIX_SESSION_ID}"]`)
  await expect(column).toBeVisible({ timeout: 20_000 })
  // …and because this stubbed id resolves to nothing, the panel settles on its
  // explicit "Session not found" state once the ~15s retry window closes.
  await expect(column).toHaveAttribute('data-session-missing', 'true', { timeout: 40_000 })
  await expect(column).toContainText('Session not found')
})

// ── 3. A record that already has a repair points at it instead ──

test('a record with a repair session shows Open fix session, not a second start', async ({ page }) => {
  await stubNotifications(page, [errorRecord(Date.now(), {
    taskId: 'task-old',
    sessionId: '22222222-2222-4333-8444-555555555555',
    startedAt: Date.now() - 60_000,
  })])
  await loadHome(page)

  const panel = await openCenter(page)
  await showErrors(panel)

  const card = seededCard(panel)
  await expect(card).toHaveCount(1)
  const openBtn = card.locator('[data-testid=nfc-fix-open]')
  await expect(openBtn).toBeVisible()
  await expect(openBtn).toContainText('Open fix session')
  // The start button is replaced, not duplicated: one error, one repair.
  await expect(card.locator('[data-testid=nfc-fix-start]')).toHaveCount(0)
  // …with the quiet way to start over next to it.
  await expect(card.locator('[data-testid=nfc-fix-restart]')).toBeVisible()
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/card-with-existing-fix.png` })
})

// ── 4. A refused start says why, on the card, without closing the panel ──

test('a failed start shows the server reason inline and leaves the button usable', async ({ page }) => {
  const repair = await selfRepairAvailable(page)
  test.skip(!repair.available, `no repair source here (reason=${repair.reason ?? 'none'})`)

  await page.route('**/api/notifications/fix', async (route) => {
    await route.fulfill({
      status: 503,
      json: { error: 'No Walnut source checkout and git is not installed' },
    })
  })
  await stubNotifications(page, [errorRecord(Date.now())])
  await loadHome(page)

  const panel = await openCenter(page)
  await showErrors(panel)

  const card = seededCard(panel)
  const startBtn = card.locator('[data-testid=nfc-fix-start]')
  await startBtn.click()

  await expect(card.locator('.nfc-fix-error')).toContainText('git is not installed')
  // A dead end would be the bug: the panel stays open and the button is clickable
  // again, so the user can retry once they have fixed the cause.
  await expect(panel).toBeVisible()
  await expect(startBtn).toBeEnabled()
  await expect(startBtn).toContainText('Ask AI to fix')
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/card-fix-error.png` })
})

// ── 5. The real chain, once: real error card → real route → real session here ──

test('a real error card hands off to a real repair session filed under Walnut', async ({ page }) => {
  const repair = await selfRepairAvailable(page)
  test.skip(!repair.available, `no repair source here (reason=${repair.reason ?? 'none'})`)

  // A REAL error card through the real pipeline: the mock CLI exits non-zero for
  // the exact prompt "error" (the same lever error-notification-routing.spec.ts
  // uses), which lands a "Session Error" card in the shared feed.
  const dirs = await (await page.request.get('/api/sessions/working-dirs')).json() as { dirs: Array<{ cwd: string }> }
  const walnutDir = dirs.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))
  if (!walnutDir) throw new Error('Playwright working-directory fixture is missing')

  await loadHome(page)
  await openDraftOnCwd(page, walnutDir.cwd)
  const launched = page.waitForResponse((r) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const composer = draftComposer(page)
  await composer.fill('error')
  await composer.press('Enter')
  const launch = await launched
  const failingSessionId = (await launch.json() as { sessionId?: string }).sessionId
  expect(failingSessionId).toBeTruthy()

  // The card for THAT session, with no repair yet. Other specs leave their own
  // session-error cards in this shared feed, so the match is by sessionId. The
  // title is whatever the humanizer says today; the task title must echo it.
  let dedupKey = ''
  let cardTitle = ''
  await expect.poll(async () => {
    const data = await (await page.request.get('/api/notifications')).json() as {
      feed: Array<{ dedupKey: string; kind: string; title: string; sessionId?: string; fix?: unknown }>
    }
    const item = data.feed.find((i) =>
      i.kind === 'operation-error' && i.sessionId === failingSessionId && !i.fix)
    dedupKey = item?.dedupKey ?? ''
    cardTitle = item?.title ?? ''
    return !!item
  }, { timeout: 20_000 }).toBe(true)

  const panel = await openCenter(page)
  await showErrors(panel)
  // Same-origin cards fold into a group; a fresh session is its own group, and
  // its card is the one that still offers a start.
  const card = panel.locator('.nfc-detail .notification-feed-item')
    .filter({ hasText: cardTitle })
    .filter({ has: page.locator('[data-testid=nfc-fix-start]') })
    .first()
  await expect(card).toBeVisible()

  const fixed = page.waitForResponse((r) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/notifications/fix')
  await card.locator('[data-testid=nfc-fix-start]').click()
  const fixRes = await fixed
  expect(fixRes.status()).toBe(200)
  const fix = await fixRes.json() as {
    taskId: string; sessionId?: string; reused: boolean; cloned: boolean
    source?: { dir: string; kind: string }
  }
  expect(fixRes.request().postDataJSON()).toEqual({ dedupKey })
  expect(fix.reused).toBe(false)
  expect(fix.cloned).toBe(false)
  // The fixture server runs from this checkout, so the repair runs in it too.
  expect(fix.source?.kind).toBe('running')
  expect(fix.sessionId).toBeTruthy()

  // Filed under the real Walnut project with the card's title behind "Fix:".
  const { task } = await (await page.request.get(`/api/tasks/${fix.taskId}`)).json() as {
    task: { title: string; project: string; cwd?: string }
  }
  expect(task.title).toBe(`Fix: ${cardTitle}`)
  expect(task.project).toBe('Walnut')
  expect(task.cwd).toBe(fix.source?.dir)

  // The session opened as a home column — a live one this time, not "not found".
  const column = page.locator(`.main-page-session-column [data-session-id="${fix.sessionId}"]`)
  await expect(column).toBeVisible({ timeout: 20_000 })
  await expect(column).not.toHaveAttribute('data-session-missing', 'true')
  await column.screenshot({ path: `${SCREENSHOT_DIR}/real-fix-session-column.png` })

  // The record now remembers its repair: the card offers "Open fix session".
  await expect.poll(async () => {
    const data = await (await page.request.get('/api/notifications')).json() as {
      feed: Array<{ dedupKey: string; fix?: { taskId: string; sessionId?: string } }>
    }
    return data.feed.find((i) => i.dedupKey === dedupKey)?.fix?.sessionId ?? null
  }).toBe(fix.sessionId)
  const reopened = await openCenter(page)
  await showErrors(reopened)
  const sameCard = reopened.locator('.nfc-detail .notification-feed-item')
    .filter({ hasText: cardTitle })
    .filter({ has: page.locator('[data-testid=nfc-fix-open]') })
  await expect(sameCard.first()).toBeVisible()
})
