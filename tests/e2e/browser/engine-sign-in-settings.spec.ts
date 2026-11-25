/**
 * Settings > Sessions, "Antigravity sign-in", walked as a person does, on the fixture's own
 * Antigravity CLI (fake-agy-fixture.ts through WALNUT_ANTIGRAVITY_PATH: the code "good" signs it
 * in, any other code is refused; its Install runs the installer line against a fake curl):
 *
 *   1. this computer reads Not signed in; Sign in with Google opens ONE row: the link, the code
 *      field and Finish (off while the field is empty); a wrong code says what to do and leaves a
 *      new link behind the same words; "Use a Gemini API key instead" ends it and brings the
 *      group's one key row; the right code signs it in; Sign out signs it out
 *   2. the API key, one row for every machine: Save signs the host in "with API key", Remove undoes it
 *   3. a host without the CLI: Not installed with the installer line and Copy; Install shows its
 *      progress and ends on Not signed in
 *   4. every state of a host row at once (two hosts and more, answered by a stubbed list), wide and
 *      at 900 px
 *   5. the chat: a message the host refused for want of a sign-in says so (it goes out by itself
 *      once signed in) with Open Settings to sign in, Retry and Discard; the link lands on that
 *      host's row with its sign-in open; a failed turn's line links there by the host's name
 *
 * PROOF_VIDEO_DIR=<dir> records a sharp walk-through (proof-video.ts: screencast, pointer, captions).
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { startProofVideo, type ProofVideo } from './proof-video'
import { notSignedInSentence } from '../../../src/core/agents/engine-sign-in-words'
import { reinstallFakeAgy, uninstallFakeAgy } from './fake-agy-fixture'
import { draftEngineButton, openDraft } from './draft-helpers'

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: process.env.PROOF_VIDEO_DIR ? 2 : 1 })

const LOCAL = '__local__'
const BAD_CODE = "That code didn't work. Open Google sign-in to get a new one."
const SESSION_ID = 'pw-engine-sign-in-session'
const TASK_ID = 'pw-engine-sign-in-task'
/** At least this long on every result in a proof video. */
const HOLD = 1600

let video: ProofVideo

/** This computer's Antigravity, installed, signed out, with no key and no sign-in waiting: each test starts here. */
async function signedOut(request: APIRequestContext): Promise<void> {
  reinstallFakeAgy()
  await request.post('/api/engines/antigravity/sign-in/cancel', { data: { host: LOCAL } })
  await request.delete(`/api/engines/antigravity/api-key?host=${LOCAL}`)
  const out = await request.post('/api/engines/antigravity/sign-out', { data: { host: LOCAL } })
  expect(out.ok(), await out.text()).toBe(true)
  expect((await out.json()).status.state).toBe('not_signed_in')
}

const group = (page: Page) => page.getByTestId('engine-sign-in-group-antigravity')
const localRow = (page: Page) => page.getByTestId(`engine-sign-in-${LOCAL}`)
const keyRow = (page: Page) => page.getByTestId('engine-sign-in-key-row')

async function openSessionsSettings(page: Page): Promise<void> {
  await page.locator('.sidebar a[href^="/settings"]').first().click()
  await page.getByTestId('settings-nav-sessions').click()
  await expect(page.locator('#sessions.settings-section')).toBeVisible({ timeout: 20_000 })
  await group(page).scrollIntoViewIfNeeded()
}

async function home(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
}

test.beforeEach(async ({ request }) => { await signedOut(request) })
test.afterEach(() => { reinstallFakeAgy() })

