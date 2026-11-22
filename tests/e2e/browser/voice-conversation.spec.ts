/**
 * Voice conversation in a session's composer (experimental `voice_conversation`):
 * Talk opens it listening, a pause sends what was heard with the voice-reply hint,
 * the turn's answer is read aloud piece by piece from /api/v1/voice/speak, talking
 * over it stops it, and Keyboard brings the composer back. A server with no voice
 * falls back to the device's own (speechSynthesis, a no-op in an automated page).
 *
 * Chromium only: Playwright's Linux WebKit has no MediaRecorder.
 * The mic is the synthetic one (fake-mic.ts); its level is set by the test.
 * The session is the mock harness's; the transcription and speech routes are stubbed.
 */
import { expect, test, type Page } from '@playwright/test'
import { useSyntheticMic } from './fake-mic'
import { dropFakes } from './route-teardown'
import { injectEvent, MOCK_SESSION_ID, mockSession, open, waitForStream, waitForWs } from './mock-session-harness'

test.skip(({ browserName }) => browserName !== 'chromium', 'MediaRecorder: Chromium only on Linux')

// Keyboard remounts the composer, which reads /api/config again as the page closes.
test.afterEach(async ({ page }) => { await dropFakes(page) })

const LOUD = 0.3
const QUIET = 0.0005

/** A short silent WAV: decodable by Web Audio, so the server-voice path plays it (into the muted sink). */
function silentWav(ms: number): Buffer {
  const rate = 8000
  const n = Math.round(rate * ms / 1000)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

interface Captured { sends: { message: string; hints?: unknown }[]; speaks: string[] }

async function setup(page: Page, opts: { serverVoice: boolean }): Promise<Captured> {
  const captured: Captured = { sends: [], speaks: [] }
  await useSyntheticMic(page, { gain: QUIET })
  // The session:send RPC is answered here, so the message is "accepted" with no server session.
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      try {
        const parsed = JSON.parse(String(data))
        if (parsed.type === 'req' && parsed.method === 'session:send') {
          ;(window as unknown as { __voiceSends: unknown[] }).__voiceSends ??= []
          ;(window as unknown as { __voiceSends: unknown[] }).__voiceSends.push(parsed.payload ?? parsed.params ?? parsed.data)
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id: parsed.id, ok: true, payload: { messageId: `m-${Date.now()}` } }) })), 20)
          return
        }
      } catch { /* not JSON */ }
      return send.call(this, data as never)
    }
  })
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const json = await res.json()
    // The flag on for this page only (the shared fixture server's config is left alone).
    json.config.experimental = { ...(json.config.experimental ?? {}), voice_conversation: true }
    await route.fulfill({ response: res, json })
  })
  await page.route('**/api/stt/transcribe**', (route) => route.fulfill({ json: { text: 'What is on today?', durationMs: 900, recordingId: 'rec-voice-1' } }))
  await page.route('**/api/v1/voice/status', (route) => route.fulfill({ json: { engine: opts.serverVoice ? 'elevenlabs' : 'device', engines: [] } }))
  await page.route('**/api/v1/voice/speak', async (route) => {
    captured.speaks.push(JSON.parse(route.request().postData() ?? '{}').text)
    if (!opts.serverVoice) return route.fulfill({ status: 503, json: { error: { code: 'tts_unavailable', message: 'No voice engine on this server' } } })
    return route.fulfill({ status: 200, contentType: 'audio/mpeg', body: silentWav(1500) })
  })
  await mockSession(page, [], 'idle')
  return captured
}

async function sends(page: Page) {
  return page.evaluate(() => (window as unknown as { __voiceSends?: { message?: string; hints?: unknown }[] }).__voiceSends ?? [])
}

const micGain = (page: Page, g: number) => page.evaluate((v) => (window as unknown as { __micGain?: (g: number) => void }).__micGain?.(v), g)
const phase = (page: Page) => page.getByTestId('voice-bar').getAttribute('data-phase')

async function openVoice(page: Page) {
  await open(page)
  await waitForWs(page)
  await waitForStream(page)
  const column = page.locator(`.session-panel[data-session-id="${MOCK_SESSION_ID}"]`)
  await column.getByTestId('voice-talk-entry').click()
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening', { timeout: 20_000 })
  return column
}

async function talkAndPause(page: Page) {
  await micGain(page, LOUD)
  await page.waitForTimeout(900)
  await micGain(page, QUIET)
}

async function answer(page: Page, text: string) {
  await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: text })
}

