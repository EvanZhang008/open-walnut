/**
 * A phone reader can pan a session's transcript up while the turn streams, and a
 * swipe on something that does not scroll leaves the page where it is.
 *
 * Reported 2026-10-13 on an iPhone (Safari, the phone layout): "it won't scroll",
 * and "swiping on the input box makes the address bar come and go". Two causes:
 *
 *   1. Follow-bottom only yielded to a touch through the scroll events it caused,
 *      and while a turn streamed every content tick re-armed the quiet window that
 *      swallows them, so the view was pulled back under the finger. A finger moving
 *      down the screen now flips follow-bottom off at once, like wheel-up does.
 *   2. The document itself could move: a swipe on the composer rubber-banded the
 *      whole page and slid Safari's toolbar in and out. On a phone the document
 *      never scrolls now (overflow hidden, overscroll none); the panels do.
 *
 * Chromium drives a real touch pan (CDP touch events scroll natively). WebKit has
 * no touch input in Playwright, so there the same TouchEvents are dispatched on
 * the scroller and the pan is applied to scrollTop, which exercises the handler.
 * The session is mocked (history and detail routes) and the reply streams as
 * `session:text-delta` events on the console's own WebSocket.
 */
import { test, expect, devices, type Page } from '@playwright/test'

const PHONE = devices['iPhone 15']
test.use({ viewport: PHONE.viewport, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PHONE.userAgent })

const SESSION_ID = 'pw-phone-touch-scroll-session'
const TASK_ID = 'pw-phone-touch-scroll-task'
const TOTAL = 240

