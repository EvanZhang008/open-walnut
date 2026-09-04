/**
 * One browser, one permission request: a decision taken on ANY surface settles the
 * others in the same frame, without waiting for the server.
 *
 * Regression guarded: a pending permission / AskUserQuestion ask is shown by three
 * surfaces at once — the session timeline card, the notification rail card and the
 * toast — and each used to keep a private `useState` copy and POST
 * `/api/sessions/:id/permission` itself. The timeline card seeded its status ONCE
 * and never re-read it (stream blocks render under index keys, so nothing
 * remounted it), so approving from the rail left Approve/Deny armed in the
 * session; clicking them 404'd, and the card stamped "Denied" on a request the
 * user had just APPROVED.
 *
 * The POST is held for HOLD_MS at the network layer, so any propagation that still
 * rode the round-trip (or its `session:permission-resolved` echo) would fail the
 * sub-second assertions: the server does not even see the request until the hold
 * ends.
 *
 * Everything is page-local: the permission is injected on this page's own
 * WebSocket (the exact frames the server broadcasts) and the session's REST reads
 * are stubbed, so this spec neither reads nor writes shared fixture state.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { showAllSections } from './todo-panel-helpers'

const SESSION_ID = 'pw-question-recovery-session'
const TASK_TITLE = 'Question recovery fixture'
/** Our own request ids — never the fixture's durable one. */
const APPROVE_REQUEST = 'req-perm-store-approve'
const DENY_REQUEST = 'req-perm-store-deny'
const HOLD_MS = 3000
/** How long a same-frame settle may take to reach the other surface. Far below
 *  HOLD_MS, so passing proves it did not wait for the server. */
const INSTANT_MS = 700
const SCREENSHOT_DIR = '/tmp/perm-store-sync'

/** A visibly harmless command: it is never executed, but it lands in screenshots. */
const BASH_COMMAND = 'tar -czf /tmp/perm-store-demo.tgz ./src && echo packaged'

test.describe.configure({ mode: 'serial' })

/** Dispatch a server event frame on the page's real socket. */
async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ eventName, eventData }) => {
    const ws = (window as unknown as { __capturedPermWs?: WebSocket }).__capturedPermWs
    if (!ws) throw new Error('Permission test WebSocket was not captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: eventName, data: eventData, seq: Date.now() }),
    }))
  }, { eventName: name, eventData: data })
}

/**
 * Per-request marker, carried in `reason` because that is the ONE field both
 * surfaces print without being expanded: the timeline card keeps the tool input
 * behind its "Input" toggle, so a marker hidden in there is unaddressable.
 */
const MARKER = (requestId: string): string => `ask ${requestId}`

/** The pending ask, as the session stream lane delivers it. */
function permissionRequest(requestId: string) {
  return {
    sessionId: SESSION_ID,
    requestId,
    toolName: 'Bash',
    input: { command: BASH_COMMAND, description: 'Package the demo directory' },
    reason: MARKER(requestId),
  }
}

/** The same ask, as the enriched feed record the notification lane delivers. */
function permissionRecord(requestId: string) {
  return {
    id: `notif-${requestId}`,
    kind: 'permission',
    severity: 'warning',
    title: 'Bash',
    body: BASH_COMMAND,
    timestamp: Date.now(),
    read: false,
    dedupKey: `perm:${requestId}`,
    requestId,
    toolName: 'Bash',
    sessionId: SESSION_ID,
    input: { command: BASH_COMMAND, description: 'Package the demo directory' },
    reason: MARKER(requestId),
    host: 'perm-store-host',
    sessionTitle: 'Pending question recovery',
    project: 'Walnut',
  }
}

