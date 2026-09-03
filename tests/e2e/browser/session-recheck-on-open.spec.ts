/**
 * Playwright browser test: opening a session that sits in `error` must RE-CHECK
 * the host, and the banner must stop asserting something the recheck disproved.
 *
 * Reported bug (2026-09-03): a remote session's record froze in
 * process_status 'error' with a stale "Connection lost — unable to reach remote
 * host" for over two hours AFTER the SSH tunnel reconnected. The user could open
 * that same session's Files tab and read remote files fine, while the banner kept
 * insisting the host was gone. Two user asks came out of it:
 *   1. "at least when I open it, it should go check whether it's connected"
 *   2. "I only click retry and it will send a `continue` to the session. I don't
 *      want it. I just wanted to connect."
 *
 * What this spec drives with real clicks:
 *   - the recheck fires ONCE on open (not per render, not per remount);
 *   - the banner shows a brief "Checking connection…" and the session content
 *     stays interactive (no blocking spinner);
 *   - once the host is proven reachable the banner says so instead of repeating
 *     the unreachability claim;
 *   - the action button reads "Reconnect", and using it neither swaps the session
 *     nor adds any message to the conversation.
 *
 * Only the three session HTTP responses are shaped (the fixture session is
 * healthy, so 'error' has to be injected); every click, every render and both
 * effects are the real app. The server-side contract is pinned separately in
 * tests/core/session-recheck.test.ts + session-retry-reconnect.test.ts, and the
 * live route is smoke-checked here through a real POST.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/session-recheck'
const FROZEN_ERROR = 'Connection lost — unable to reach remote host'

test.use({ viewport: { width: 1280, height: 860 } })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/**
 * Make the fixture session look frozen-in-error to the whole app.
 *
 * BOTH responses must be shaped: the panel renders its REST record, but
 * `resolveSessionRecordStatus` overlays the session-status store, which the
 * homepage hydrates from /api/sessions/status with a VERSIONED snapshot — an
 * unversioned detail alone would be overruled (and logged as "rejected
 * unversioned input after versioned snapshot").
 */
async function freezeSessionInError(page: Page): Promise<void> {
  // Regexes, not globs: the detail path is a PREFIX of /history, /recheck and
  // /retry, and each of those needs its own (or no) handler.
  await page.route(/\/api\/sessions\/pw-vscode-session(\?|$)/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { session?: Record<string, unknown> }
    await route.fulfill({
      json: {
        ...body,
        session: {
          ...(body.session ?? {}),
          host: 'devhost',
          hostname: 'devhost.example',
          process_status: 'error',
          errorMessage: FROZEN_ERROR,
        },
      },
    })
  })
  await page.route(/\/api\/sessions\/status\?/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { statuses?: Record<string, Record<string, unknown>> }
    const statuses = { ...(body.statuses ?? {}) }
    const existing = statuses[SESSION_ID]
    if (existing) {
      statuses[SESSION_ID] = {
        ...existing,
        process_status: 'error',
        errorMessage: FROZEN_ERROR,
        // Beat any snapshot the app already holds for this session.
        statusRevision: Number(existing.statusRevision ?? 0) + 1000,
        statusUpdatedAt: new Date().toISOString(),
      }
    }
    await route.fulfill({ json: { ...body, statuses } })
  })
}

/** Count + shape the recheck answer. `delayMs` makes the checking state observable. */
async function stubRecheck(
  page: Page,
  answer: Record<string, unknown>,
  counter: { n: number },
  delayMs = 0,
): Promise<void> {
  await page.route(/\/api\/sessions\/pw-vscode-session\/recheck$/, async (route) => {
    counter.n += 1
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    await route.fulfill({ json: { sessionId: SESSION_ID, ...answer } })
  })
}

/** Open the fixture session's panel from the homepage — real clicks, no deep link. */
async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  // Positional, not by label: the session row's text is derived from live state.
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

// This box runs several agent sessions at once; at load >100 the first paint alone
// can take ~30s, which is a starvation artifact rather than a product timeout.
test.describe.configure({ timeout: 90_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  // Not `networkidle`: the homepage keeps polling (status, projects, streams), so
  // idle may never arrive. Wait for the control every test clicks first instead.
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
})

test('opening an error session re-checks the host once and the banner stops claiming unreachability', async ({ page }) => {
  const calls = { n: 0 }
  await freezeSessionInError(page)
  await stubRecheck(page, {
    checked: true, reachable: true, alive: false, processStatus: 'error', infraClaim: true,
  }, calls, 1200)

  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner').first()

  // 1. The recheck announces itself without blocking the panel. (The stale claim
  //    the user starts from is only on the FIRST paint here — the effect fires
  //    before Playwright can poll for it, which is the point of the feature — so
  //    that starting state is pinned in the remount test below, where the answer
  //    disproves nothing and the sentence stays put.)
  await expect(banner).toContainText('Checking connection', { timeout: 8000 })
  await expect(panel.locator('.session-error-banner--reconnecting')).toHaveCount(1)
  // The session stays usable while the check runs (no overlay, composer alive).
  await expect(panel.locator('.chat-input-textarea').first()).toBeEnabled()
  await banner.screenshot({ path: `${SCREENSHOT_DIR}/banner-checking.png` })

  // 2. Host proven reachable → the banner tells the truth instead of repeating
  //    the stale sentence, and drops the alarming red styling.
  await expect(banner).toContainText('is reachable', { timeout: 10_000 })
  await expect(banner).not.toContainText('unable to reach remote host')
  await expect(banner).toContainText('Send a message to resume')
  await expect(panel.locator('.session-error-banner--idle')).toHaveCount(1)
  await banner.screenshot({ path: `${SCREENSHOT_DIR}/banner-reachable.png` })

  // 3. The action reads as a reconnect, not as "run something".
  await expect(banner.locator('.session-retry-btn')).toHaveText('Reconnect')

  // 4. Exactly one recheck for one open.
  expect(calls.n, 'recheck must fire once per open, not per render').toBe(1)
})

