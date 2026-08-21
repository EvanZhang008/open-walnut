/**
 * Notification center redesign — rail + detail panes, answerable permission
 * cards, the toast policy, and the server's ×N occurrence fold.
 *
 * Two halves, deliberately:
 *
 *  1. SEEDED FEED (tests 1-4). `GET /api/notifications` is the panel's only
 *     input, so the record shapes the server persists are served through a route
 *     stub. That is what makes the rail assertions honest on a SHARED fixture
 *     server: the feed is global state every other spec's errors land in, so any
 *     absolute count or "landing section" claim against the real feed would be a
 *     race, not a test. The live WS events (`notification:new`,
 *     `notification:updated`, `cron:notification`, `skill:notification`) are
 *     dispatched on the page's OWN socket — the exact frames the server sends —
 *     so the render path under test is the production one.
 *  2. REAL END TO END (test 5). A live Codex session asks a real permission
 *     through the mock ACP agent, which exercises the server enrichment hunk
 *     (persist requestId/toolName/acpOptions + broadcast `notification:new`), the
 *     answerable toast, and `POST /api/sessions/:id/permission` for real — the
 *     mock agent's own reply text is the receipt that the approval landed.
 *
 * Serial: test 5 broadcasts a permission notification to EVERY connected client,
 * which would flip test 2's "no pending permission → land on All" assertion if
 * the two ran at once.
 *
 * Every ABSOLUTE count or text assertion is scoped to the seeded `PW NFC` records
 * (`seededItems` / `seededPermCards`). The fixture server is shared and its live
 * WS keeps delivering real notifications mid-test, so an unscoped `toHaveCount`
 * fails on someone else's error rather than on the behavior under test.
 *
 * Never clicks "Clear All" — that deletes the shared feed other specs assert on.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, openDraftOnCwd } from './draft-helpers'
// The wire shape the panel actually parses — imported, never re-declared here, so
// a change to the server record can't leave this spec seeding a stale shape.
import type { FeedRecord } from '../../../web/src/contexts/notifications/NotificationProvider'

const SCREENSHOT_DIR = '/tmp/notif-redesign'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
/** Feed-only session id: tests 1-4 never talk to a real session. */
const SESSION_ID = 'pw-nfc-session'
/** Every seeded record's title starts with this — see `seeded()`. */
const SEED_TAG = 'PW NFC'

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

// ── Fixture records (the enriched shape src/core/notifications/store.ts writes) ──

/**
 * A visibly harmless command. It is NEVER executed — the record is a static
 * fixture served by a route stub — but it lands in the screenshots this spec
 * writes, and an `rm -rf` string in a user-facing shot reads as a real
 * destructive suggestion.
 */
const BASH_COMMAND = 'tar -czf /tmp/nfc-demo.tgz ./src && echo packaged'

/** Errors + automation only — the half of the feed with no action items. */
function receiptRecords(t: number): FeedRecord[] {
  return [
    {
      // Folded: first-seen an hour ago, still firing 10s ago. `timestamp` stays
      // first-seen, so only effectiveTs (lastTimestamp) keeps it at the top.
      id: 'nfc-err-fold', kind: 'operation-error', severity: 'error',
      title: 'PW NFC folded failure', body: 'ECONNRESET talking to the fixture host',
      timestamp: t - 3_600_000, lastTimestamp: t - 10_000, count: 4,
      read: false, dedupKey: 'error:pw-nfc-fold',
    },
    {
      id: 'nfc-err-single', kind: 'operation-error', severity: 'error',
      title: 'PW NFC single failure', body: 'One-off fixture failure',
      timestamp: t - 45_000, read: false, dedupKey: 'error:pw-nfc-single',
    },
    {
      id: 'nfc-cron', kind: 'cron', severity: 'info',
      title: 'PW NFC nightly job', body: 'Reviewed 3 tasks',
      timestamp: t - 30_000, read: false, dedupKey: 'cron:pw-nfc-job:1',
    },
    {
      // Titles all carry the PW NFC tag so every absolute count in this spec can
      // scope to the seeded records (the shared server's real feed is live).
      id: 'nfc-skill', kind: 'skill', severity: 'success',
      title: 'PW NFC skill: pw-nfc-demo', body: 'A fixture skill landed',
      timestamp: t - 20_000, read: false, dedupKey: 'skill:pw-nfc-demo:1',
    },
  ]
}