test('signs this computer in with Google, through a wrong code and the key row, then out', async ({ page }) => {
  video = await startProofVideo(page)
  await home(page)
  await video.caption('Settings > Sessions: Antigravity sign-in')
  await openSessionsSettings(page)

  const row = localRow(page)
  await expect(row.getByTestId('engine-sign-in-row')).toContainText('This computer')
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 30_000 })
  await expect(row.locator('.wn-notice-status')).toHaveAttribute('data-tone', 'muted')
  await expect(keyRow(page)).toContainText('Not set')
  await video.hold(HOLD)
  await video.caption('Sign in with Google opens one row: the link, the code and Finish')
  await row.getByTestId('engine-sign-in-action').click()
  const link = row.getByTestId('engine-sign-in-link')
  await expect(link).toHaveText('Open Google sign-in ↗', { timeout: 30_000 })
  await expect(link).toHaveAttribute('href', /^https:\/\/accounts\.google\.com\//)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(row.getByTestId('engine-sign-in-finish')).toBeDisabled()
  await expect(row.getByTestId('engine-sign-in-cancel')).toBeVisible()
  await expect(row.getByTestId('engine-sign-in-step')).toContainText('Paste the code it shows.')
  await row.screenshot({ path: shot('step-open') })
  await video.hold(HOLD)

  await video.caption('A wrong code says what to do')
  await row.getByTestId('engine-sign-in-code').click()
  await row.getByTestId('engine-sign-in-code').pressSequentially('4/0Ab-not-it', { delay: 40 })
  await expect(row.getByTestId('engine-sign-in-finish')).toBeEnabled()
  await row.getByTestId('engine-sign-in-finish').click()
  await expect(row.getByRole('alert')).toHaveText(BAD_CODE, { timeout: 60_000 })
  await expect(row.getByTestId('engine-sign-in-code')).toHaveAttribute('aria-invalid', 'true')
  // That sign-in ended in the CLI: the same words open a new one, and Finish takes the next code.
  await expect(link).toBeVisible({ timeout: 30_000 })
  await expect(row.getByTestId('engine-sign-in-finish')).toBeEnabled({ timeout: 30_000 })
  await row.screenshot({ path: shot('bad-code') })
  await video.hold(HOLD)

  await video.caption('Use a Gemini API key instead: the one key row, for every machine')
  await row.getByTestId('engine-sign-in-use-key').click()
  await expect(row.getByTestId('engine-sign-in-step')).toHaveCount(0)
  await expect(keyRow(page).getByTestId('engine-sign-in-key')).toBeFocused()
  await expect(keyRow(page).getByTestId('engine-sign-in-key')).toBeInViewport()
  await expect(keyRow(page).getByTestId('engine-sign-in-save-key')).toBeDisabled()
  await video.hold(HOLD)

  await video.caption('Back to Google: the code Google shows signs it in')
  await row.getByTestId('engine-sign-in-action').click()
  await expect(link).toBeVisible({ timeout: 30_000 })
  await row.getByTestId('engine-sign-in-code').pressSequentially('good', { delay: 60 })
  await row.getByTestId('engine-sign-in-finish').click()
  await expect(row.locator('.wn-notice-status')).toHaveText('Signed in with Google', { timeout: 60_000 })
  await expect(row.locator('.wn-notice-status')).toHaveAttribute('data-tone', 'ok')
  await expect(row.getByTestId('engine-sign-in-step')).toHaveCount(0)
  await expect(row.getByTestId('engine-sign-in-action')).toHaveText('Sign out')
  await row.screenshot({ path: shot('signed-in') })
  await video.hold(HOLD)
  await video.caption('Sign out')
  await row.getByTestId('engine-sign-in-action').click()
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 60_000 })
  await expect(row.getByTestId('engine-sign-in-action')).toHaveText('Sign in with Google')
  await video.hold(HOLD)
  await video.stop('engine-sign-in-settings')
})

test('the Gemini API key is one row for every machine: Save signs the host in with it, Remove undoes it', async ({ page }) => {
  await home(page)
  await openSessionsSettings(page)
  const row = localRow(page)
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 30_000 })
  const field = keyRow(page).getByTestId('engine-sign-in-key')
  await expect(field).toHaveAttribute('type', 'password')
  await field.pressSequentially('AIza-placeholder-key-0001', { delay: 10 })
  await keyRow(page).getByTestId('engine-sign-in-save-key').click()
  await expect(keyRow(page)).toContainText('Set, used on every machine', { timeout: 30_000 })
  await expect(row.locator('.wn-notice-status')).toHaveText('Signed in with API key', { timeout: 30_000 })
  // The key is not this host's to remove: no button on the host row.
  await expect(row.getByTestId('engine-sign-in-action')).toHaveCount(0)
  await group(page).screenshot({ path: shot('api-key-set') })
  await keyRow(page).getByTestId('engine-sign-in-remove-key').click()
  await expect(keyRow(page)).toContainText('Not set', { timeout: 30_000 })
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 30_000 })
})

