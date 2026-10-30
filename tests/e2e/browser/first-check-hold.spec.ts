/**
 * A reply never shows without its question while a session opens.
 *
 * On open (a reload, a session switch) the stream snapshot can already hold the
 * newest turn's reply while the rows shown (a cached copy, or none yet) stop at
 * the turn before. Drawn at once, the reply sat under the old turn with its
 * question missing until the history answer landed: 0.3 to 3 s, seen 2026-10-30
 * on every reload within a second or two of a reply. While the rows shown lack
 * the stream turn's question, the chat now draws no stream block before the
 * history's first server answer, for at most 3 s; rows that end with the
 * question hold nothing, so a live turn shows as it comes.
 *
 *   A. no cache: every history read held 1.5 s, the snapshot holds the reply.
 *   B. a stale cached copy (an earlier visit), then a reload whose history is held.
 *   C. a host slower than the 3 s limit: the reply shows anyway, then one copy.
 *   D. a live turn whose question the cached rows hold: its output shows before the history answers.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-first-check-hold'
const QUESTION = 'Which region holds the backups?'
const REPLY = 'The backups sit in the second region, copied nightly.'

const base = [
  { role: 'user', text: 'Run the check', timestamp: '2026-01-01T00:00:00.000Z' },
  { role: 'assistant', text: 'Starting.', timestamp: '2026-01-01T00:00:01.000Z' },
]
const full = [
  ...base,
  { role: 'user', text: QUESTION, timestamp: '2026-01-01T00:00:05.000Z' },
  { role: 'assistant', text: REPLY, msgId: 'msg-hold-1', timestamp: '2026-01-01T00:00:07.000Z' },
]

async function mockSessionDetail(page: Page) {
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-first-check',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 4,
          title: 'First check hold session',
        },
      },
    })
  })
}

/** The stream snapshot each page load gets: `window.__snapshotBlocks`, set before load. */
async function captureWs(page: Page, snapshotBlocks: unknown[]) {
  await page.addInitScript((blocks) => {
    ;(window as any).__snapshotBlocks = blocks
    const OrigWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OrigWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname === '/ws' && !(window as any).__capturedWs) {
          ;(window as any).__capturedWs = this
          const origSend = this.send.bind(this)
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const parsed = JSON.parse(data as string)
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                setTimeout(() => {
                  this.dispatchEvent(new MessageEvent('message', {
                    data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: (window as any).__snapshotBlocks, isStreaming: (window as any).__snapshotStreaming === true } }),
                  }))
                }, 10)
                return
              }
            } catch { /* non-JSON */ }
            origSend(data)
          }
        }
      }
    } as any
    for (const key of Object.getOwnPropertyNames(OrigWebSocket)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as any)[key] = (OrigWebSocket as any)[key] } catch { /* read-only */ }
      }
    }
  }, snapshotBlocks)
}

/** Serve `rows()` for every history read, each answer held `holdMs()` first. Returns the count of answers sent. */
async function routeHistory(page: Page, rows: () => unknown[], holdMs: () => number): Promise<() => number> {
  let answered = 0
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const wait = holdMs()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    answered++
    const all = rows()
    const since = new URL(route.request().url()).searchParams.get('since')
    if (since !== null) return route.fulfill({ json: { messages: all.slice(Number(since)), cursor: all.length, delta: true } })
    return route.fulfill({ json: { messages: all, cursor: all.length, delta: false } })
  })
  return () => answered
}

const replyBlock = [{ type: 'text', content: REPLY, msgId: 'msg-hold-1' }]
const historyText = (page: Page) => page.locator('.session-history').first().textContent().then((t) => t ?? '')

/** Sample the view every 100 ms for `ms`: a reply shown without its question above it fails. */
async function neverReplyWithoutQuestion(page: Page, ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const txt = await historyText(page).catch(() => '')
    const r = txt.indexOf(REPLY)
    if (r >= 0) {
      const q = txt.indexOf(QUESTION)
      expect(q >= 0 && q < r, `the reply showed without its question above it: ${JSON.stringify(txt.slice(-300))}`).toBe(true)
    }
    await page.waitForTimeout(100)
  }
}

