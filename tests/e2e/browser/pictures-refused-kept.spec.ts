/**
 * A message whose picture the server refuses is never lost (2026-11-23, the user: messages, and
 * what they carry, are never lost; where something cannot go, the sender sees it).
 *
 *  (a) The Notes page's agent chat (useChat): a message queued behind a running turn goes out when
 *      the turn ends; the server refuses it for its picture (the REAL server's refusal: the
 *      queued `chat` RPC names an upload that is not on disk). Its bubble keeps the words and
 *      the picture and says "Not sent: …" with Retry; Retry with the picture that is there sends
 *      it, and the server accepts it.
 *  (b) A session's composer: a send the server refuses for its picture keeps the words and the
 *      picture where the person can send them again, and shows the reason.
 *
 * (a) runs against the fixture server, the WS routed in the page only to hold the first turn's
 * answer and to name a missing upload in the queued send. (b) uses the composer harness
 * (composer-send-harness.ts), whose `session:send` answers with the server's refusal words.
 */
import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { PNG, open } from './composer-send-harness'

test.describe.configure({ timeout: 180_000 })
// The video of each flow (the reviewer's look at it); 1280 wide, as every screenshot here.
test.use({ viewport: { width: 1280, height: 800 }, video: { mode: 'on', size: { width: 1280, height: 800 } } })
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const NOTE_AGENT_ID = 'note-agent'
const GONE_UPLOAD = '1700000000000-deadbeefcafe.png'

function shotPath(name: string): string {
  fs.mkdirSync(SHOTS, { recursive: true })
  return path.join(SHOTS, `${name}-${test.info().project.name}.png`)
}

/** The page's socket, passed through, with a hand on the `chat` RPCs it sends. */
interface ChatWire {
  chats: Array<{ id: string; payload: Record<string, unknown> }>
  answers: Map<string, { ok: boolean; error?: string }>
  /** Hold the server's answer to the Nth `chat` RPC (1-based) until released. */
  holdAnswerOf: (n: number) => void
  release: () => void
  /** Rewrite the Nth `chat` RPC's picture to an upload the server does not have. */
  goneUploadIn: (n: number) => void
}

async function routeChatWire(page: Page): Promise<ChatWire> {
  const wire: ChatWire = { chats: [], answers: new Map(), holdAnswerOf: () => {}, release: () => {}, goneUploadIn: () => {} }
  let holdN = 0
  let goneN = 0
  let heldId: string | null = null
  let held: Array<() => void> = []
  wire.holdAnswerOf = (n) => { holdN = n }
  wire.goneUploadIn = (n) => { goneN = n }
  wire.release = () => { heldId = null; holdN = 0; const go = held; held = []; for (const f of go) f() }
  await page.routeWebSocket(/\/ws(\?|$)/, (ws: WebSocketRoute) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString('utf8')
      let frame: { type?: string; id?: string; method?: string; payload?: Record<string, unknown> } | null = null
      try { frame = JSON.parse(text) } catch { /* not JSON */ }
      if (frame?.type === 'req' && frame.method === 'chat' && frame.id) {
        wire.chats.push({ id: frame.id, payload: { ...frame.payload } })
        const n = wire.chats.length
        if (n === holdN) heldId = frame.id
        if (n === goneN && Array.isArray(frame.payload?.imageRefs)) {
          server.send(JSON.stringify({ ...frame, payload: { ...frame.payload, imageRefs: [{ filename: GONE_UPLOAD }] } }))
          return
        }
      }
      server.send(message)
    })
    server.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString('utf8')
      let frame: { type?: string; id?: string; ok?: boolean; error?: string } | null = null
      try { frame = JSON.parse(text) } catch { /* not JSON */ }
      if (frame?.type === 'res' && frame.id && wire.chats.some((c) => c.id === frame!.id)) {
        wire.answers.set(frame.id, { ok: !!frame.ok, ...(frame.error ? { error: frame.error } : {}) })
        if (frame.id === heldId) { held.push(() => ws.send(message)); return }
      }
      ws.send(message)
    })
  })
  return wire
}

/** Open the Note Agent chat the way a person does: Notes in the side bar, then the AI toggle. */
async function openNoteAgentChat(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('a[href="/notes"]').first().click()
  const toggle = page.locator('.notes-ai-toggle')
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  if ((await toggle.getAttribute('aria-pressed')) === 'true') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  }
  const statsReq = page.waitForRequest((r) => {
    const url = new URL(r.url())
    return url.pathname === '/api/chat/stats' && url.searchParams.get('agentId') === NOTE_AGENT_ID && !!url.searchParams.get('conversationId')
  }, { timeout: 30_000 })
  await toggle.click()
  await statsReq
  await expect(page.locator('.notes-chat textarea')).toBeVisible()
}