test('a panel remount inside the cooldown does not fire a second recheck', async ({ page }) => {
  const calls = { n: 0 }
  await freezeSessionInError(page)
  await stubRecheck(page, {
    checked: false, reachable: false, processStatus: 'error', infraClaim: true,
    reason: 'no_pooled_connection',
  }, calls)

  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner').first()
  // A recheck that proves nothing leaves the reported sentence exactly as it was.
  await expect(banner).toContainText('Connection lost')
  await banner.screenshot({ path: `${SCREENSHOT_DIR}/banner-stale-claim.png` })
  await expect.poll(() => calls.n, { timeout: 8000 }).toBe(1)

  // Close the column and open the same session again — a real remount.
  await panel.locator('button[aria-label="Close session panel"]').click()
  await expect(page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)).toHaveCount(0)
  const reopened = await openSessionPanel(page)
  await expect(reopened.locator('.session-error-banner').first()).toBeVisible()

  // Give the effect every chance to misfire before asserting it did not.
  await page.waitForTimeout(1500)
  expect(calls.n, 'the once-per-open claim must survive a remount').toBe(1)
  await reopened.screenshot({ path: `${SCREENSHOT_DIR}/panel-remount-single-recheck.png` })
})

test('Reconnect keeps the same session and adds nothing to the conversation', async ({ page }) => {
  const calls = { n: 0 }
  await freezeSessionInError(page)
  await stubRecheck(page, {
    checked: false, reachable: false, processStatus: 'error', infraClaim: true,
    reason: 'no_pooled_connection',
  }, calls)

  // The empty-queue reconnect outcome: no turn, conversation preserved.
  let retryCalls = 0
  await page.route(/\/api\/sessions\/pw-vscode-session\/retry$/, async (route) => {
    retryCalls += 1
    await route.fulfill({ json: { status: 'resumable', sessionId: SESSION_ID } })
  })
  // A session message rides the WS RPC (`session:send`), not REST — so watch the
  // socket. Reconnect must not produce one.
  const sendFrames: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.includes('session:send')) {
        sendFrames.push(frame.payload)
      }
    })
  })

  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner').first()

  // The conversation loads asynchronously (history fetch + stream snapshot), so
  // wait for the row count to SETTLE before recording it — comparing against a
  // still-loading list would call the fixture's own history "new messages".
  const rows = panel.locator('[data-msg-index]')
  let messagesBefore = -1
  await expect
    .poll(async () => {
      const n = await rows.count()
      const settled = n > 0 && n === messagesBefore
      messagesBefore = n
      return settled
    }, { timeout: 20_000, intervals: [400, 400, 400, 400, 600, 600, 1000] })
    .toBe(true)

  await banner.locator('.session-retry-btn').click()
  await expect.poll(() => retryCalls, { timeout: 8000 }).toBe(1)

  // Same session (no swap to a fresh one) and no new message rows.
  await expect(page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)).toHaveCount(1)
  // Reconnect refetches the record, so allow the list to re-settle, then hold it
  // to the same length: an injected turn would have added rows that stay.
  await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(messagesBefore)
  await page.waitForTimeout(1500)
  expect(await rows.count()).toBe(messagesBefore)
  await expect(panel.locator('.session-history')).not.toContainText(/^continue$/)
  expect(sendFrames, 'Reconnect must never send a message').toEqual([])
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/reconnect-no-message.png` })
})

test('the real /recheck route answers a bounded, honest shape', async ({ page }) => {
  // No mocks: this is the server endpoint the panel calls, against the fixture's
  // own (healthy, local) session record.
  const started = Date.now()
  const response = await page.request.post(`/api/sessions/${SESSION_ID}/recheck`)
  const elapsed = Date.now() - started
  expect(response.status()).toBe(200)
  const body = await response.json() as Record<string, unknown>
  expect(body).toMatchObject({ sessionId: SESSION_ID })
  expect(typeof body.checked).toBe('boolean')
  expect(typeof body.reachable).toBe('boolean')
  expect(typeof body.infraClaim).toBe('boolean')
  expect(['running', 'idle', 'stopped', 'error']).toContain(body.processStatus)
  // The route owns its own deadline (one 5s daemon RPC); it must never hang.
  expect(elapsed).toBeLessThan(15_000)

  // Unknown session → 404, not a 500.
  const missing = await page.request.post('/api/sessions/pw-no-such-session/recheck')
  expect(missing.status()).toBe(404)
})