test('a host without the CLI: Not installed with the installer line, and Install ends on Not signed in', async ({ page }) => {
  uninstallFakeAgy()
  video = await startProofVideo(page)
  await home(page)
  await video.caption('A host without Antigravity: the installer line, Copy, and Install')
  await openSessionsSettings(page)
  const row = localRow(page)
  await expect(row.locator('.wn-notice-status')).toHaveText('Not installed', { timeout: 30_000 })
  await expect(row.getByTestId('engine-sign-in-install-command')).toContainText('curl -fsSL https://antigravity.google/cli/install.sh | bash')
  await expect(row.getByTestId('engine-sign-in-install-command').getByRole('button', { name: /^Copy/ })).toBeVisible()
  const install = row.getByTestId('engine-sign-in-action')
  await expect(install).toHaveText('Install on this computer')
  await row.screenshot({ path: shot('not-installed') })
  await video.hold(HOLD)
  await install.click()
  await expect(row.locator('.wn-notice-status')).toHaveText('Installing', { timeout: 20_000 })
  await expect(row.locator('.wn-notice-status')).toHaveAttribute('data-tone', 'live')
  await expect(install).toHaveText('Installing on this computer...')
  await row.screenshot({ path: shot('installing') })
  await video.caption('Installing: the row follows the install, then reads the host again')
  await video.hold(HOLD)
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 60_000 })
  await expect(row.getByTestId('engine-sign-in-install-command')).toHaveCount(0)
  await expect(install).toHaveText('Sign in with Google')
  await video.caption('Installed: the host now reads Not signed in')
  await video.hold(HOLD * 1.5)
  await video.stop('engine-sign-in-install')
})

/** A host's answer as the server gives it, for the stubbed list of every state. */
test("the picker's locked Antigravity on a host without it: Install goes to that host's row and starts the install", async ({ page }) => {
  uninstallFakeAgy()
  // Antigravity on the rail, whatever this server's picker list says (it is not one of the default four),
  await page.route('**/api/engines', async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { engines: Array<{ id: string; inPicker?: boolean; availability?: unknown }> }
    // ...and read as this machine without it now (the catalog's probe is cached; Settings reads the host again).
    for (const e of body.engines) {
      if (e.id === 'antigravity') Object.assign(e, { inPicker: true, availability: { installed: false, version: null, reason: 'agy is not installed' } })
    }
    await route.fulfill({ response, json: body })
  })
  video = await startProofVideo(page)
  await home(page)
  await video.caption('A new task on this computer, which has no Antigravity: its engine is locked')
  const panel = await openDraft(page)
  const button = await draftEngineButton(page, panel, 'antigravity')
  await expect(button).toHaveClass(/provider-rail-item-locked/)
  // A locked row is aria-disabled, which Playwright reads as "not enabled"; a person can still press
  // it, and the press is what shows the note.
  await button.click({ force: true })
  const note = page.getByTestId('model-picker-locked-note')
  await expect(note).toContainText('Antigravity: Not installed here')
  const setup = note.getByTestId('model-picker-locked-setup')
  await expect(setup).toHaveText('Install Antigravity')
  await video.hold(HOLD)
  await setup.click()
  await video.caption("Install: Settings opens on this computer's row, and the install runs")
  const row = localRow(page)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('.wn-notice-status')).toHaveText('Installing', { timeout: 20_000 })
  await video.hold(HOLD)
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in', { timeout: 60_000 })
  await expect(row.getByTestId('engine-sign-in-action')).toHaveText('Sign in with Google')
  await video.caption('Installed: the next step is its sign-in')
  await video.hold(HOLD * 1.5)
  await video.stop('engine-sign-in-from-picker')
})

function hostStatus(host: string, hostName: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: 'antigravity', host, hostName, state: 'not_signed_in', installed: true, version: '1.5.14', reason: null, method: null, google: false,
    apiKey: { set: false, source: null }, signIn: null, connected: true, checkedAt: new Date().toISOString(),
    install: { state: 'idle', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', canInstall: false }, ...over,
  }
}

test('every state of a host row, wide and at 900 px', async ({ page }) => {
  await page.route('**/api/engines/antigravity/sign-in/hosts', (route) => route.fulfill({ json: { engine: 'antigravity', hosts: [
    hostStatus(LOCAL, 'this computer', { state: 'signed_in', method: 'google', google: true }),
    hostStatus('clouddev', 'clouddev', {}),
    hostStatus('devbox-2', 'devbox-2', { state: 'not_installed', installed: false, version: null, reason: 'agy is not installed',
      install: { state: 'idle', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', canInstall: true } }),
    hostStatus('buildbox', 'buildbox', { state: 'unknown', connected: false, installed: null, reason: 'buildbox is not connected now; open it to check' }),
    hostStatus('keybox', 'keybox', { state: 'signed_in', method: 'api-key', apiKey: { set: true, source: 'host-env' } }),
  ] } }))
  await home(page)
  await openSessionsSettings(page)
  const words = group(page).locator('.wn-notice-status')
  await expect(words).toHaveText(['Signed in with Google', 'Not signed in', 'Not installed', 'Not connected', 'Signed in with its own API key', 'Not set'])
  await expect(page.getByTestId('engine-sign-in-buildbox').getByTestId('engine-sign-in-action')).toHaveText('Check now')
  // The installer line shows whole, wrapped in its box under the state, Install at the row's right.
  const chip = page.getByTestId('engine-sign-in-devbox-2').locator('.hc-chip')
  const whole = async () => chip.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).whiteSpace === 'pre-wrap')
  expect(await whole()).toBe(true)
  const installBox = await page.getByTestId('engine-sign-in-devbox-2').getByTestId('engine-sign-in-action').boundingBox()
  const chipBox = await chip.boundingBox()
  expect(installBox!.x).toBeGreaterThan(chipBox!.x + chipBox!.width)
  await group(page).screenshot({ path: shot('all-states') })
  await page.setViewportSize({ width: 900, height: 900 })
  await group(page).scrollIntoViewIfNeeded()
  // Nothing sticks out of the group: the installer line scrolls inside its own chip (HostCommands,
  // as everywhere), and every row's controls stay inside the card.
  const out = await group(page).evaluate((el) => {
    const box = el.getBoundingClientRect()
    return [...el.querySelectorAll<HTMLElement>('button, input, .hc')].filter((n) => {
      const r = n.getBoundingClientRect()
      return r.width > 0 && (r.left < box.left - 1 || r.right > box.right + 1)
    }).map((n) => n.textContent ?? n.tagName)
  })
  expect(out).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await whole()).toBe(true)
  await group(page).screenshot({ path: shot('all-states-900') })
})

