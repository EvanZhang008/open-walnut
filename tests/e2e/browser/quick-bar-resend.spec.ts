/**
 * The quick bar's send Walnut never confirmed goes out by itself once Walnut is back
 * (web/src/components/quickbar/useQuickReceipts.ts, the rule hooks/send-auto-retry.ts), in Chromium.
 *
 * 2026-11-22: a receipt said "Not sent · Walnut could not be reached. Nothing was sent." and
 * stayed, with no × (the user: "why there is no x so that i cna close"). Now:
 *   - the first POST never reaches Walnut (the fetch fails), or its answer breaks off or ends
 *     before the line that says it was sent (Walnut restarted mid-send): the receipt says "Waiting
 *     for Walnut · sends when it is back"; once Walnut answers, the bar sends it again under the
 *     SAME user line (the server keeps one copy, core/sessions/send-once.ts), exactly once, and the
 *     receipt follows the reply;
 *   - its × only hides the card: the message still goes out when Walnut is back;
 *   - hidden, a send that fails for good brings its card back, its words not lost; in the Mac
 *     app's panel page too, which keeps telling the app it has a send on its way;
 *   - a reload of the page keeps a waiting send, still waiting under its line.
 * The people list and the send are stubbed (the send's contract is tests/e2e/quick-input.test.ts);
 * Walnut's liveness read is the fixture server's own, cut off where a test says Walnut is down.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { useSyntheticMic } from './stt-failure-helpers'
import { box, openApp, openBar, pinFlag, shot, stubAll, voiceOff } from './quick-bar-helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await useSyntheticMic(page)
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface Wire { bodies: Array<Record<string, unknown>>; abortSends: number; walnutDown: boolean }

/**
 * The send: the first `abortSends` POSTs never reach Walnut (`ended`: their answer ends before its
 * `sent` line instead); then the reply streams. Registered after stubAll, so it wins.
 */
async function stubResend(page: Page, abortSends: number, how: 'refused' | 'ended' = 'refused'): Promise<Wire> {
  const wire: Wire = { bodies: [], abortSends, walnutDown: false }
  await page.route('**/api/v1/quick/send', async (r: Route) => {
    wire.bodies.push(JSON.parse(r.request().postData() ?? '{}'))
    if (wire.bodies.length <= wire.abortSends) {
      if (how === 'ended') await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' })
      else await r.abort('connectionrefused')
      return
    }
    const lines = [
      { type: 'sent', taskId: 'pw-ceo', sessionId: 's-1', started: false, messageId: 'm-1' },
      { type: 'delivered' },
      { type: 'result', text: 'Got it, sending now.' },
    ]
    await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
  })
  await page.route('**/api/system/health', (r) => (wire.walnutDown ? r.abort('connectionrefused') : r.fallback()))
  return wire
}

/**
 * The first `count` sends get an answer that starts, then breaks before its `sent` line (Walnut went
 * down mid-send). A route cannot break a body it began, so the page's fetch gives that answer;
 * their bodies are kept in `window.__brokenBodies`.
 */
async function breakAnswers(page: Page, count: number): Promise<void> {
  await page.addInitScript((n) => {
    const real = window.fetch.bind(window)
    let left = n
    const w = window as unknown as { __brokenBodies: unknown[] }
    w.__brokenBodies = []
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (left > 0 && url.includes('/api/v1/quick/send')) {
        left -= 1
        w.__brokenBodies.push(JSON.parse(String(init?.body ?? '{}')))
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"type":"se'))
            setTimeout(() => c.error(new TypeError('network error')), 50)
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
      }
      return real(input, init)
    }
  }, count)
}

async function sendFromBar(page: Page, text: string): Promise<void> {
  await openBar(page)
  await box(page).fill(text)
  await box(page).press('Enter')
}

