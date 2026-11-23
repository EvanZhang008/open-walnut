/**
 * Settings > Sessions, "Antigravity sign-in", walked as a person does, on the fixture's own
 * Antigravity CLI (tests/fixtures/antigravity/fake-agy.mjs through WALNUT_ANTIGRAVITY_PATH,
 * test-server.ts: the code "good" signs it in, any other code is refused):
 *
 *   1. this computer reads Not signed in; Sign in with Google opens ONE row: the link, the code
 *      field and Finish (off while the field is empty)
 *   2. a wrong code says what to do, marks the field and leaves a new link behind the same words
 *   3. Use a Gemini API key instead and back: the field and its key do not move
 *   4. the right code signs it in (Signed in with Google, Sign out); Sign out signs it out
 *   5. the chat: a message the host refused for want of a sign-in says so with Open Settings to
 *      sign in, Retry and Discard; the link opens Settings at that host's row with its sign-in open
 *
 * PROOF_VIDEO_DIR=<dir> records a sharp walk-through (proof-video.ts: screencast, pointer, captions).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { startProofVideo, type ProofVideo } from './proof-video'
import { notSignedInSentence } from '../../../src/core/agents/engine-sign-in-words'

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: process.env.PROOF_VIDEO_DIR ? 2 : 1 })

const LOCAL = '__local__'
const BAD_CODE = "That code didn't work. Open Google sign-in to get a new one."
const SESSION_ID = 'pw-engine-sign-in-session'
const TASK_ID = 'pw-engine-sign-in-task'

let video: ProofVideo

/** This computer's Antigravity, signed out with no key and no sign-in waiting: each test starts here. */
async function signedOut(request: APIRequestContext): Promise<void> {
  await request.post('/api/engines/antigravity/sign-in/cancel', { data: { host: LOCAL } })
  await request.delete(`/api/engines/antigravity/api-key?host=${LOCAL}`)
  const out = await request.post('/api/engines/antigravity/sign-out', { data: { host: LOCAL } })
  expect(out.ok(), await out.text()).toBe(true)
  expect((await out.json()).status.state).toBe('not_signed_in')
}

const group = (page: Page) => page.getByTestId('engine-sign-in-group-antigravity')
const localRow = (page: Page) => page.getByTestId(`engine-sign-in-${LOCAL}`)

async function openSessionsSettings(page: Page): Promise<void> {
  await page.locator('.sidebar a[href^="/settings"]').first().click()
  await page.getByTestId('settings-nav-sessions').click()
  await expect(page.locator('#sessions.settings-section')).toBeVisible({ timeout: 20_000 })
  await group(page).scrollIntoViewIfNeeded()
}

const leftOf = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => Math.round(el.getBoundingClientRect().left))

test.beforeEach(async ({ request }) => { await signedOut(request) })