async function openSessionColumn(page: Page): Promise<Locator> {
  await showAllSections(page)
  const task = page.locator('.todo-panel-item', { hasText: TASK_TITLE })
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()

  const detail = page.locator('.task-detail-modal')
  await expect(detail).toBeVisible()
  await detail.locator(`.todo-detail-session-item[title="${SESSION_ID}"]`).click()
  await detail.getByRole('button', { name: 'Close detail panel' }).click()

  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

/** Open the notification center and land on Needs Action. */
async function openNeedsAction(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Needs Action' }).click()
  return panel
}

/** The rail card for one request (scoped by its marker). */
const railCard = (panel: Locator, requestId: string): Locator =>
  panel.locator('.nfc-perm-card').filter({ hasText: MARKER(requestId) })

/** The session timeline card for one request (same marker). */
const timelineCardFor = (panel: Locator, requestId: string): Locator =>
  panel.locator('.permission-request-card').filter({ hasText: MARKER(requestId) })

test('a permission answered on one surface settles the others before the server answers', async ({ page }) => {
  test.setTimeout(120_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })

  // Capture the app's own socket so server frames can be injected verbatim.
  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class PermTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        const holder = window as unknown as { __capturedPermWs?: WebSocket }
        if (socketUrl.pathname === '/ws' && !holder.__capturedPermWs) holder.__capturedPermWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] =
          (original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants already exist on the subclass.
      }
    }
  })

  // The fixture session carries a durable AskUserQuestion of its own; stub it away
  // so the only cards on screen are the two this spec injects.
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-question-recovery',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: new Date(Date.now() - 180_000).toISOString(),
          lastActiveAt: new Date().toISOString(),
          messageCount: 1,
          title: 'Pending question recovery',
        },
        pendingPermissions: [],
      },
    })
  })
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({ json: { messages: [], cursor: 0, delta: false } })
  })

  // Hold every permission POST at the network layer for HOLD_MS. Nothing the
  // server does — including the `session:permission-resolved` broadcast — can
  // reach the page before the hold ends.
  const answered: Array<Record<string, unknown>> = []
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    await new Promise((r) => setTimeout(r, HOLD_MS))
    answered.push(body)
    await route.fulfill({ json: { status: 'resolved', requestId: body.requestId, allow: body.allow } })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const panel = await openSessionColumn(page)

  // ── Both surfaces mounted, showing the SAME request ──
  await injectEvent(page, 'session:permission-request', permissionRequest(APPROVE_REQUEST))
  await injectEvent(page, 'notification:new', permissionRecord(APPROVE_REQUEST))

  const timelineCard = panel.locator('.permission-request-card')
  await expect(timelineCard).toHaveCount(1, { timeout: 20_000 })
  await expect(timelineCard.getByRole('button', { name: 'Allow' })).toBeVisible()
  // The toast is the third surface, and it is answerable too.
  const toast = page.locator('.nfc-perm-toast')
  await expect(toast).toBeVisible({ timeout: 20_000 })

  const center = await openNeedsAction(page)
  const card = railCard(center, APPROVE_REQUEST)
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card.getByRole('button', { name: 'Approve' })).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-three-surfaces-pending.png` })

  // ── 1. Approve in the RAIL → the timeline card settles, same frame ──
  await card.getByRole('button', { name: 'Approve' }).click()

  await expect(timelineCard).toContainText('Allowed', { timeout: INSTANT_MS })
  // The exact reported symptom: the timeline kept offering the buttons, and
  // pressing them 404'd into a "Denied" stamp on an APPROVED request.
  await expect(timelineCard.getByRole('button', { name: 'Allow' })).toHaveCount(0)
  await expect(timelineCard.getByRole('button', { name: 'Deny' })).toHaveCount(0)
  await expect(timelineCard).not.toContainText('Denied')
  // …and the toast stops offering a decision it no longer owns.
  await expect(page.locator('.nfc-perm-toast button', { hasText: 'Approve' })).toHaveCount(0)
  expect(answered, 'the server has not even seen the POST yet').toHaveLength(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-rail-approve-settled-timeline.png` })

  // ── 2. Release the hold: the echo must not undo the decision ──
  await expect.poll(() => answered.length, { timeout: HOLD_MS * 3 }).toBe(1)
  expect(answered[0]).toMatchObject({ requestId: APPROVE_REQUEST, allow: true })
  await page.waitForTimeout(1000)
  await expect(timelineCard).toContainText('Allowed')
  await expect(timelineCard).not.toContainText('Denied')
  await expect(card).toContainText('Approved')
  await expect(card.getByRole('button', { name: 'Approve' })).toHaveCount(0)

  // ── 3. The other direction, answered from the TOAST ──
  // The toast is the surface on TOP (z-index 9999, above the center's backdrop),
  // so it is the one that can be clicked while the rail card and the timeline card
  // both stay mounted underneath it. Denying there has to settle both.
  await injectEvent(page, 'session:permission-request', permissionRequest(DENY_REQUEST))
  await injectEvent(page, 'notification:new', permissionRecord(DENY_REQUEST))

  const secondTimelineCard = timelineCardFor(panel, DENY_REQUEST)
  await expect(secondTimelineCard.getByRole('button', { name: 'Deny' })).toBeVisible({ timeout: 20_000 })
  // Two asks from ONE session collapse into a same-origin group in the rail, so
  // the second card is behind "Show 1 more" until the group is expanded.
  const expand = center.locator('.notification-group-toggle').first()
  if (await expand.count() > 0) await expand.click()
  const secondRailCard = railCard(center, DENY_REQUEST)
  await expect(secondRailCard.getByRole('button', { name: 'Approve' })).toBeVisible({ timeout: 20_000 })

  // The first ask's toast settled and left, so this is the second ask's toast.
  const secondToast = page.locator('.nfc-perm-toast')
  await expect(secondToast).toHaveCount(1, { timeout: 20_000 })
  await secondToast.getByRole('button', { name: 'Deny' }).click()

  await expect(secondRailCard).toContainText('Denied', { timeout: INSTANT_MS })
  await expect(secondTimelineCard).toContainText('Denied', { timeout: INSTANT_MS })
  await expect(secondRailCard.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await expect(secondTimelineCard.getByRole('button', { name: 'Allow' })).toHaveCount(0)
  expect(answered, 'the second POST is still held too').toHaveLength(1)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-toast-deny-settled-rail-and-timeline.png` })

  await expect.poll(() => answered.length, { timeout: HOLD_MS * 3 }).toBe(2)
  expect(answered[1]).toMatchObject({ requestId: DENY_REQUEST, allow: false })
  await page.waitForTimeout(1000)
  await expect(secondRailCard).toContainText('Denied')
  await expect(secondTimelineCard).toContainText('Denied')

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})

/**
 * The 404 path, which is the reason `stale` exists as its OWN outcome: a request
 * that settled somewhere this browser never saw (another tab, the phone, the turn
 * dying) must read "Already answered", never "Denied" — the timeline card used to
 * claim the user had denied something they may well have approved.
 */
test('a request that settled elsewhere reads "Already answered", not "Denied"', async ({ page }) => {
  test.setTimeout(120_000)
  const REQUEST = 'req-perm-store-stale'

  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class PermStaleWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        const holder = window as unknown as { __capturedPermWs?: WebSocket }
        if (socketUrl.pathname === '/ws' && !holder.__capturedPermWs) holder.__capturedPermWs = this
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] =
          (original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants already exist on the subclass.
      }
    }
  })

  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-question-recovery',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: new Date(Date.now() - 180_000).toISOString(),
          lastActiveAt: new Date().toISOString(),
          messageCount: 1,
          title: 'Pending question recovery',
        },
        pendingPermissions: [],
      },
    })
  })
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({ json: { messages: [], cursor: 0, delta: false } })
  })
  // The request is gone server-side — exactly what answering it elsewhere leaves.
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, async (route) => {
    await route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'no such permission request' } },
    })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionColumn(page)
  await injectEvent(page, 'session:permission-request', permissionRequest(REQUEST))

  const timelineCard = panel.locator('.permission-request-card')
  await expect(timelineCard.getByRole('button', { name: 'Allow' })).toBeVisible({ timeout: 20_000 })
  await timelineCard.getByRole('button', { name: 'Allow' }).click()

  await expect(timelineCard).toContainText('Already answered', { timeout: 15_000 })
  await expect(timelineCard).not.toContainText('Denied')
  // Settled, not re-armed: the zombie-card loop (2026-08-11) was the user clicking
  // Approve into a 404 eight times.
  await expect(timelineCard.getByRole('button', { name: 'Allow' })).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-stale-not-denied.png` })
})