function row(i: number) {
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `Phone message ${i}\n\n${'a reasonably long line of transcript text '.repeat(5)}`,
    msgId: `m${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }
}

async function mockSession(page: Page) {
  const all = Array.from({ length: TOTAL }, (_, i) => row(i))
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) => route.fulfill({
    json: { messages: all, total: TOTAL, cursor: TOTAL, delta: false },
  }))
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut',
          process_status: 'running', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: TOTAL, title: 'Phone touch scroll',
        },
      },
    })
  })
}

/**
 * A streamed reply, the way the server sends one: `session:text-delta` events on
 * the console's WebSocket, every 120 ms, until the test ends. The socket is
 * captured at creation (init script below), as turn-end-tail-visible.spec.ts does.
 */
async function startStreaming(page: Page) {
  await page.waitForFunction(() => {
    const ws = (window as unknown as { __capturedWs?: WebSocket }).__capturedWs
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 15_000 })
  await page.evaluate((args) => {
    const w = window as unknown as { __capturedWs: WebSocket; __stream?: ReturnType<typeof setInterval> }
    const send = (delta: string) => w.__capturedWs.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'session:text-delta', data: { sessionId: args.sid, taskId: args.task, delta, msgId: 'live-a' }, seq: Date.now() }),
    }))
    send('')
    let n = 0
    w.__stream = setInterval(() => { n += 1; send(`Streamed sentence ${n} of the running turn. `) }, 120)
  }, { sid: SESSION_ID, task: TASK_ID })
}

async function gapFromBottom(page: Page) {
  return page.locator('.session-history').evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))
}

/** A finger dragged DOWN the screen by `dy` (the transcript pans up). */
async function panDown(page: Page, dy: number) {
  const box = (await page.locator('.session-history').boundingBox())!
  const x = box.x + box.width / 2
  const y0 = box.y + box.height * 0.3
  const engine = page.context().browser()?.browserType().name()
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] })
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + (dy * i) / 12 }] })
      await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    return
  }
  await page.locator('.session-history').evaluate(async (el, args) => {
    // Desktop WebKit cannot construct Touch or TouchEvent: an Event carrying the
    // same `touches` list reaches the same listeners.
    const fire = (type: string, y: number | null) => {
      const e = new Event(type, { bubbles: true })
      Object.defineProperty(e, 'touches', { value: y === null ? [] : [{ identifier: 1, clientX: args.x, clientY: y }] })
      el.dispatchEvent(e)
    }
    fire('touchstart', args.y0)
    for (let i = 1; i <= 12; i++) {
      fire('touchmove', args.y0 + (args.dy * i) / 12)
      el.scrollTop -= args.dy / 12
      await new Promise((r) => setTimeout(r, 16))
    }
    fire('touchend', null)
  }, { x, y0, dy })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const Orig = window.WebSocket
    window.WebSocket = class CapturedWebSocket extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const u = new URL(String(url), window.location.href)
        const w = window as unknown as { __capturedWs?: WebSocket }
        if (u.pathname === '/ws' && !w.__capturedWs) {
          w.__capturedWs = this
          const origSend = this.send.bind(this)
          // The mocked session has no live stream on the server: answer the
          // subscribe here so the panel takes the injected deltas.
          this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
            try {
              const parsed = JSON.parse(String(data))
              if (parsed.type === 'req' && parsed.method === 'session:stream-subscribe') {
                setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { blocks: [], isStreaming: true } }),
                })), 10)
                return
              }
            } catch { /* not JSON */ }
            origSend(data)
          }
        }
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(Orig)) {
      if (key !== 'prototype' && key !== 'length' && key !== 'name') {
        try { (window.WebSocket as unknown as Record<string, unknown>)[key] = (Orig as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
      }
    }
  })
})

test('a pan up while the turn streams stays where the finger left it', async ({ page }) => {
  await mockSession(page)
  await page.goto(`/sessions?id=${SESSION_ID}`)
  const history = page.locator('.session-history')
  await expect(history).toContainText(`Phone message ${TOTAL - 1}`, { timeout: 30_000 })
  await page.waitForTimeout(1_200)
  expect(await gapFromBottom(page)).toBeLessThanOrEqual(4)

  await startStreaming(page)
  await expect(history).toContainText('Streamed sentence 3', { timeout: 10_000 })
  await page.waitForTimeout(300)
  expect(await gapFromBottom(page), 'following the stream before the pan').toBeLessThanOrEqual(8)
  await panDown(page, 360)
  await page.waitForTimeout(400)
  const right = await gapFromBottom(page)
  expect(right, 'the pan moved the transcript').toBeGreaterThan(200)
  // The content keeps growing; follow-bottom must not pull the reader back.
  await page.waitForTimeout(2_000)
  expect(await gapFromBottom(page), 'still where the finger left it').toBeGreaterThanOrEqual(right - 8)

  // A second pan, as a reader does, also holds.
  await panDown(page, 240)
  await page.waitForTimeout(1_500)
  expect(await gapFromBottom(page)).toBeGreaterThan(right + 100)
})

test('a flick whose momentum outlasts the finger is not pulled back to the bottom', async ({ page }) => {
  // iOS Safari: a quick flick is a few touchmoves, and most of the distance is
  // momentum AFTER the finger lifts, with no input event at all. Follow-bottom
  // used to treat those late scroll events as its own echo (no input for 500 ms)
  // and snap the view back to the bottom. Here the drag moves nothing and the
  // momentum arrives 600 ms later, which is the shape that failed.
  await mockSession(page)
  await page.goto(`/sessions?id=${SESSION_ID}`)
  const history = page.locator('.session-history')
  await expect(history).toContainText(`Phone message ${TOTAL - 1}`, { timeout: 30_000 })
  await page.waitForTimeout(1_200)
  await startStreaming(page)
  await expect(history).toContainText('Streamed sentence 3', { timeout: 10_000 })
  await history.evaluate(async (el) => {
    const fire = (type: string, y: number | null) => {
      const e = new Event(type, { bubbles: true })
      Object.defineProperty(e, 'touches', { value: y === null ? [] : [{ identifier: 1, clientX: 100, clientY: y }] })
      el.dispatchEvent(e)
    }
    fire('touchstart', 300)
    fire('touchmove', 315)
    fire('touchmove', 330)
    fire('touchend', null)
    await new Promise((r) => setTimeout(r, 600))
    for (let i = 0; i < 10; i++) {
      el.scrollTop -= 45
      await new Promise((r) => setTimeout(r, 50))
    }
  })
  await page.waitForTimeout(1_500)
  expect(await gapFromBottom(page), 'the momentum kept the reader up the transcript').toBeGreaterThan(250)
})

test('the document never scrolls on a phone, so a swipe on the composer moves nothing', async ({ page }) => {
  await mockSession(page)
  await page.goto(`/sessions?id=${SESSION_ID}`)
  await expect(page.locator('.session-history')).toContainText(`Phone message ${TOTAL - 1}`, { timeout: 30_000 })
  const styles = await page.evaluate(() => {
    const h = getComputedStyle(document.documentElement)
    const b = getComputedStyle(document.body)
    return { hOverflow: h.overflowY, bOverflow: b.overflowY, hOverscroll: h.overscrollBehaviorY, bOverscroll: b.overscrollBehaviorY }
  })
  expect(styles).toEqual({ hOverflow: 'hidden', bOverflow: 'hidden', hOverscroll: 'none', bOverscroll: 'none' })
  const composer = page.locator('.main-page-session-column .chat-input-textarea').first()
  await expect(composer).toBeVisible()
  expect(await composer.evaluate((el) => getComputedStyle(el).overscrollBehaviorY)).toBe('contain')
  // Rounded to a quarter pixel: WebKit reports the same box a few thousandths apart.
  const at = async () => {
    const b = (await composer.boundingBox())!
    return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 4) / 4)
  }
  const before = await at()
  // Try to scroll the page itself, as a swipe that reached the document would.
  await page.evaluate(() => { window.scrollTo(0, 400); document.scrollingElement!.scrollTop = 400 })
  await page.waitForTimeout(200)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  expect(await at()).toEqual(before)
})