test.describe('(a) the Notes agent chat', () => {
  test('a queued message refused for its picture keeps its bubble, says why, and Retry sends it', async ({ page }) => {
    const wire = await routeChatWire(page)
    await openNoteAgentChat(page)
    const chat = page.locator('.notes-chat')
    const input = chat.locator('textarea')
    const nonce = Date.now().toString(36)

    // The first message's answer is held, so the chat stays busy and the next one queues.
    wire.holdAnswerOf(1)
    await input.fill(`first question ${nonce}`)
    await input.press('Enter')
    await expect.poll(() => wire.chats.length, { timeout: 20_000 }).toBe(1)

    // The second, with a picture, queues behind it; when it goes, the server is asked for an
    // upload it does not have, and refuses.
    wire.goneUploadIn(2)
    // A picture a person can see in the bubble (320x180), not a 1x1 dot.
    const sharp = (await import('sharp')).default
    const layout = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 31, g: 111, b: 235 } } }).png().toBuffer()
    await chat.getByTestId('composer-file-input').setInputFiles({ name: 'layout.png', mimeType: 'image/png', buffer: layout })
    await expect(chat.locator('.chat-input-container .chat-image-preview')).toHaveCount(1, { timeout: 20_000 })
    const words = `is the header cut off here? ${nonce}`
    await input.fill(words)
    await input.press('Enter')
    const bubble = chat.locator('.chat-message-user').filter({ hasText: words })
    await expect(bubble.locator('.chat-queued-badge')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(800)

    wire.release()
    await expect.poll(() => wire.chats.length, { timeout: 30_000 }).toBe(2)
    const failed = bubble.getByTestId('chat-send-failed')
    await expect(failed).toBeVisible({ timeout: 30_000 })
    await expect(failed).toContainText(/Not sent: .*no longer on the server/)
    // The answer that refused it is the server's own.
    expect(wire.answers.get(wire.chats[1]!.id)).toMatchObject({ ok: false, error: expect.stringMatching(/no longer on the server/) })
    // The words and the picture are still there, on the bubble.
    await expect(bubble).toContainText(words)
    await expect(bubble.locator('.chat-message-image')).toHaveCount(1)
    await page.waitForTimeout(800)
    await bubble.screenshot({ path: shotPath('notes-chat-refused-bubble') })

    // Retry, with the picture that is on the server: the same words and picture go, and are accepted.
    await failed.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => wire.chats.length, { timeout: 30_000 }).toBe(3)
    const retried = wire.chats[2]!
    expect(String(retried.payload.message)).toContain(words)
    expect(retried.payload.imageRefs).toEqual(wire.chats[1]!.payload.imageRefs)
    expect((retried.payload.imageRefs as Array<{ filename: string }>)[0]!.filename).not.toBe(GONE_UPLOAD)
    await expect.poll(() => wire.answers.get(retried.id)?.ok, { timeout: 60_000 }).toBe(true)
    await expect(bubble.getByTestId('chat-send-failed')).toHaveCount(0)
    await expect(bubble.locator('.chat-message-image')).toHaveCount(1)
    await page.waitForTimeout(1500)
    await bubble.screenshot({ path: shotPath('notes-chat-retried-bubble') })
  })
})

test.describe('(b) a session composer', () => {
  test('a send refused for its picture keeps the words and the picture and shows the reason', async ({ page }) => {
    const h = await open(page)
    const composer = page.locator('.session-panel-input .chat-input-container').last()
    await composer.getByTestId('composer-file-input').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG })
    await expect(composer.locator('.chat-image-preview')).toHaveCount(1)
    const reason = 'The picture is no longer on the server. Remove it and attach it again.'
    await page.evaluate((r) => sessionStorage.setItem('pw-refuse-send', r), reason)
    const words = 'what is wrong with this layout?'
    const input = composer.locator('textarea')
    await input.fill(words)
    await input.press('Enter')
    await expect.poll(async () => (await h.sent()).length, { timeout: 20_000 }).toBe(1)
    expect((await h.sent())[0]!.imageRefs).toEqual([{ filename: '1-abc.png' }])

    // The reason is shown on the failed message, with Retry.
    await expect(page.getByText(`Send failed: ${reason}`).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
    // The composer keeps the draft: the words and the picture, to send again.
    await expect(input).toHaveValue(words)
    await expect(composer.locator('.chat-image-preview')).toHaveCount(1)
    await page.waitForTimeout(500)
    await page.locator('.session-panel').last().screenshot({ path: shotPath('session-composer-refused') })
  })
})