/** Receipts + one PENDING Bash ask + one RESOLVED ask on the same session. */
function actionableFeed(t: number): FeedRecord[] {
  return [
    {
      id: 'nfc-perm-bash', kind: 'permission', severity: 'warning',
      title: 'Bash', body: BASH_COMMAND,
      timestamp: t - 120_000, read: false,
      dedupKey: 'perm:pw-nfc-bash', requestId: 'pw-nfc-bash',
      toolName: 'Bash', sessionId: SESSION_ID,
      input: { command: BASH_COMMAND, description: 'Clean the demo directory' },
      host: 'nfc-host', sessionTitle: 'PW NFC fixture session', project: 'Walnut',
    },
    {
      // Resolved → history: out of Needs Action, and NO approve/deny buttons.
      id: 'nfc-perm-read', kind: 'permission', severity: 'success',
      title: 'Read', body: '/tmp/nfc/read-me.txt',
      timestamp: t - 60_000, read: false, resolved: 'allowed',
      dedupKey: 'perm:pw-nfc-read', requestId: 'pw-nfc-read',
      toolName: 'Read', sessionId: SESSION_ID,
      input: { file_path: '/tmp/nfc/read-me.txt' },
      host: 'nfc-host', sessionTitle: 'PW NFC fixture session', project: 'Walnut',
    },
    ...receiptRecords(t),
  ]
}

function askUserQuestionFeed(t: number): FeedRecord[] {
  return [{
    id: 'nfc-perm-question', kind: 'permission', severity: 'warning',
    title: 'AskUserQuestion', body: 'Which deployment?',
    timestamp: t - 5_000, read: false,
    dedupKey: 'perm:pw-nfc-question', requestId: 'pw-nfc-question',
    toolName: 'AskUserQuestion', sessionId: SESSION_ID,
    input: {
      questions: [{
        header: 'Target',
        question: 'Which deployment?',
        options: [
          { label: 'Staging', description: 'Deploy to staging' },
          { label: 'Production', description: 'Deploy to production' },
        ],
        multiSelect: false,
      }],
    },
    reason: 'Need a deployment target',
    host: 'nfc-host', sessionTitle: 'PW NFC fixture session', project: 'Walnut',
  }]
}

// ── Helpers ──

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

/** Capture the app's own /ws socket so server frames can be replayed into it. */
async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Original = window.WebSocket
    window.WebSocket = class NfcWebSocket extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const parsed = new URL(String(url), window.location.href)
        const holder = window as unknown as { __nfcWs?: WebSocket }
        if (parsed.pathname === '/ws' && !holder.__nfcWs) holder.__nfcWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] =
          (Original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants already exist on the subclass.
      }
    }
  })
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __nfcWs?: WebSocket }).__nfcWs
    return !!ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 20_000 })
}

/** Dispatch one server event frame on the captured socket. */
async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ eventName, eventData }) => {
    const ws = (window as unknown as { __nfcWs?: WebSocket }).__nfcWs
    if (!ws) throw new Error('the app WebSocket was never captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: eventName, data: eventData, seq: Date.now() }),
    }))
  }, { eventName: name, eventData: data })
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

const rail = (panel: Locator, label: string): Locator =>
  panel.locator('.nfc-rail-btn', { hasText: label })

const feedItems = (panel: Locator): Locator =>
  panel.locator('.nfc-detail .notification-feed-item')

/**
 * Every ABSOLUTE count assertion goes through one of these two. The feed is
 * global state on a SHARED fixture server — a real notification broadcast by
 * another spec reaches this page's socket and lands in the same list — so an
 * unfiltered `toHaveCount(n)` is a race, not a test. Each seeded record carries
 * the `PW NFC` tag in its title or session chip.
 */
const seededItems = (panel: Locator): Locator =>
  feedItems(panel).filter({ hasText: SEED_TAG })

const seededPermCards = (panel: Locator): Locator =>
  panel.locator('.nfc-perm-card').filter({ hasText: SEED_TAG })

