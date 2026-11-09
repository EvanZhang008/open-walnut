/**
 * Playwright: a queued bubble follows the server's queue, says why it waits, and
 * a Delete that came too late says so in place.
 *
 * 2026-11-09, the user: "everything shows queued, why does every session freeze
 * without any warning", "the newer message is delivered but the older one is
 * still queued", and a red toast `RPC handler error for "session:delete-queued":
 * Message not deletable (already processing or not found).` on a bubble that read
 * Queued. The server's queue lock had jammed; the events that move a bubble never
 * came, so each panel kept the Queued badge it drew at send time.
 *
 * Harness (as bubble-late-delivered.spec.ts): the real SPA and composer, the WS
 * send / get-queue / delete-queued RPCs answered in the page from state the test
 * changes, server events injected on the socket. The panel's own queue reads
 * (useQueueSync) are what move the bubbles here: no reload anywhere.
 *
 * Set QUEUED_SPEC_VIDEO_DIR to keep each test's video there.
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-queued-follows-session'
const TASK_ID = 'pw-queued-follows-task'
const VIDEO_DIR = process.env.QUEUED_SPEC_VIDEO_DIR

if (VIDEO_DIR) test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } } })

interface QueueRow { id: string; message: string; status: string; stage?: string; delivered?: boolean; enqueuedAt: string }

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

/** The server's queue as get-queue answers it from now on. */
const setQueue = (page: Page, rows: QueueRow[]) => page.evaluate((rows) => { (window as any).__queue = rows }, rows)
/** What the next session:delete-queued answers. */
const setDeleteAnswer = (page: Page, answer: unknown) => page.evaluate((a) => { (window as any).__deleteAnswer = a }, answer)
const sent = (page: Page) => page.evaluate(() => (window as any).__sent as Array<{ id: string; text: string; enqueuedAt: string }>)
const queueReads = (page: Page) => page.evaluate(() => (window as any).__queueReads as number)

/** With QUEUED_SPEC_VIDEO_DIR set: a picture of the session column now, and a pause the video keeps. */
async function shot(page: Page, name: string) {
  if (!VIDEO_DIR) return
  await page.waitForTimeout(1200)
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  const project = test.info().project.name
  await page.locator('.session-history').first().screenshot({ path: path.join(VIDEO_DIR, `${project}-${name}.png`) })
}

/** The bubble (wrapper) holding `text`, whatever its state. */
const bubbleOf = (page: Page, text: string) =>
  page.locator('.session-msg-received, .session-msg-delivered, .session-msg-queued, .session-msg-failed').filter({ hasText: text })

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => {
    const w = window as any
    w.__sent = []
    w.__queue = []
    w.__queueReads = 0
    w.__deleteAnswer = { ok: true }
    w.__deletes = []
    const Orig = window.WebSocket
    window.WebSocket = class extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = new URL(String(url), window.location.href)
        if (u.pathname === '/ws' && !w.__capturedWs) {
          w.__capturedWs = this
          const origSend = this.send.bind(this)
          let n = 0
          const answer = (id: unknown, payload: unknown, ms = 10) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'res', id, ok: true, payload }),
          })), ms)
          this.send = (data: any) => {
            let intercepted = false
            try {
              const p = JSON.parse(data as string)
              const mine = p.payload?.sessionId === 'pw-queued-follows-session'
              if (p.type === 'req' && p.method === 'session:send' && mine) {
                intercepted = true
                const messageId = `qm-follow${++n}`
                // Enqueued a minute and a half ago on the server's clock: past the bound
                // after which a waiting bubble says why (queued-wait.ts), with no clock tricks.
                const enqueuedAt = new Date(Date.now() - 90_000 + n * 1000).toISOString()
                w.__sent.push({ id: messageId, text: p.payload.message, enqueuedAt })
                answer(p.id, { messageId, enqueuedAt })
              }
              if (p.type === 'req' && p.method === 'session:stream-subscribe' && mine) {
                intercepted = true
                answer(p.id, { blocks: [], isStreaming: false })
              }
              if (p.type === 'req' && p.method === 'session:get-queue' && mine) {
                intercepted = true
                w.__queueReads++
                answer(p.id, { messages: w.__queue })
              }
              if (p.type === 'req' && p.method === 'session:delete-queued' && mine) {
                intercepted = true
                w.__deletes.push(p.payload.messageId)
                answer(p.id, w.__deleteAnswer)
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
  })
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
      startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'Queued follows server',
    } } })
  })
  await page.goto(`/sessions?id=${SESSION_ID}`)
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 30_000 })
  await expect(page.locator('.session-history')).toContainText('earlier answer', { timeout: 30_000 })
}

/** Send `texts` and have the server's queue hold each as a waiting row. */
async function sendWaiting(page: Page, texts: string[]) {
  const before = (await sent(page)).length
  for (const t of texts) await sendViaUi(page, t)
  await expect.poll(async () => (await sent(page)).length).toBe(before + texts.length)
  const all = await sent(page)
  const rows = all.map((s) => ({ id: s.id, message: s.text, status: 'pending', stage: 'waiting', delivered: false, enqueuedAt: s.enqueuedAt }))
  await setQueue(page, rows)
  return all.slice(before)
}