test('a send that never reached Walnut waits, then goes out once under the same user line', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  const wire = await stubResend(page, 1)
  await openApp(page)
  await sendFromBar(page, 'so for this one, why it just keep showing')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  await shot(page, 'resend-1-waiting')
  // Walnut answers (the fixture server): sent again by itself, then the reply.
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Replied', { timeout: 15_000 })
  await shot(page, 'resend-2-replied')
  expect(wire.bodies).toHaveLength(2)
  const [first, again] = wire.bodies
  expect(first.userUuid).toMatch(UUID_V4)
  expect(first.resend).toBeUndefined()
  expect(again).toMatchObject({ text: 'so for this one, why it just keep showing', userUuid: first.userUuid, resend: 'auto', follow: true })
  // Never a third: it went out.
  await page.waitForTimeout(3_000)
  expect(wire.bodies).toHaveLength(2)
  // And it leaves as any receipt does.
  await expect(page.locator('.qb-receipt')).toHaveCount(0, { timeout: 15_000 })
})

test('its × only hides the card: the message still goes out once Walnut is back', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  const wire = await stubResend(page, 1)
  wire.walnutDown = true
  await openApp(page)
  await sendFromBar(page, 'there can be one that needs to show a long time')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  await receipt.locator('.wn-notice-close').click()
  await expect(page.locator('.qb-receipt')).toHaveCount(0)
  // Still down: nothing is tried while Walnut does not answer.
  await page.waitForTimeout(3_000)
  expect(wire.bodies).toHaveLength(1)
  wire.walnutDown = false
  await expect.poll(() => wire.bodies.length, { timeout: 30_000 }).toBe(2)
  expect(wire.bodies[1]).toMatchObject({ userUuid: wire.bodies[0].userUuid, resend: 'auto' })
  // It went out: the card stays closed.
  await page.waitForTimeout(1_500)
  await expect(page.locator('.qb-receipt')).toHaveCount(0)
  expect(wire.bodies).toHaveLength(2)
})

test('hidden, a send that never gets through brings its card back with Send again', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  // Every try fails: the first, then each of its three tries by itself.
  const wire = await stubResend(page, 99)
  await openApp(page)
  await sendFromBar(page, 'keep these words')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  await receipt.locator('.wn-notice-close').click()
  await expect(page.locator('.qb-receipt')).toHaveCount(0)
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Not sent · Walnut could not be reached.', { timeout: 45_000 })
  expect(wire.bodies).toHaveLength(4)
  expect(new Set(wire.bodies.map((b) => b.userUuid)).size).toBe(1)
  await shot(page, 'resend-3-back')
  // Send again: the same send (it may have reached Walnut), now through.
  wire.abortSends = 0
  await receipt.locator('.qb-receipt-head').click()
  await receipt.getByRole('button', { name: 'Send again' }).click()
  await expect(page.locator('.qb-receipt-status').first()).toHaveText('Replied', { timeout: 15_000 })
  expect(wire.bodies.at(-1)).toMatchObject({ text: 'keep these words', userUuid: wire.bodies[0].userUuid, resend: 'person' })
})

test('an answer that broke off before its sent line is not confirmed: it waits, then goes out once under its line', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  await breakAnswers(page, 1)
  const wire = await stubResend(page, 0)
  await openApp(page)
  await sendFromBar(page, 'did the build finish')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Replied', { timeout: 15_000 })
  const broken = await page.evaluate(() => (window as unknown as { __brokenBodies: Array<Record<string, unknown>> }).__brokenBodies)
  expect(broken).toHaveLength(1)
  expect(broken[0].userUuid).toMatch(UUID_V4)
  expect(wire.bodies).toHaveLength(1)
  expect(wire.bodies[0]).toMatchObject({ text: 'did the build finish', userUuid: broken[0].userUuid, resend: 'auto' })
})