test('the chat says the host is not signed in, and its link lands on that host with its sign-in open', async ({ page }) => {
  video = await startProofVideo(page)
  await openRefusingSession(page)
  const words = notSignedInSentence('antigravity', 'this computer')
  await video.caption('A message to an Antigravity session on this computer')
  await sendViaUi(page, 'Fix the flaky upload test')
  await expect.poll(() => sentIds(page)).toHaveLength(1)
  const [id] = await sentIds(page)
  await video.hold(HOLD)
  await injectEvent(page, 'session:batch-failed', { sessionId: SESSION_ID, messageIds: [id], error: words, parked: true, waitsFor: 'engine_sign_in' })
  const note = page.locator('[data-engine-sign-in="antigravity"].session-msg-agent-wait')
  await expect(note).toBeVisible({ timeout: 20_000 })
  await video.caption('Antigravity is not signed in there: it says so, and the message waits for the sign-in')
  await expect(note).toContainText('Antigravity is not signed in on this computer. Sign in and this message goes out by itself.')
  await expect(note).not.toContainText('Open Settings to sign in.')
  await expect(note.getByRole('button')).toHaveText(['Open Settings to sign in', 'Retry', 'Discard'])
  // Said once, on the message: no second red line above the composer, and no fixture banner.
  await expect(page.getByText(words)).toHaveCount(0)
  await expect(page.getByText('Recovery status unavailable')).toHaveCount(0)
  await page.locator('.session-history').screenshot({ path: shot('chat-note') })
  await video.hold(HOLD * 1.5)

  await video.caption('Open Settings to sign in lands on that host, its sign-in open')
  await note.getByTestId('engine-sign-in-open-settings').click()
  await expect(page).toHaveURL(/\/settings#engine-sign-in-antigravity-__local__$/)
  const row = localRow(page)
  await expect(row.getByTestId('engine-sign-in-link')).toBeVisible({ timeout: 30_000 })
  await expect(row.getByTestId('engine-sign-in-code')).toBeInViewport()
  // The landing points at the whole host (its row and its sign-in line) with a soft tint, no ring.
  await expect(row).toHaveClass(/settings-anchor-flash-strong/)
  const ring = await row.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(ring === 'none' || !/rgb/.test(ring)).toBe(true)
  // The group only: a shot taller than the window resizes it, which a proof video shows as a jump.
  await group(page).screenshot({ path: shot('landing') })
  await video.hold(HOLD * 1.5)
  await row.getByTestId('engine-sign-in-cancel').click()
  await expect(row.getByTestId('engine-sign-in-step')).toHaveCount(0)
  await expect(row.locator('.wn-notice-status')).toHaveText('Not signed in')
  await video.hold(HOLD)
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
    const d = data as { messageIds?: string[]; error?: string; parked?: boolean; waitsFor?: string }
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
                  ? { id, message: '', status: 'parked', parkedReason: parked[id], waitsFor: 'engine_sign_in', enqueuedAt: new Date().toISOString() }
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
  // The session's recovery status as a healthy one answers it (the fixture's server has no such session).
  await page.route(`**/api/sessions/${SESSION_ID}/supervision`, (route) => route.fulfill({ json: {
    available: true, startup: 'on-demand', stopRequest: null,
    supervision: { enabled: false, state: 'inactive', reason: null, generation: 0, retryAt: null, updatedAt: Date.now() },
  } }))
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
