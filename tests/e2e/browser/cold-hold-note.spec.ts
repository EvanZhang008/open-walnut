/**
 * Playwright: a message held for a cold session's next wake (src/core/sessions/cold-hold.ts) reads
 * as queued with its held note, live and after a reload, and the note goes once its line goes out.
 * Same harness as bubble-late-delivered.spec.ts: the real SPA, the WS answered in the page, server
 * events injected on the socket.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-cold-hold-session'
const TASK_ID = 'pw-cold-hold-task'
// The server's words (cold-hold.ts presentColdHold).
const HELD = 'Held: the session is idle and its prompt cache has expired, so this goes with its next wake, or by itself at the next try.'

interface QueueRow { id: string; message: string; status: string; enqueuedAt: string; heldReason?: string; heldRetryAt?: string; sentBy?: string }

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    if (!ws) throw new Error('No captured WebSocket')
    const d = data as { messageIds?: string[] }
    const taken = ((window as any).__takenIds ??= new Set<string>()) as Set<string>
    if (name === 'session:messages-delivered') for (const id of d.messageIds ?? []) taken.add(id)
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }))
  }, { name, data })
}

async function open(page: Page, queue: QueueRow[] = []) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(({ queue, sid }) => {
    const Orig = window.WebSocket
    window.WebSocket = class extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = new URL(String(url), window.location.href)
        if (u.pathname === '/ws' && !(window as any).__capturedWs) {
          (window as any).__capturedWs = this
          const origSend = this.send.bind(this)
          const answer = (id: unknown, payload: unknown) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'res', id, ok: true, payload }),
          })), 10)
          this.send = (data: any) => {
            let intercepted = false
            try {
              const p = JSON.parse(data as string)
              if (p.type === 'req' && p.method === 'session:stream-subscribe') { intercepted = true; answer(p.id, { blocks: [], isStreaming: false }) }
              if (p.type === 'req' && p.method === 'session:get-queue' && p.payload?.sessionId === sid) {
                intercepted = true
                const taken = ((window as any).__takenIds ?? new Set()) as Set<string>
                const live = JSON.parse(sessionStorage.getItem('__liveRows') ?? '[]') as QueueRow[]
                answer(p.id, { messages: [...queue, ...live].map((r) => (taken.has(r.id) ? { ...r, status: 'processing', heldReason: undefined, heldRetryAt: undefined } : r)) })
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
  }, { queue, sid: SESSION_ID })
  const history = [
    { role: 'user', text: 'earlier question', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: 'earlier answer', timestamp: '2026-01-01T00:00:10.000Z' },
  ]
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) =>
    route.fulfill({ json: { messages: history, cursor: history.length, delta: false } }))
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({ json: { session: {
      claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'bypass',
      startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:10.000Z', messageCount: 2, title: 'Cold session',
    } } })
  })
  await page.goto(`/sessions?id=${SESSION_ID}`)
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 30_000 })
  await expect(page.locator('.session-history')).toContainText('earlier answer', { timeout: 30_000 })
}

test('a held row shows its note live and after a reload, and loses it once it goes out', async ({ page }) => {
  const at = new Date().toISOString()
  const by = new Date(Date.now() + 55 * 60_000).toISOString()
  // Live: the queued event of a held trigger fire carries the note (session-message-queue.ts).
  await open(page)
  const fire = '<walnut-message kind="trigger" from="Trigger: CI watch" note="the check fired">\nbuild 42 failed\n</walnut-message>'
  await page.evaluate(({ row }) => { sessionStorage.setItem('__liveRows', JSON.stringify([row])) }, { row: { id: 'qm-cold1', message: fire, status: 'pending', enqueuedAt: at, heldReason: HELD, heldRetryAt: by, sentBy: 'agent' } })
  await injectEvent(page, 'session:message-queued', {
    sessionId: SESSION_ID, messageId: 'qm-cold1', message: 'build 42 failed', queuedText: fire, source: 'routine-watcher', sentBy: 'agent',
    enqueuedAt: at, heldReason: HELD, heldRetryAt: by,
  })
  await page.screenshot({ path: 'test-results/cold-hold-shots/live-folded.png' })
  await expect(page.getByText('Received 1 message · 1 held')).toBeVisible()
  await page.getByText('Received 1 message · 1 held').click()
  await page.screenshot({ path: 'test-results/cold-hold-shots/live-expanded.png' })
  const note = page.locator('.session-msg-held-note')
  await expect(note).toHaveCount(1)
  await expect(note).toContainText('Held: the session is idle and its prompt cache has expired')
  await expect(note).toContainText('Next try at')
  await page.locator('.session-panel, .session-history').first().screenshot({ path: 'test-results/cold-hold-shots/live-held-note.png' }).catch(() => {})

  // Reload: the queue's row (presentColdHolds) shows the same note.
  await page.reload()
  await expect(page.locator('.session-history')).toContainText('earlier answer', { timeout: 30_000 })
  await expect(page.getByText('Received 1 message · 1 held')).toBeVisible()
  await page.getByText('Received 1 message · 1 held').click()
  await expect(page.locator('.session-msg-held-note')).toHaveCount(1)
  await expect(page.locator('.session-msg-held-note')).toContainText('Held: the session is idle')
  await page.screenshot({ path: 'test-results/cold-hold-shots/reload-held-note.png' })

  // Its line goes out: the note goes with the wait.
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: ['qm-cold1'], turnGen: 1 })
  await expect(page.locator('.session-msg-held-note')).toHaveCount(0)
})
