/**
 * Playwright: what a late "delivered" does to the bubbles, and the waiting note
 * across a reload. Same harness as bubble-merged-batch.spec.ts: the real SPA and
 * composer, the WS send RPC answered in the page, server events injected on the
 * socket.
 *
 * B1 (round 2 gate): the server could not confirm message A (a failed bubble,
 * "Send failed … Retry") and held B behind it. The CLI then reported taking A,
 * and the runner said so for A alone. The web matched no id (failed bubbles were
 * skipped), fell back to marking by count, and showed B "Delivered" while A kept
 * its red error, so the user retried A and it ran twice. A delivery names its
 * bubbles by id and marks nothing else.
 *
 * P2: a message held behind one still being confirmed reads "Waiting to confirm
 * the previous message"; a reloaded panel reads the hold back from the queue.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-late-delivered-session'
const TASK_ID = 'pw-late-delivered-task'

interface QueueRow { id: string; message: string; status: string; enqueuedAt: string; heldReason?: string }

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    if (!ws) throw new Error('No captured WebSocket')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }))
  }, { name, data })
}

async function sendViaUi(page: Page, text: string) {
  const input = page.locator('textarea[placeholder*="Send a message to this session"]').first()
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

const sentIds = (page: Page) => page.evaluate(() => (window as any).__sentMessageIds as string[])

/** Load the session panel. `queue`: what session:get-queue answers; `replyMs`: how late the send RPC answers. */
async function open(page: Page, opts: { queue?: QueueRow[]; replyMs?: number } = {}) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(({ queue, replyMs }) => {
    (window as any).__sentMessageIds = []
    const Orig = window.WebSocket
    window.WebSocket = class extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = new URL(String(url), window.location.href)
        if (u.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this
          const origSend = this.send.bind(this)
          let n = 0
          const answer = (id: unknown, payload: unknown, ms: number) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'res', id, ok: true, payload }),
          })), ms)
          this.send = (data: any) => {
            let intercepted = false
            try {
              const p = JSON.parse(data as string)
              if (p.type === 'req' && p.method === 'session:send') {
                intercepted = true
                const messageId = `qm-late${++n}`
                ;(window as any).__sentMessageIds.push(messageId)
                answer(p.id, { messageId }, replyMs)
              }
              if (p.type === 'req' && p.method === 'session:stream-subscribe') {
                intercepted = true
                answer(p.id, { blocks: [], isStreaming: false }, 10)
              }
              if (p.type === 'req' && p.method === 'session:get-queue' && p.payload?.sessionId === 'pw-late-delivered-session') {
                intercepted = true
                answer(p.id, { messages: queue }, 10)
              }
            } catch { /* not JSON */ }
            if (!intercepted) origSend(data)
          }
        }
      }
    } as any
    for (const key of Object.getOwnPropertyNames(Orig)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (Orig as any)[key] } catch { /* read-only */ }
      }
    }
  }, { queue: opts.queue ?? [], replyMs: opts.replyMs ?? 10 })
  const history = [
    { role: 'user', text: 'earlier question', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: 'earlier answer', timestamp: '2026-01-01T00:00:10.000Z' },
  ]
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) =>
    route.fulfill({ json: { messages: history, cursor: history.length, delta: false } }))
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({ json: { session: {
      claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut', process_status: 'running', mode: 'bypass',
      startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'Late delivered',
    } } })
  })
  await page.goto(`/sessions?id=${SESSION_ID}`)
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 30_000 })
  await expect(page.locator('.session-history')).toContainText('earlier answer', { timeout: 30_000 })
  await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Working on it', taskId: TASK_ID })
}

test('B1: an unconfirmed message the CLI later took is marked delivered, and no other bubble is', async ({ page }) => {
  await open(page)
  await sendViaUi(page, 'unconfirmed first')
  await sendViaUi(page, 'still waiting second')
  await expect.poll(() => sentIds(page)).toHaveLength(2)
  const [a, b] = await sentIds(page)
  const unconfirmed = 'Delivery unconfirmed: the host never said whether the message reached the session (daemon command timeout)'
  await injectEvent(page, 'session:batch-failed', { sessionId: SESSION_ID, messageIds: [a], error: unconfirmed })
  await injectEvent(page, 'session:delivery-held', { sessionId: SESSION_ID, messageIds: [b], reason: 'Waiting to confirm the previous message' })
  await expect(page.locator('.session-msg-failed')).toHaveCount(1)
  await expect(page.getByText(unconfirmed).first()).toBeVisible()

  // The CLI reports taking A: the runner says so for A alone (releaseLineRows / takeUnconfirmed).
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [a], turnGen: 1 })

  await expect(page.locator('.session-msg-delivered').filter({ hasText: 'unconfirmed first' })).toHaveCount(1)
  await expect(page.locator('.session-msg-failed')).toHaveCount(0)
  // B was never written: still waiting, with its note, not "Delivered".
  const second = page.locator('.session-msg-received').filter({ hasText: 'still waiting second' })
  await expect(second).toHaveCount(1)
  await expect(second.locator('.session-msg-held-note')).toHaveCount(1)
  await expect(page.locator('.session-msg-delivered').filter({ hasText: 'still waiting second' })).toHaveCount(0)
  // Nothing failed any more: the red error line is gone, and there is no Retry to run A twice.
  await expect(page.getByText(unconfirmed)).toHaveCount(0)
  await expect(page.locator('.session-history').getByRole('button', { name: /retry/i })).toHaveCount(0)

  // B goes out once A is confirmed.
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [b], turnGen: 1 })
  await expect(page.locator('.session-msg-delivered')).toHaveCount(2)
  await expect(page.locator('.session-msg-held-note')).toHaveCount(0)
})

test('a delivery that beats the send RPC answer lands on its own bubble when the id arrives', async ({ page }) => {
  await open(page, { replyMs: 1500 })
  await sendViaUi(page, 'answered late')
  await expect.poll(() => sentIds(page)).toHaveLength(1)
  const [a] = await sentIds(page)
  // The bubble still carries its client id; the server already wrote the line.
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [a], turnGen: 1 })
  await expect(page.locator('.session-msg-delivered').filter({ hasText: 'answered late' })).toHaveCount(1, { timeout: 10_000 })
  await page.waitForTimeout(300)
  await expect(page.locator('.session-msg-received').filter({ hasText: 'answered late' })).toHaveCount(0)
})

test('P2: a reloaded panel shows a held message as waiting, not delivered', async ({ page }) => {
  const at = new Date().toISOString()
  await open(page, { queue: [
    { id: 'qm-sent', message: 'went out, being confirmed', status: 'processing', enqueuedAt: at },
    { id: 'qm-held', message: 'held behind it', status: 'processing', enqueuedAt: at, heldReason: 'Waiting to confirm the previous message' },
  ] })
  const held = page.locator('.session-msg-received').filter({ hasText: 'held behind it' })
  await expect(held).toHaveCount(1)
  await expect(held.locator('.session-msg-held-note')).toHaveText('Waiting to confirm the previous message')
  await expect(page.locator('.session-msg-delivered').filter({ hasText: 'went out, being confirmed' })).toHaveCount(1)
  // Its line goes out: the note goes with the waiting.
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: ['qm-held'], turnGen: 1 })
  await expect(page.locator('.session-msg-held-note')).toHaveCount(0)
  await expect(page.locator('.session-msg-delivered').filter({ hasText: 'held behind it' })).toHaveCount(1)
})