async function showSection(panel: Locator, label: string): Promise<void> {
  await rail(panel, label).click()
  // aria-current, not aria-selected: the rail is plain buttons on purpose (the
  // ARIA tab pattern would oblige a tabpanel + arrow-key nav + roving tabindex).
  await expect(rail(panel, label)).toHaveAttribute('aria-current', 'true')
}

// ── 1. Rail + detail, counts, rich Bash card, ×N fold ──

test('rail sorts the feed by what the user has to do, and cards carry the ask', async ({ page }) => {
  await captureWs(page)
  await stubNotifications(page, actionableFeed(Date.now()))
  await loadHome(page)
  await waitForWs(page)

  // Bell badge covers the 6 seeded unread records. Asserted as a FLOOR, not an
  // equality: the badge is one number for the whole feed, so a real notification
  // from the shared fixture server legitimately pushes it higher.
  const badge = page.locator('.notification-badge-count')
  await expect(badge).toBeVisible()
  expect(Number((await badge.textContent())?.replace('+', '') ?? 0)).toBeGreaterThanOrEqual(6)

  const panel = await openCenter(page)

  // Landing section is Needs Action, because one ask is still pending.
  await expect(rail(panel, 'Needs Action')).toHaveAttribute('aria-current', 'true')
  // The action badge counts PENDING permissions only — the resolved twin is history.
  await expect(rail(panel, 'Needs Action').locator('.nfc-rail-badge')).toHaveText('1')

  // The pending card renders WHAT is being asked plus WHERE it came from.
  const bashCard = seededPermCards(panel)
  await expect(bashCard).toHaveCount(1)
  await expect(bashCard.locator('.notification-feed-item-title')).toHaveText('Bash')
  await expect(bashCard.locator('.nfc-card-cmd')).toHaveText(BASH_COMMAND)
  await expect(bashCard.locator('.nfc-card-sub').first()).toContainText('Clean the demo directory')
  const chips = bashCard.locator('.nfc-card-chips .nfc-chip')
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(0)).toHaveText('PW NFC fixture session')
  await expect(chips.nth(1)).toHaveText('nfc-host')
  await expect(chips.nth(2)).toHaveText('Walnut')
  // …and the buttons that answer it, without opening the session.
  await expect(bashCard.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(bashCard.getByRole('button', { name: 'Deny' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/needs-action-bash-card.png`, fullPage: true })

  // Errors: the two seeded operation-errors, and the folded one wears its ×N badge.
  await showSection(panel, 'Errors')
  await expect(seededItems(panel)).toHaveCount(2)
  const folded = feedItems(panel).filter({ hasText: 'PW NFC folded failure' })
  await expect(folded.locator('.nfc-count-badge')).toHaveText('×4')
  await expect(feedItems(panel).filter({ hasText: 'PW NFC single failure' })
    .locator('.nfc-count-badge')).toHaveCount(0)
  await expect(seededPermCards(panel)).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/errors-section-fold-badge.png`, fullPage: true })

  // A re-fire is an UPDATE: the same card grows its count, no second entry and
  // (crucially) no toast — that is the 36-identical-403s problem.
  await injectEvent(page, 'notification:updated', {
    id: 'nfc-err-fold', kind: 'operation-error', severity: 'error',
    title: 'PW NFC folded failure', body: 'ECONNRESET talking to the fixture host (again)',
    timestamp: Date.now() - 3_600_000, lastTimestamp: Date.now(), count: 7,
    read: false, dedupKey: 'error:pw-nfc-fold',
  })
  await expect(folded.locator('.nfc-count-badge')).toHaveText('×7')
  await expect(folded).toContainText('(again)')
  await expect(seededItems(panel)).toHaveCount(2)
  await expect(page.locator('.notification-toast', { hasText: 'PW NFC folded failure' }))
    .toHaveCount(0)

  // Automation: the cron + skill receipts.
  await showSection(panel, 'Automation')
  await expect(seededItems(panel)).toHaveCount(2)
  await expect(feedItems(panel).filter({ hasText: 'PW NFC nightly job' })).toHaveCount(1)
  await expect(feedItems(panel).filter({ hasText: 'PW NFC skill: pw-nfc-demo' })).toHaveCount(1)

  // System: ambient health, no feed entries at all (not even another spec's).
  await showSection(panel, 'System')
  await expect(panel.locator('.notification-card-label', { hasText: 'Data Backup' }))
    .toBeVisible({ timeout: 15_000 })
  await expect(feedItems(panel)).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/system-section.png`, fullPage: true })

  // All: everything, newest first — and the two same-session asks collapse into
  // ONE group whose visible entry is the PENDING one (a collapsed group must
  // never bury the card that carries the buttons).
  await showSection(panel, 'All')
  // 5 of the 6 seeded records show: the resolved twin hides under the group fold.
  await expect(seededItems(panel)).toHaveCount(5)
  const groupToggle = panel.locator('.notification-feed-group')
    .filter({ hasText: SEED_TAG })
    .locator('.notification-group-toggle')
  await expect(groupToggle).toHaveText('Show 1 more')
  await expect(seededPermCards(panel)).toHaveCount(1)
  await expect(seededPermCards(panel).locator('.notification-feed-item-title')).toHaveText('Bash')
  // Newest-first ordering keys off effectiveTs, so the folded error (first seen
  // an hour ago, last fired seconds ago) leads the seeded records.
  await expect(seededItems(panel).first()).toContainText('PW NFC folded failure')

  await groupToggle.click()
  await expect(seededItems(panel)).toHaveCount(6)
  // The resolved twin (Read) is now visible alongside the pending Bash ask.
  const resolvedCard = seededPermCards(panel)
    .filter({ hasText: '/tmp/nfc/read-me.txt' })
  await expect(resolvedCard).toHaveCount(1)
  await expect(resolvedCard.locator('.notification-feed-item-title')).toHaveText('Read')
  await expect(resolvedCard.locator('.notification-feed-item-resolved')).toHaveText('Approved')
  // Settled = no answer buttons to click a second time.
  await expect(resolvedCard.locator('.notification-perm-btn')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/all-section-expanded-group.png`, fullPage: true })
})

