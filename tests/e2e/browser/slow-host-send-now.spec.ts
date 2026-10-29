/**
 * Playwright: a message the host did not take in time reads as a wait, never as
 * "Send failed", and Send now sends it at once.
 *
 * 2026-10-29: every `ps` on the Mac hung for 17 minutes, each session start waited
 * on one, and a message to a stopped task read "Send failed: daemon command
 * timeout: start (30000ms)" plus a "Session error" row while it sat in the queue.
 * The server now holds such rows on a clock (claude-code-session.ts
 * armSlowHostRetry) and says so with session:delivery-held { reason, retryAt }.
 * Same harness as bubble-late-delivered.spec.ts: the real SPA and composer, the WS
 * send RPC answered in the page, server events injected on the socket.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-slow-host-session'
const TASK_ID = 'pw-slow-host-task'
const REASON = 'Not sent yet: the computer running this session did not start it in time (it may be very busy). Your message is kept and Walnut tries again by itself.'

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
                const messageId = p.payload?.retryOf || `qm-slow${++n}`
                ;(window as any).__sentMessageIds.push(messageId)
                ;((window as any).__sendPayloads ??= []).push(p.payload)
                answer(p.id, { messageId }, replyMs)
              }
              if (p.type === 'req' && p.method === 'session:stream-subscribe') {
                intercepted = true
                answer(p.id, { blocks: [], isStreaming: false }, 10)
              }
              if (p.type === 'req' && p.method === 'session:get-queue' && p.payload?.sessionId === 'pw-slow-host-session') {
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
      startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'Slow host',
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


const payloads = (page: Page) => page.evaluate(() => ((window as any).__sendPayloads ?? []) as Array<Record<string, unknown>>)

test('a start the host did not answer in time: a plain wait with the next try, and Send now', async ({ page }) => {
  await open(page)
  await sendViaUi(page, 'why is Slack empty')
  await expect.poll(() => sentIds(page)).toHaveLength(1)
  const [id] = await sentIds(page)
  const retryAt = new Date(Date.now() + 15_000).toISOString()
  await injectEvent(page, 'session:delivery-held', { sessionId: SESSION_ID, messageIds: [id], reason: REASON, retryAt })
  await injectEvent(page, 'session:error', { sessionId: SESSION_ID, taskId: TASK_ID, error: REASON, errorKind: 'delivery_failed', retryAt })

  const bubble = page.locator('.session-msg-received').filter({ hasText: 'why is Slack empty' })
  await expect(bubble).toHaveCount(1)
  const note = bubble.locator('.session-msg-held-note')
  await expect(note).toContainText('Not sent yet:')
  await expect(note).toContainText(/Next try at \d/)
  // Never a failed send or an error row while it waits.
  await expect(page.locator('.session-msg-failed')).toHaveCount(0)
  await expect(page.getByText('Send failed')).toHaveCount(0)
  await expect(page.locator('.session-history').getByText('Session error')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/slow-host-send-now/01-waiting.png' })

  await bubble.getByRole('button', { name: 'Send now' }).click()
  // One press: the button gives way to "Sending…" until the server says more.
  await expect(bubble.getByRole('button', { name: 'Send now' })).toHaveCount(0)
  await expect(note).toContainText('Sending…')
  await expect.poll(async () => (await payloads(page)).length).toBe(2)
  const again = (await payloads(page))[1]
  // The same row is drained again: no second copy of the words.
  expect(again.retryOf).toBe(id)
  expect(again.message).toBe('why is Slack empty')
  await expect(page.locator('.session-msg-received').filter({ hasText: 'why is Slack empty' })).toHaveCount(1)

  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [id], turnGen: 1 })
  await expect(page.locator('.session-msg-delivered').filter({ hasText: 'why is Slack empty' })).toHaveCount(1)
  await expect(page.locator('.session-msg-held-note')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/slow-host-send-now/02-delivered.png' })
})

test('a reloaded panel reads the wait back and still offers Send now', async ({ page }) => {
  await open(page, { queue: [
    { id: 'qm-waiting', message: 'kept across a reload', status: 'pending', enqueuedAt: new Date().toISOString(), heldReason: REASON },
  ] })
  const bubble = page.locator('.session-msg-received').filter({ hasText: 'kept across a reload' })
  await expect(bubble).toHaveCount(1)
  await expect(bubble.locator('.session-msg-held-note')).toContainText('Not sent yet:')
  await bubble.getByRole('button', { name: 'Send now' }).click()
  await expect.poll(async () => (await payloads(page)).map((p) => p.retryOf)).toEqual(['qm-waiting'])
})

test('other waits keep their note and offer no Send now', async ({ page }) => {
  await open(page)
  await sendViaUi(page, 'behind another line')
  await expect.poll(() => sentIds(page)).toHaveLength(1)
  const [id] = await sentIds(page)
  await injectEvent(page, 'session:delivery-held', { sessionId: SESSION_ID, messageIds: [id], reason: 'Waiting to confirm the previous message' })
  const bubble = page.locator('.session-msg-received').filter({ hasText: 'behind another line' })
  await expect(bubble.locator('.session-msg-held-note')).toHaveText('Waiting to confirm the previous message')
  await expect(bubble.getByRole('button', { name: 'Send now' })).toHaveCount(0)
})
