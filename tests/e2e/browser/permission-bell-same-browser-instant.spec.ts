/**
 * The bell's count drops the moment an ask is answered, wherever it is answered (2026-11-19: answered
 * from its timeline card, the bell kept its number until the server's `session:permission-resolved`
 * came back, a round trip and sometimes seconds later on a stalled server).
 *
 * The request's state is one store (web/src/stores/permission-request-store.ts) that every answer
 * path writes before its request leaves; the bell counts the feed with that store laid over it
 * (web/src/contexts/notifications/settled-asks.ts). Proven by holding the answer POST at the
 * network layer: the server cannot have answered, and the bell has moved.
 *
 * Scenario matrix (Home with one session column; the feed holds one pending Bash ask and one unread
 * letter, so the bell counts both):
 *  1. Allow on the timeline card with the POST held: the bell reads 1 inside INSTANT_MS with zero
 *     answers; after the release, in no frame of the next 2.5 s does it read 2 again.
 *  2. Allow refused (502, after the page's own retries): the bell reads 2 again and the card offers
 *     the ask again.
 * The feed is the test's own (its GET is stubbed) and the prompt is injected on the page's socket
 * as the frame the server broadcasts; the counts are read relative to the bell before the click.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import type { FeedRecord } from '../../../web/src/contexts/notifications/NotificationProvider'
import { serveNoWaitingApprovals } from './approvals-lock'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID = 'pw-bell-instant-session'
const TASK_ID = 'pw-task-bell-instant'
const INSTANT_MS = 700
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.use({ viewport: { width: 1280, height: 860 } })

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const panel = (page: Page) => page.locator(`.session-panel[data-session-id="${SID}"]`).first()
const badge = (page: Page) => page.locator('.sidebar-notification-btn .notification-badge-count')

function feedOf(requestId: string): FeedRecord[] {
  const t = Date.now()
  return [
    { id: `n-${requestId}`, kind: 'permission', severity: 'warning', title: 'Bash', body: 'npm test', timestamp: t - 30_000, read: false,
      dedupKey: `perm:${requestId}`, requestId, toolName: 'Bash', sessionId: SID, taskId: TASK_ID },
    { id: 'n-letter', kind: 'letter', severity: 'info', title: 'A letter', timestamp: t - 20_000, read: false, dedupKey: 'letter:pw-bell-l1', letterId: 'pw-bell-l1' },
  ] as FeedRecord[]
}

/** Home with the session's column, the feed above, and the ask on its timeline card. */
async function setup(page: Page, requestId: string, answer: (route: Route) => Promise<void>): Promise<void> {
  await isolateUiPrefs(page)
  // Capture the page's socket so the prompt can be injected as the frame the server broadcasts.
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
    const Original = window.WebSocket
    class Captured extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __bellWs?: WebSocket }
        if (new URL(String(url), location.href).pathname === '/ws' && !holder.__bellWs) holder.__bellWs = this
      }
    }
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (Captured as unknown as Record<string, unknown>)[key] = (Original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
    window.WebSocket = Captured as typeof WebSocket
  })
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { feed: feedOf(requestId), unreadCount: 2 } }))
  await page.route('**/api/notifications/mark-read', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await serveNoWaitingApprovals(page)
  await page.route(`**/api/sessions/${SID}`, (route) => route.fulfill({
    json: {
      session: {
        claudeSessionId: SID, taskId: TASK_ID, project: 'Walnut', process_status: 'running', mode: 'default',
        startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: 2, title: 'Bell fixture',
      },
      pendingPermissions: [],
    },
  }))
  const messages = [
    { role: 'user', text: 'Run the tests.', timestamp: iso(60_000), msgId: 'u-1' },
    { role: 'assistant', text: 'Running them now.', timestamp: iso(59_000), msgId: 'a-1' },
  ]
  await page.route(`**/api/sessions/${SID}/history**`, (route) => route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  await page.route(`**/api/sessions/${SID}/permission`, answer)
  await page.goto(`/?s1=${SID}`)
  await expect(panel(page)).toBeVisible({ timeout: 30_000 })
  await expect(panel(page).locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 20_000 })
  await page.evaluate((d) => {
    const ws = (window as unknown as { __bellWs?: WebSocket }).__bellWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: 'session:permission-request', data: d, seq: Date.now() }) }))
  }, { sessionId: SID, taskId: TASK_ID, requestId, toolName: 'Bash', input: { command: 'npm test' }, reason: 'This command requires approval' })
  await expect(badge(page)).toHaveText(/^\d+$/, { timeout: 20_000 })
}

/** The bell's number now. */
const count = async (page: Page) => Number(await badge(page).textContent())

/** Record every animation frame's bell count from now on; the reader gives the counts seen. */
async function watchBell(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen = new Set<string>()
    const w = window as unknown as { __bellSeen?: Set<string> }
    w.__bellSeen = seen
    const tick = () => {
      if (w.__bellSeen !== seen) return
      seen.add(document.querySelector('.sidebar-notification-btn .notification-badge-count')?.textContent ?? 'none')
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  return () => page.evaluate(() => [...((window as unknown as { __bellSeen?: Set<string> }).__bellSeen ?? [])])
}

test('an ask allowed on its timeline card leaves the bell before the server has answered', async ({ page }) => {
  const requestId = 'pw-bell-held'
  let sent = 0
  let answered = 0
  let open = false
  const held: Route[] = []
  await setup(page, requestId, async (route) => {
    sent += 1
    const reply = () => route.fulfill({ json: { status: 'resolved', requestId, allow: true } })
    if (open) { await reply(); answered += 1; return }
    held.push(route)
  })
  const card = panel(page).locator(`.permission-request-card[data-request-id="${requestId}"]`)
  await expect(card.locator('button.permission-request-btn')).toHaveCount(2)
  const before = await count(page)
  expect(before).toBeGreaterThanOrEqual(2)
  await card.locator('button.permission-request-btn').first().click()
  await expect(badge(page)).toHaveText(String(before - 1), { timeout: INSTANT_MS })
  await expect.poll(() => sent, { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
  expect(answered, 'the server answered before the bell moved').toBe(0)
  await page.locator('.sidebar-notification-btn').screenshot({ path: `${SHOTS}/permission-bell-held-${test.info().project.name}.png` }).catch(() => {})

  const seen = await watchBell(page)
  await page.waitForTimeout(1_500)
  open = true
  for (const r of held.splice(0)) { await r.fulfill({ json: { status: 'resolved', requestId, allow: true } }); answered += 1 }
  await page.waitForTimeout(2_500)
  await expect(badge(page)).toHaveText(String(before - 1))
  expect(await seen(), 'the bell counted the answered ask again').toEqual([String(before - 1)])
})

test('an answer the server refuses brings the ask back into the bell', async ({ page }) => {
  const requestId = 'pw-bell-refused'
  let refusals = 0
  await setup(page, requestId, async (route) => {
    await new Promise((r) => setTimeout(r, 1_200))
    refusals += 1
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'bad gateway' }) })
  })
  const card = panel(page).locator(`.permission-request-card[data-request-id="${requestId}"]`)
  await expect(card.locator('button.permission-request-btn')).toHaveCount(2)
  const before = await count(page)
  await card.locator('button.permission-request-btn').first().click()
  await expect(badge(page)).toHaveText(String(before - 1), { timeout: INSTANT_MS })
  expect(refusals).toBe(0)
  await expect(badge(page)).toHaveText(String(before), { timeout: 20_000 })
  expect(refusals).toBeGreaterThanOrEqual(1)
  await expect(card.locator('button.permission-request-btn').first()).toBeEnabled()
})