// ── 2. Landing section falls back to All with nothing pending ──

test('with no pending ask the center lands on All, and Needs Action reads empty', async ({ page }) => {
  await stubNotifications(page, receiptRecords(Date.now()))
  await loadHome(page)

  const panel = await openCenter(page)
  await expect(rail(panel, 'All')).toHaveAttribute('aria-current', 'true')
  await expect(rail(panel, 'Needs Action')).toHaveAttribute('aria-current', 'false')
  await expect(rail(panel, 'Needs Action').locator('.nfc-rail-badge')).toHaveCount(0)
  await expect(seededItems(panel)).toHaveCount(4)

  await showSection(panel, 'Needs Action')
  // No SEEDED pending ask; another spec's real permission could add one, so this
  // asserts the seeded half is empty rather than the whole section.
  await expect(seededPermCards(panel)).toHaveCount(0)
  await expect(panel.locator('.notification-feed-empty')).toHaveText('Nothing waiting on you')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/landing-all-empty-action.png`, fullPage: true })
})

// ── 3. AskUserQuestion is answered in the card, not in the session ──

test('AskUserQuestion card submits the real answers map to the permission route', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { status: 'resolved', requestId: 'pw-nfc-question', allow: true } })
  })
  await stubNotifications(page, askUserQuestionFeed(Date.now()))
  await loadHome(page)

  const panel = await openCenter(page)
  await expect(rail(panel, 'Needs Action')).toHaveAttribute('aria-current', 'true')

  const card = seededPermCards(panel)
  await expect(card).toHaveCount(1)
  await expect(card.locator('.notification-feed-item-title')).toHaveText('AskUserQuestion')
  await expect(card.locator('.nfc-answer-text')).toHaveText('Which deployment?')
  await expect(card.locator('.nfc-card-sub', { hasText: 'Need a deployment target' })).toBeVisible()
  const options = card.locator('.nfc-answer-opt')
  await expect(options).toHaveCount(2)

  // Submit is gated on every question having an answer — an allow with an empty
  // answers map tells the model the user answered nothing.
  const submit = card.getByRole('button', { name: 'Submit' })
  await expect(submit).toBeDisabled()
  await card.locator('.nfc-answer-opt', { hasText: 'Staging' }).click()
  await expect(card.locator('.nfc-answer-opt', { hasText: 'Staging' })).toHaveClass(/nfc-picked/)
  await expect(submit).toBeEnabled()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/ask-user-question-card.png`, fullPage: true })

  await submit.click()
  await expect(card.locator('.notification-feed-item-resolved')).toHaveText('Approved')
  await expect(card.locator('.nfc-answer')).toHaveCount(0)
  expect(submitted).toMatchObject({
    requestId: 'pw-nfc-question',
    allow: true,
    answers: { 'Which deployment?': 'Staging' },
  })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/ask-user-question-answered.png`, fullPage: true })
})

// ── 4. Toast policy: only what needs a human NOW interrupts ──

test('permissions and hard errors toast; cron, skills and warnings go to the feed only', async ({ page }) => {
  let denied: Record<string, unknown> | undefined
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, async (route) => {
    denied = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { status: 'resolved', requestId: 'pw-nfc-toast', allow: false } })
  })
  await captureWs(page)
  await stubNotifications(page, [])
  await loadHome(page)
  await waitForWs(page)

  // Routine automation: feed + bell only.
  await injectEvent(page, 'cron:notification', {
    jobName: 'PW NFC cron toastless', text: 'Nothing to do', timestamp: Date.now(),
  })
  await injectEvent(page, 'skill:notification', {
    name: 'pw-nfc-toastless-skill', title: 'PW NFC skill: pw-nfc-toastless-skill',
    body: 'Landed quietly', timestamp: Date.now(),
  })
  // A non-error operation-error is a diagnosis, not an interruption.
  await injectEvent(page, 'notification:new', {
    id: 'nfc-warn', kind: 'operation-error', severity: 'warning',
    title: 'PW NFC warning only', body: 'Degraded, not broken',
    timestamp: Date.now(), read: false, dedupKey: 'error:pw-nfc-warning',
  })
  // A hard error does interrupt — twice under one dedupKey is still ONE of each.
  const hardError = {
    id: 'nfc-hard', kind: 'operation-error', severity: 'error',
    title: 'PW NFC hard error', body: 'Fixture blew up',
    timestamp: Date.now(), read: false, dedupKey: 'error:pw-nfc-hard',
  }
  await injectEvent(page, 'notification:new', hardError)
  await injectEvent(page, 'notification:new', hardError)
  // The enriched permission frame the server broadcasts.
  await injectEvent(page, 'notification:new', {
    id: 'nfc-toast-perm', kind: 'permission', severity: 'warning',
    title: 'Bash', body: BASH_COMMAND, timestamp: Date.now(), read: false,
    dedupKey: 'perm:pw-nfc-toast', requestId: 'pw-nfc-toast', toolName: 'Bash',
    sessionId: SESSION_ID, input: { command: BASH_COMMAND },
    host: 'nfc-host', sessionTitle: 'PW NFC fixture session',
  })

  const toast = (text: string) => page.locator('.notification-toast', { hasText: text })
  // Scoped to the seeded ask: a real permission from another spec would also
  // render an .nfc-perm-toast on this shared server.
  const permToast = page.locator('.nfc-perm-toast').filter({ hasText: SEED_TAG })
  await expect(permToast).toHaveCount(1)
  await expect(permToast.locator('.notification-toast-title')).toHaveText('Bash')
  await expect(permToast.locator('.nfc-perm-context')).toContainText('PW NFC fixture session')
  await expect(permToast.locator('.nfc-perm-context')).toContainText('nfc-host')
  await expect(permToast.locator('.nfc-perm-cmd')).toHaveText(BASH_COMMAND)
  await expect(permToast.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(toast('PW NFC hard error')).toHaveCount(1)
  await expect(toast('PW NFC warning only')).toHaveCount(0)
  await expect(toast('PW NFC cron toastless')).toHaveCount(0)
  await expect(toast('PW NFC skill: pw-nfc-toastless-skill')).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/toast-policy.png`, fullPage: true })

  // Deny from the toast rides the same permission route as the panel card.
  await permToast.getByRole('button', { name: 'Deny' }).click()
  await expect(permToast.locator('.nfc-perm-settled')).toHaveText('Denied')
  expect(denied).toMatchObject({ requestId: 'pw-nfc-toast', allow: false })

  // Everything reached the feed exactly once, in its own section.
  const panel = await openCenter(page)
  await showSection(panel, 'Errors')
  await expect(feedItems(panel).filter({ hasText: 'PW NFC hard error' })).toHaveCount(1)
  await expect(feedItems(panel).filter({ hasText: 'PW NFC warning only' })).toHaveCount(1)
  await showSection(panel, 'Automation')
  await expect(feedItems(panel).filter({ hasText: 'PW NFC cron toastless' })).toHaveCount(1)
  await expect(feedItems(panel).filter({ hasText: 'PW NFC skill: pw-nfc-toastless-skill' }))
    .toHaveCount(1)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/feed-only-receipts.png`, fullPage: true })
})

// ── 5. Real permission: live Codex session → enriched record → toast → approve ──

test('a real permission ask arrives enriched and is approved from the toast', async ({ page }) => {
  test.setTimeout(120_000)
  await loadHome(page)
  const draft = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Codex' })

  const quickStart = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const composer = draft.locator('.chat-input-textarea')
  await composer.fill('permission-test from the notification center')
  await composer.press('Enter')
  expect((await quickStart).status()).toBe(200)

  // The toast is the surface under test: tool name, context, the adapter's own
  // option list, answerable in place. Scoped by the mock agent's own tool label —
  // the seeded specs above use `PW NFC`, so neither can match the other.
  const permToast = page.locator('.nfc-perm-toast')
    .filter({ hasText: 'Write file /tmp/mock.txt' })
  await expect(permToast).toBeVisible({ timeout: 40_000 })
  await expect(permToast.locator('.notification-toast-title'))
    .toHaveText('Write file /tmp/mock.txt')
  const allowOnce = permToast.getByRole('button', { name: 'Allow once' })
  await expect(allowOnce).toBeVisible()
  await expect(permToast.getByRole('button', { name: 'Reject' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/real-permission-toast.png`, fullPage: true })

  // The server persisted the ENRICHED record (this is the server.ts hunk).
  const feedRecord = async () => {
    const response = await page.request.get('/api/notifications')
    const body = await response.json() as { feed: FeedRecord[] }
    return body.feed.find((n) => n.kind === 'permission'
      && n.toolName === 'Write file /tmp/mock.txt')
  }
  await expect.poll(async () => {
    const record = await feedRecord()
    return record ? `${record.dedupKey}|${(record.acpOptions ?? []).map((o) => o.optionId).join(',')}` : ''
  }, { timeout: 20_000 }).toMatch(/^perm:.+\|allow-once,reject-once$/)
  const pending = await feedRecord()
  expect(pending?.requestId).toBeTruthy()
  expect(pending?.dedupKey).toBe(`perm:${pending?.requestId}`)
  expect(pending?.sessionId).toBeTruthy()
  expect(pending?.resolved).toBeUndefined()

  await allowOnce.click()

  // The mock ACP agent only prints this after the option actually reached it, so
  // the reply text is the receipt that POST /permission carried the optionId.
  // Asserted as CONTAINMENT, not an exact-text element: the agent's pre- and
  // post-permission chunks belong to one message, so they render in a single
  // merged text block ("about to ask permissionpermission granted: allow-once").
  const panel = page.locator(REAL_PANEL)
  await expect(panel).toContainText('permission granted: allow-once', { timeout: 30_000 })

  // …and the feed entry is stamped settled (server-side + in the panel).
  await expect.poll(async () => (await feedRecord())?.resolved, { timeout: 20_000 })
    .toBe('allowed')
  const center = await openCenter(page)
  await showSection(center, 'All')
  const settled = center.locator('.nfc-perm-card', { hasText: 'Write file /tmp/mock.txt' })
  await expect(settled.locator('.notification-feed-item-resolved').first()).toHaveText('Approved')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/real-permission-approved.png`, fullPage: true })
})