test('signs this computer in with Google, through a wrong code, the API key view and back, then out', async ({ page }) => {
  video = await startProofVideo(page)
  await page.goto('/')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  await video.caption('Settings > Sessions: Antigravity sign-in')
  await openSessionsSettings(page)

  // 1. Not signed in, and its one step.
  const row = localRow(page)
  await expect(row.getByTestId('engine-sign-in-row')).toContainText('This computer')
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 30_000 })
  await expect(row.locator('.wn-notice-status')).toHaveAttribute('data-tone', 'muted')
  await video.hold()
  await video.caption('Sign in with Google opens one row: the link, the code and Finish')
  await row.getByTestId('engine-sign-in-action').click()
  const link = row.getByTestId('engine-sign-in-link')
  await expect(link).toHaveText('Open Google sign-in ↗', { timeout: 30_000 })
  await expect(link).toHaveAttribute('href', /^https:\/\/accounts\.google\.com\//)
  await expect(link).toHaveAttribute('target', '_blank')
  const firstLink = await link.getAttribute('href')
  await expect(row.getByTestId('engine-sign-in-finish')).toBeDisabled()
  await expect(row.getByTestId('engine-sign-in-cancel')).toBeVisible()
  await expect(row.getByTestId('engine-sign-in-step')).toContainText('Paste the code it shows.')
  await row.screenshot({ path: shot('step-open') })
  await video.hold()

  // 2. A code Google did not take.
  await video.caption('A wrong code says what to do')
  await row.getByTestId('engine-sign-in-code').click()
  await row.getByTestId('engine-sign-in-code').pressSequentially('4/0Ab-not-it', { delay: 30 })
  await expect(row.getByTestId('engine-sign-in-finish')).toBeEnabled()
  await row.getByTestId('engine-sign-in-finish').click()
  await expect(row.getByRole('alert')).toHaveText(BAD_CODE, { timeout: 60_000 })
  await expect(row.getByTestId('engine-sign-in-code')).toHaveAttribute('aria-invalid', 'true')
  // That sign-in ended in the CLI: the same words now open a new one.
  await expect.poll(async () => (await link.getAttribute('href')) !== null).toBe(true)
  await expect(row.getByTestId('engine-sign-in-finish')).toHaveText('Finish', { timeout: 30_000 })
  await row.screenshot({ path: shot('bad-code') })
  await video.hold(1500)

  // 3. The API key view and back: the field and its key stay where they are.
  const fieldLeft = await leftOf(page, 'engine-sign-in-code')
  const keyLeft = await leftOf(page, 'engine-sign-in-finish')
  await video.caption('Use a Gemini API key instead, and back: nothing moves')
  await row.getByTestId('engine-sign-in-use-key').click()
  await expect(row.getByTestId('engine-sign-in-key')).toBeVisible()
  await expect(row.getByTestId('engine-sign-in-key')).toHaveAttribute('type', 'password')
  await expect(row.getByTestId('engine-sign-in-save-key')).toBeDisabled()
  await expect(row.getByTestId('engine-sign-in-step')).toContainText('Only Antigravity uses it.')
  expect(await leftOf(page, 'engine-sign-in-key')).toBe(fieldLeft)
  expect(await leftOf(page, 'engine-sign-in-save-key')).toBe(keyLeft)
  await row.screenshot({ path: shot('api-key') })
  await video.hold()
  await row.getByTestId('engine-sign-in-use-google').click()
  await expect(row.getByTestId('engine-sign-in-code')).toBeVisible()
  expect(await leftOf(page, 'engine-sign-in-code')).toBe(fieldLeft)
  await video.hold()

  // 4. The right code; then out again.
  await video.caption('The code Google shows signs it in')
  await row.getByTestId('engine-sign-in-code').fill('')
  await row.getByTestId('engine-sign-in-code').pressSequentially('good', { delay: 40 })
  await row.getByTestId('engine-sign-in-finish').click()
  await expect(row.locator('.wn-notice-status')).toHaveText('Signed in with Google', { timeout: 60_000 })
  await expect(row.locator('.wn-notice-status')).toHaveAttribute('data-tone', 'ok')
  await expect(row.getByTestId('engine-sign-in-step')).toHaveCount(0)
  await expect(row.getByTestId('engine-sign-in-action')).toHaveText('Sign out')
  expect(firstLink).toBeTruthy()
  await row.screenshot({ path: shot('signed-in') })
  await video.hold(1500)
  await video.caption('Sign out')
  await row.getByTestId('engine-sign-in-action').click()
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 60_000 })
  await expect(row.getByTestId('engine-sign-in-action')).toHaveText('Sign in with Google')
  await video.hold(1500)
  await video.stop('engine-sign-in-settings')
})