test('an answer that ended before its sent line is not confirmed either: never "Nothing was sent"', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  // Every try ends early: the first, then each of its three tries by itself.
  const wire = await stubResend(page, 99, 'ended')
  await openApp(page)
  await sendFromBar(page, 'move standup to ten')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Not confirmed · Walnut ended its answer before saying it was sent', { timeout: 45_000 })
  expect(wire.bodies).toHaveLength(4)
  expect(new Set(wire.bodies.map((b) => b.userUuid)).size).toBe(1)
  await shot(page, 'resend-4-unconfirmed')
  // Send again: the same send, through now.
  wire.abortSends = 0
  await receipt.locator('.qb-receipt-head').click()
  await receipt.getByRole('button', { name: 'Send again' }).click()
  await expect(page.locator('.qb-receipt-status').first()).toHaveText('Replied', { timeout: 15_000 })
  expect(wire.bodies.at(-1)).toMatchObject({ userUuid: wire.bodies[0].userUuid, resend: 'person' })
})

test('a reload keeps a waiting send: it comes back waiting and goes out once under the same line', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  const wire = await stubResend(page, 1)
  wire.walnutDown = true
  await openApp(page)
  await sendFromBar(page, 'water the ferns tonight')
  await expect(page.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  // A reload (the stale-build reload, the Mac app's recycle) loads the page again in place.
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back', { timeout: 15_000 })
  await expect(receipt.locator('.qb-receipt-line')).toHaveText('water the ferns tonight')
  expect(wire.bodies).toHaveLength(1)
  wire.walnutDown = false
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Replied', { timeout: 30_000 })
  expect(wire.bodies).toHaveLength(2)
  expect(wire.bodies[1]).toMatchObject({ userUuid: wire.bodies[0].userUuid, resend: 'auto' })
})

test('the Mac app panel: a hidden send on its way keeps the page, and its card comes back when it fails for good', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await voiceOff(page)
  const wire = await stubResend(page, 99)
  wire.walnutDown = true
  await page.addInitScript(() => {
    const posted: unknown[] = []
    Object.assign(window, { __posted: posted, webkit: { messageHandlers: { walnutQuickBar: { postMessage: (m: unknown) => posted.push(m) } } } })
  })
  // The page's clock, so a minute passes at once; time still runs on its own otherwise.
  await page.clock.install()
  const layouts = () => page.evaluate(() => (window as unknown as { __posted: Array<{ type: string; mode?: string }> }).__posted.filter((m) => m.type === 'layout'))
  // The panel loads this page itself (desktop/QuickBarPanel.swift), as no click could.
  await page.goto('/quickbar')
  await expect.poll(async () => (await layouts()).some((m) => m.mode === 'hidden')).toBe(true)
  await page.evaluate(() => (window as unknown as { __walnutQuickBar: { open(): void } }).__walnutQuickBar.open())
  await expect(box(page)).toBeVisible()
  await box(page).fill('call the plumber')
  await box(page).press('Enter')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Waiting for Walnut · sends when it is back')
  await receipt.locator('.wn-notice-close').click()
  await expect.poll(async () => (await layouts()).at(-1)?.mode).toBe('hidden')
  // Hidden with its send on its way: the page says so again within the app's ten minutes, on its
  // own clock (nothing else posts a layout meanwhile).
  await page.waitForTimeout(1_000)
  const before = (await layouts()).length
  await page.waitForTimeout(1_500)
  expect((await layouts()).length).toBe(before)
  await page.clock.fastForward(61_000)
  await expect.poll(async () => (await layouts()).length).toBeGreaterThan(before)
  expect((await layouts()).at(-1)?.mode).toBe('hidden')
  // Walnut answers, every try fails: the card is back and the panel shows the receipts again.
  wire.walnutDown = false
  await expect(page.locator('.qb-receipt-status')).toHaveText('Not sent · Walnut could not be reached.', { timeout: 60_000 })
  await expect.poll(async () => (await layouts()).at(-1)?.mode).toBe('receipts')
  expect(wire.bodies).toHaveLength(4)
})