async function expectSettled(page: Page, timeout = 10_000) {
  await expect.poll(async () => {
    const txt = await historyText(page)
    return { replies: (txt.match(/second region, copied nightly/g) || []).length, questionFirst: txt.indexOf(QUESTION) >= 0 && txt.indexOf(QUESTION) < txt.indexOf(REPLY) }
  }, { timeout }).toEqual({ replies: 1, questionFirst: true })
}

test.describe('A reply never shows without its question while a session opens', () => {
  test('A: no cache, every history read held 1.5 s, snapshot holds the reply', async ({ page }) => {
    await captureWs(page, replyBlock)
    await mockSessionDetail(page)
    await routeHistory(page, () => full, () => 1500)
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await page.locator('.session-history').first().waitFor({ timeout: 15_000 })
    await neverReplyWithoutQuestion(page, 2500)
    await expectSettled(page)
  })

  test('B: a stale cached copy, then a reload whose history is held', async ({ page }) => {
    let rows = base
    let hold = 0
    await captureWs(page, [])
    await mockSessionDetail(page)
    const answered = await routeHistory(page, () => rows, () => hold)
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await expect(page.locator('.session-history').first()).toContainText('Starting.', { timeout: 15_000 })
    // Let the cache write land (debounced 800 ms), then the turn happens elsewhere.
    await page.waitForTimeout(2000)
    rows = full
    hold = 1500
    await page.evaluate((blocks) => { (window as any).__snapshotBlocks = blocks }, replyBlock)
    await page.addInitScript((blocks) => { (window as any).__snapshotBlocks = blocks }, replyBlock)
    const before = answered()
    await page.reload()
    // The cached rows show before any history answer (so this run tests the
    // cached path); the reply waits for its question.
    await expect(page.locator('.session-history').first()).toContainText('Starting.', { timeout: 15_000 })
    expect(answered(), 'the rows came from the network, not the cached copy').toBe(before)
    await neverReplyWithoutQuestion(page, 2500)
    await expectSettled(page)
  })

  test('C: a host slower than the hold limit: the reply shows anyway, then one copy', async ({ page }) => {
    // History answers 8 s after it is asked; the hold gives up at 3 s from the panel's mount.
    let hold = 8000
    await captureWs(page, replyBlock)
    await mockSessionDetail(page)
    await routeHistory(page, () => full, () => hold)
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await page.locator('.session-history').first().waitFor({ timeout: 30_000 })
    const mounted = Date.now()
    await expect(page.locator('.session-history').first()).toContainText(REPLY, { timeout: 5000 })
    expect(Date.now() - mounted, 'the stream stayed off screen past the hold limit').toBeLessThan(5000)
    hold = 0
    await expectSettled(page, 15_000)
  })

  test('D: a live turn whose question the cached rows hold shows before the history answers', async ({ page }) => {
    const withQuestion = [...base, { role: 'user', text: QUESTION, timestamp: '2026-01-01T00:00:05.000Z' }]
    let hold = 0
    await captureWs(page, [])
    await mockSessionDetail(page)
    const answered = await routeHistory(page, () => withQuestion, () => hold)
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await expect(page.locator('.session-history').first()).toContainText(QUESTION, { timeout: 15_000 })
    await page.waitForTimeout(2000) // the cache write lands (debounced 800 ms)
    hold = 4000
    await page.addInitScript(() => {
      ;(window as any).__snapshotStreaming = true
      ;(window as any).__snapshotBlocks = [{ type: 'text', content: 'Still checking the second region', msgId: 'msg-live-1' }]
    })
    const before = answered()
    await page.reload()
    await expect(page.locator('.session-history').first()).toContainText('Still checking the second region', { timeout: 15_000 })
    expect(answered(), 'the live output waited for the history answer').toBe(before)
  })
})
