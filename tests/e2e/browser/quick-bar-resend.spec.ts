/**
 * The quick bar's send that never reached Walnut goes out by itself once Walnut is back
 * (web/src/components/quickbar/useQuickReceipts.ts, the rule hooks/send-auto-retry.ts), in Chromium.
 *
 * 2026-11-22: a receipt said "Not sent · Walnut could not be reached. Nothing was sent." and
 * stayed, with no × (the user: "why there is no x so that i cna close"). Now:
 *   - the first POST never reaches Walnut (the fetch fails): the receipt says "Waiting for Walnut ·
 *     sends when it is back"; once Walnut answers, the bar sends it again under the SAME user line
 *     (the server keeps one copy, core/sessions/send-once.ts), exactly once, and the receipt
 *     follows the reply;
 *   - its × only hides the card: the message still goes out when Walnut is back;
 *   - hidden, a send that fails for good brings its card back, its words not lost.
 * The people list and the send are stubbed (the send's contract is tests/e2e/quick-input.test.ts);
 * Walnut's liveness read is the fixture server's own, cut off where a test says Walnut is down.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { useSyntheticMic } from './stt-failure-helpers'
import { box, KEY, openApp, pinFlag, shot, stubAll, voiceOff } from './quick-bar-helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await useSyntheticMic(page)
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface Wire { bodies: Array<Record<string, unknown>>; abortSends: number; walnutDown: boolean }

/** The send: the first `abortSends` POSTs never reach Walnut; then the reply streams. Registered after stubAll, so it wins. */
async function stubResend(page: Page, abortSends: number): Promise<Wire> {
  const wire: Wire = { bodies: [], abortSends, walnutDown: false }
  await page.route('**/api/v1/quick/send', async (r: Route) => {
    wire.bodies.push(JSON.parse(r.request().postData() ?? '{}'))
    if (wire.bodies.length <= wire.abortSends) { await r.abort('connectionrefused'); return }
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

async function sendFromBar(page: Page, text: string): Promise<void> {
  await page.keyboard.press(KEY)
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
  await receipt.locator('.wn-notice-x').click()
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
  await receipt.locator('.wn-notice-x').click()
  await expect(page.locator('.qb-receipt')).toHaveCount(0)
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Not sent · Walnut could not be reached. Nothing was sent.', { timeout: 45_000 })
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