test.afterEach(async ({ page }, testInfo) => {
  if (!VIDEO_DIR) return
  const video = page.video()
  await page.close()
  if (!video) return
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  const name = `${testInfo.project.name}-${testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.webm`
  // The video is evidence only: a lost artifact (another run in this checkout cleared
  // test-results) is no failure of the behavior under test.
  try { await video.saveAs(path.join(VIDEO_DIR, name)) } catch (e) { console.warn(`video not kept: ${(e as Error).message}`) }
})

test('waiting bubbles say why after the bound, and follow the server without a reload', async ({ page }) => {
  await open(page)
  const [older, newer] = await sendWaiting(page, ['older message here', 'newer message here'])

  // Both wait on the server: Queued, and past the bound each says why and how long.
  for (const text of ['older message here', 'newer message here']) {
    const b = bubbleOf(page, text)
    await expect(b.locator('.session-msg-received-badge')).toHaveText(/queued/i)
    await expect(b.locator('.session-msg-wait-note')).toContainText('Not sent yet: the session has not taken it.', { timeout: 15_000 })
    await expect(b.locator('.session-msg-wait-note')).toContainText(/Queued 1 min ago\./)
  }
  // The bubbles keep the order they were sent in.
  const order = await page.locator('.session-msg-received').allInnerTexts()
  expect(order.findIndex((t) => t.includes('older message here'))).toBeLessThan(order.findIndex((t) => t.includes('newer message here')))
  await shot(page, '1-waiting-why')

  // The CLI took the OLDER one, but only the newer one's delivery event comes
  // ("the newer message is delivered but the older one is still queued").
  await setQueue(page, [
    { id: older.id, message: older.text, status: 'processing', stage: 'taken', delivered: true, enqueuedAt: older.enqueuedAt },
    { id: newer.id, message: newer.text, status: 'processing', stage: 'written', delivered: false, enqueuedAt: newer.enqueuedAt },
  ])
  await injectEvent(page, 'session:messages-delivered', { sessionId: SESSION_ID, count: 1, messageIds: [newer.id], turnGen: 1 })
  // The event's queue read moves the older bubble too: no Queued badge left, no reload.
  await expect(bubbleOf(page, 'older message here').locator('.session-msg-delivered-badge')).toBeVisible({ timeout: 10_000 })
  await expect(bubbleOf(page, 'newer message here').locator('.session-msg-delivered-badge')).toBeVisible()
  await expect(page.locator('.session-msg-received-badge')).toHaveCount(0)
  await expect(page.locator('.session-msg-wait-note')).toHaveCount(0)
  await shot(page, '2-both-delivered')
})

test('with no event at all, the panel\'s own queue read takes a gone row off Queued', async ({ page }) => {
  await open(page)
  await sendWaiting(page, ['lost in the jam'])
  const b = bubbleOf(page, 'lost in the jam')
  await expect(b.locator('.session-msg-received-badge')).toHaveText(/queued/i)
  const readsBefore = await queueReads(page)
  // The server's queue no longer has it (answered and cleared while no event reached the panel).
  await setQueue(page, [])
  await expect(b.locator('.session-msg-received-badge')).toHaveCount(0, { timeout: 20_000 })
  await expect(b.locator('.session-msg-delivered-badge')).toBeVisible()
  expect(await queueReads(page)).toBeGreaterThan(readsBefore)
  await shot(page, '3-gone-left-queued')
})

test('Delete on a row the session already took says so in place, with no error toast', async ({ page }) => {
  await open(page)
  const [row] = await sendWaiting(page, ['too late to delete'])
  const b = bubbleOf(page, 'too late to delete')
  await expect(b.locator('.session-msg-received-badge')).toHaveText(/queued/i)

  // The server already handed it to the CLI: the delete answers `taken`.
  await setDeleteAnswer(page, { ok: false, outcome: 'taken' })
  await b.getByRole('button', { name: 'Delete' }).click()
  await setQueue(page, [{ id: row.id, message: row.text, status: 'processing', stage: 'taken', delivered: true, enqueuedAt: row.enqueuedAt }])

  await expect(b.locator('.session-msg-queue-notice')).toHaveText('Already sent to the session, so it can’t be deleted now.')
  await expect(b.locator('.session-msg-delivered-badge')).toBeVisible()
  await expect(b.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  await expect(page.getByText(/RPC handler error|not deletable/)).toHaveCount(0)
  await page.waitForTimeout(500)
  await expect(page.getByText(/RPC handler error|not deletable/)).toHaveCount(0)
  await shot(page, '4-delete-too-late')
})

test('Delete on a row the queue no longer has takes the bubble away', async ({ page }) => {
  await open(page)
  await sendWaiting(page, ['already gone row', 'still waiting row'])
  await setDeleteAnswer(page, { ok: false, outcome: 'gone' })
  await bubbleOf(page, 'already gone row').getByRole('button', { name: 'Delete' }).click()
  await expect(bubbleOf(page, 'already gone row')).toHaveCount(0)
  // The other row is untouched.
  await expect(bubbleOf(page, 'still waiting row').locator('.session-msg-received-badge')).toHaveText(/queued/i)
  await expect(page.getByText(/RPC handler error|not deletable/)).toHaveCount(0)
})