test('talk, pause sends with the voice hint, the answer is read, then it listens again; Keyboard returns', async ({ page }) => {
  const captured = await setup(page, { serverVoice: true })
  const column = await openVoice(page)

  await talkAndPause(page)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  await expect(page.getByTestId('voice-heard')).toContainText('What is on today?')
  // While the turn works, the bar offers the composer's stop.
  await expect(column.getByTestId('voice-stop-run')).toBeVisible()
  const sent = await sends(page)
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(sent[0])).toContain('What is on today?')
  expect(JSON.stringify(sent[0])).toContain('voice-reply')

  await answer(page, 'Two meetings and one review. The first is at ten.\n\n---\n\n| time | what |\n|---|---|\n| 10:00 | standup |')
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'speaking', { timeout: 20_000 })
  await expect(page.getByTestId('voice-spoken')).toHaveText(/Two meetings and one review\. The first is at ten\. The rest is on screen\.$/)
  await expect(page.getByTestId('voice-engine')).toHaveText('Voice: ElevenLabs')
  // Read piece by piece: the first sentence alone, then the rest; never the table.
  await expect.poll(() => captured.speaks.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  expect(captured.speaks[0]).toBe('Two meetings and one review.')
  expect(captured.speaks.join(' ')).not.toContain('standup')

  // Done speaking: listening for the next thing said.
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening', { timeout: 15_000 })
  // Replay reads it again (the cached pieces, same words).
  await column.getByTestId('voice-replay').click()
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'speaking')
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening', { timeout: 15_000 })

  // A second round works the same.
  await talkAndPause(page)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  expect(await sends(page)).toHaveLength(2)

  await column.getByTestId('voice-close').click()
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(column.getByTestId('voice-talk-entry')).toBeVisible()
})

test('talking over the answer stops it and listens', async ({ page }) => {
  await setup(page, { serverVoice: true })
  await openVoice(page)
  await talkAndPause(page)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  await answer(page, 'This is a long answer. '.repeat(8))
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'speaking', { timeout: 20_000 })
  await micGain(page, LOUD)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening', { timeout: 5_000 })
  // Still talking: the new take is heard and goes out after the pause.
  await page.waitForTimeout(500)
  await micGain(page, QUIET)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  expect(await sends(page)).toHaveLength(2)
})

test('a server with no voice: the device speaks, and the bar says which voice', async ({ page }) => {
  const captured = await setup(page, { serverVoice: false })
  await openVoice(page)
  await expect(page.getByTestId('voice-engine')).toHaveText('Voice: built-in')
  await talkAndPause(page)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  await answer(page, 'Done.')
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'speaking', { timeout: 20_000 })
  // The device voice never asks the server for audio.
  expect(captured.speaks).toEqual([])
  const spoken = await page.evaluate(() => (window as unknown as { __walnutAudio?: { speech?: number } }).__walnutAudio?.speech ?? 0)
  expect(spoken).toBeGreaterThan(0)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening', { timeout: 20_000 })
})

test('an answer with nothing to say aloud goes back to listening; tap with nothing said pauses the mic', async ({ page }) => {
  await setup(page, { serverVoice: true })
  const column = await openVoice(page)
  await talkAndPause(page)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  await answer(page, '```ts\nconst x = 1\n```')
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening', { timeout: 20_000 })
  await column.getByTestId('voice-orb').click()
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'paused')
  expect(await phase(page)).toBe('paused')
  await column.getByTestId('voice-orb').click()
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening')
})

test('an answer marked interrupted is still read; the turn stopped from the bar is not', async ({ page }) => {
  // 2026-11-22, the Mac app: a voice message sent into a busy session came back marked
  // interrupted after a Stop and a retry, and its answer was never read.
  const captured = await setup(page, { serverVoice: true })
  const column = await openVoice(page)
  await talkAndPause(page)
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'waiting', { timeout: 20_000 })
  // Stop from the bar: back to listening, and that turn's interrupted result says nothing.
  await column.getByTestId('voice-stop-run').click()
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'listening')
  await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: 'Half an answer.', interrupted: true })
  await page.waitForTimeout(800)
  expect(captured.speaks).toEqual([])
  // The answer after the retry, still marked interrupted: read.
  await injectEvent(page, 'session:result', { sessionId: MOCK_SESSION_ID, result: 'Here is the real answer.', interrupted: true })
  await expect(page.getByTestId('voice-bar')).toHaveAttribute('data-phase', 'speaking', { timeout: 20_000 })
  await expect.poll(() => captured.speaks.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
  expect(captured.speaks[0]).toBe('Here is the real answer.')
})

test('a refused microphone says why and keeps the composer', async ({ page }) => {
  await setup(page, { serverVoice: true })
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, writable: true,
      value: async () => { throw new DOMException('denied', 'NotAllowedError') },
    })
  })
  await open(page)
  await waitForWs(page)
  const column = page.locator(`.session-panel[data-session-id="${MOCK_SESSION_ID}"]`)
  await column.getByTestId('voice-talk-entry').click()
  await expect(column.getByTestId('voice-mic-error')).toContainText('may not use the microphone')
  await expect(page.getByTestId('voice-bar')).toHaveCount(0)
  await expect(column.getByTestId('voice-talk-entry')).toBeVisible()
})