test('the chat says the host is not signed in and opens its sign-in in Settings', async ({ page }) => {
  video = await startProofVideo(page)
  await openRefusingSession(page)
  const words = notSignedInSentence('antigravity', 'this computer')
  await video.caption('A message Antigravity refused: it is not signed in on this computer')
  await sendViaUi(page, 'Fix the flaky upload test')
  await expect.poll(() => sentIds(page)).toHaveLength(1)
  const [id] = await sentIds(page)
  await injectEvent(page, 'session:batch-failed', { sessionId: SESSION_ID, messageIds: [id], error: words, parked: true })
  const note = page.locator('[data-engine-sign-in="antigravity"].session-msg-agent-wait')
  await expect(note).toBeVisible({ timeout: 20_000 })
  await expect(note).toContainText('Antigravity is not signed in on this computer.')
  await expect(note).not.toContainText('Open Settings to sign in.')
  await expect(note.getByRole('button')).toHaveText(['Open Settings to sign in', 'Retry', 'Discard'])
  // Said once, on the message: no second red line above the composer.
  await expect(page.getByText(words)).toHaveCount(0)
  await note.screenshot({ path: shot('chat-note') })
  await video.hold(1500)

  await video.caption('Open Settings to sign in lands on that host, its sign-in open')
  await note.getByTestId('engine-sign-in-open-settings').click()
  await expect(page).toHaveURL(/\/settings#engine-sign-in-antigravity-__local__$/)
  const row = localRow(page)
  await expect(row.getByTestId('engine-sign-in-link')).toBeVisible({ timeout: 30_000 })
  await expect(row.getByTestId('engine-sign-in-code')).toBeInViewport()
  await video.hold(2000)
  await row.getByTestId('engine-sign-in-cancel').click()
  await expect(row.getByTestId('engine-sign-in-step')).toHaveCount(0)
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in')
  await video.stop('engine-sign-in-chat')
})

test('a turn that failed for want of a sign-in is one line whose link opens that host by its name', async ({ page }) => {
  await openRefusingSession(page)
  await injectEvent(page, 'session:error', { sessionId: SESSION_ID, error: notSignedInSentence('antigravity', 'this computer') })
  const line = page.locator('.session-system-line[data-engine-sign-in="antigravity"]')
  await expect(line).toContainText('Antigravity is not signed in on this computer.', { timeout: 20_000 })
  await line.getByTestId('engine-sign-in-open-settings').click()
  await expect(page).toHaveURL(/\/settings#engine-sign-in-antigravity$/)
  const row = localRow(page)
  await expect(row.getByTestId('engine-sign-in-link')).toBeVisible({ timeout: 30_000 })
  await row.getByTestId('engine-sign-in-cancel').click()
  await expect(row.getByTestId('engine-sign-in-step')).toHaveCount(0)
})

function shot(name: string): string {
  return `${process.env.ENGINE_SIGN_IN_SHOT_DIR ?? 'test-results/engine-sign-in'}/${name}.png`
}

// ── The chat harness: the real SPA and composer, the send RPC answered in the page, server events
//    injected on the socket (as bubble-late-delivered.spec.ts); Settings' calls stay real. ──

async function injectEvent(page: Page, name: string, data: unknown) {
  await page.evaluate(({ name, data }) => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    if (!ws) throw new Error('No captured WebSocket')
    const d = data as { messageIds?: string[]; error?: string; parked?: boolean }
    if (name === 'session:batch-failed' && d.parked) for (const id of d.messageIds ?? []) ((window as any).__parked ??= {})[id] = d.error ?? ''
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }) }))
  }, { name, data })
}

async function sendViaUi(page: Page, text: string) {
  const input = page.locator('textarea[aria-label="Send a message to this session"]').first()
  await input.click()
  await input.pressSequentially(text, { delay: 20 })
  await input.press('Enter')
}

const sentIds = (page: Page) => page.evaluate(() => (window as any).__sentMessageIds as string[])

async function openRefusingSession(page: Page) {
  await page.addInitScript((sid) => {
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
          const answer = (id: unknown, payload: unknown) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'res', id, ok: true, payload }),
          })), 10)
          this.send = (data: any) => {
            let intercepted = false
            try {
              const p = JSON.parse(data as string)
              if (p.type === 'req' && p.method === 'session:send' && p.payload?.sessionId === sid) {
                intercepted = true
                const messageId = `qm-sign-in${++n}`
                ;(window as any).__sentMessageIds.push(messageId)
                answer(p.id, { messageId })
              }
              if (p.type === 'req' && p.method === 'session:stream-subscribe' && p.payload?.sessionId === sid) {
                intercepted = true
                answer(p.id, { blocks: [], isStreaming: false })
              }
              if (p.type === 'req' && p.method === 'session:get-queue' && p.payload?.sessionId === sid) {
                intercepted = true
                // The server's queue as the real one holds it: a sent row waits, a refused one is parked with its reason.
                const parked = ((window as any).__parked ?? {}) as Record<string, string>
                answer(p.id, { messages: ((window as any).__sentMessageIds as string[]).map((id) => (parked[id]
                  ? { id, message: '', status: 'parked', parkedReason: parked[id], enqueuedAt: new Date().toISOString() }
                  : { id, message: '', status: 'pending', enqueuedAt: new Date().toISOString() })) })
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
  }, SESSION_ID)
  const history = [
    { role: 'user', text: 'Look at the upload worker', timestamp: '2026-11-23T00:00:00.000Z' },
    { role: 'assistant', text: 'The worker retries on a timer.', timestamp: '2026-11-23T00:00:10.000Z' },
  ]
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) =>
    route.fulfill({ json: { messages: history, cursor: history.length, delta: false } }))
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({ json: { session: {
      claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'bypass', engine: 'antigravity',
      startedAt: '2026-11-23T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'Fix the flaky upload test',
    } } })
  })
  await page.goto(`/sessions?id=${SESSION_ID}`)
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 30_000 })
  await expect(page.locator('.session-history')).toContainText('The worker retries on a timer.', { timeout: 30_000 })
}
