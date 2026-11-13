/**
 * Playwright: a session's composer takes any file (a log, a PDF, a zip), not
 * only pictures. Each attachment uploads as it is attached, with its own
 * progress; a failed one says why and can be retried or removed on its own; the
 * message waits for every upload, then names the saved paths under the
 * `[Files attached …]` header, and the bubble shows file cards instead of paths.
 *
 * Harness: the real SPA and composer, the session's REST reads and the upload
 * routes answered in the page (so a slow or failing host is controlled), the WS
 * `session:send` RPC captured.
 */
import { test, expect, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-file-attach-session'
const TASK_ID = 'pw-file-attach-task'
const HOST_DIR = '/home/me/.local/state/open-walnut/tasks/pw-file-attach-task/uploads'
const FILES_LINE = '[Files attached — open them from these paths]'
const SHOTS = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '/tmp/composer-file-attachments'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

type ChunkPlan = (name: string, attempt: number) => { status: number; body?: unknown; delayMs?: number }

interface Harness {
  sent: () => Promise<Array<{ message: string; imageRefs?: Array<{ filename: string }> }>>
  chunks: Array<{ url: string; size: number }>
  setPlan: (plan: ChunkPlan) => void
  /** The most chunk requests the host held open at one time. */
  peak: () => number
  setImageFailure: (message: string | null) => void
}

const ok: ChunkPlan = () => ({ status: 200 })

// A cold page on a loaded test host can take a while to open its socket.
test.describe.configure({ timeout: 180_000 })

async function open(page: Page, history: unknown[] = []): Promise<Harness> {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.addInitScript(() => {
    (window as any).__sent = []
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
              if (p.type === 'req' && p.method === 'session:send') {
                intercepted = true
                ;(window as any).__sent.push({ message: p.payload.message, imageRefs: p.payload.imageRefs })
                ;(window as any).__lastSendId = p.id
                // A held send never hears back (the server has not confirmed it).
                if (!sessionStorage.getItem('pw-hold-send')) answer(p.id, { messageId: `qm-file${++n}` })
              }
              if (p.type === 'req' && p.method === 'session:stream-subscribe') { intercepted = true; answer(p.id, { blocks: [], isStreaming: false }) }
              if (p.type === 'req' && p.method === 'session:get-queue' && p.payload?.sessionId === 'pw-file-attach-session') { intercepted = true; answer(p.id, { messages: [] }) }
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
  const rows = [
    { role: 'user', text: 'earlier question', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: 'earlier answer', timestamp: '2026-01-01T00:00:10.000Z' },
    ...history,
  ]
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, (route) =>
    route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } }))
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({ json: { session: {
      claudeSessionId: SESSION_ID, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'bypass',
      startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: new Date().toISOString(), messageCount: 2, title: 'File attachments',
    } } })
  })

  let plan: ChunkPlan = ok
  const attempts = new Map<string, number>()
  const chunks: Array<{ url: string; size: number }> = []
  // The host: holds each upload's bytes and answers like PUT /api/v1/sessions/:id/uploads/:uploadId.
  const held = new Map<string, number>()
  const sizeByPath = new Map<string, number>()
  let open = 0
  let peak = 0
  await page.route(`**/api/v1/sessions/${SESSION_ID}/uploads/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    const uploadId = url.pathname.split('/').pop()!
    const name = url.searchParams.get('name')!
    const size = Number(url.searchParams.get('size'))
    const offset = Number(url.searchParams.get('offset'))
    // WebKit's interception does not hand over a Blob body, so a chunk's length is read from its place in the file.
    const length = Math.min(2 * 1024 * 1024, size - offset)
    chunks.push({ url: url.pathname + url.search, size: length })
    const attempt = (attempts.get(name) ?? 0) + 1
    attempts.set(name, attempt)
    const step = plan(name, attempt)
    open++
    peak = Math.max(peak, open)
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
    open--
    if (step.status !== 200) return route.fulfill({ status: step.status, json: step.body ?? { error: { code: 'upload_failed', message: 'failed' } } })
    const have = Math.max(held.get(uploadId) ?? 0, offset + length)
    held.set(uploadId, have)
    const done = have === size
    if (done) sizeByPath.set(`${HOST_DIR}/${uploadId}/${name}`, size)
    return route.fulfill({ json: { received: have, size, done, ...(done ? { path: `${HOST_DIR}/${uploadId}/${name}` } : {}) } })
  })
  // What the host says of the files a sent message names (the bubble's sizes).
  await page.route('**/api/files/exists', async (route) => {
    const { paths } = route.request().postDataJSON() as { paths: string[] }
    const exists: Record<string, boolean> = {}
    const sizes: Record<string, number> = {}
    for (const p of paths) { const n = sizeByPath.get(p); exists[p] = n !== undefined; if (n !== undefined) sizes[p] = n }
    await route.fulfill({ json: { exists, sizes } })
  })
  let imageFailure: string | null = null
  await page.route('**/api/images/upload', (route) => (imageFailure
    ? route.fulfill({ status: 507, json: { error: imageFailure } })
    : route.fulfill({ json: { url: '/api/images/1-abc.png', filename: '1-abc.png', mediaType: 'image/png' } })))
  await page.route('**/api/local-image**', (route) => route.fulfill({ contentType: 'image/png', body: PNG }))
  await page.route('**/api/images/1-abc.png', (route) => route.fulfill({ contentType: 'image/png', body: PNG }))

  await page.goto(`/sessions?id=${SESSION_ID}`)
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 90_000 })
  await expect(page.locator('.session-history')).toContainText('earlier answer', { timeout: 30_000 })
  return {
    sent: () => page.evaluate(() => (window as any).__sent),
    chunks,
    setPlan: (p) => { plan = p },
    peak: () => peak,
    setImageFailure: (m) => { imageFailure = m },
  }
}

/** Paste one file into the composer's text, the way a person's Cmd+V does. */
async function pasteFile(page: Page, name: string, type: string, base64: string) {
  await page.evaluate(({ name, type, base64 }) => {
    const areas = document.querySelectorAll('.session-panel-input .chat-input-container textarea')
    const el = areas[areas.length - 1] as HTMLTextAreaElement
    el.focus()
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], name, { type }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, { name, type, base64 })
}

const composer = (page: Page) => page.locator('.session-panel-input .chat-input-container').last()
const fileInput = (page: Page) => composer(page).locator('input[type="file"]')
const card = (page: Page, name: string) => composer(page).locator('.file-card').filter({ hasText: name })

function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  return composer(page).screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

test('files of any type upload as attached, the message names their paths, the bubble shows cards', async ({ page }) => {
  const h = await open(page)
  // A slow host, so the progress is visible.
  h.setPlan(() => ({ status: 200, delayMs: 5000 }))
  await fileInput(page).setInputFiles([
    { name: 'build-2026-11-07.log', mimeType: 'text/plain', buffer: Buffer.from('ERROR something broke\n'.repeat(200)) },
    { name: 'report final.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(3 * 1024 * 1024 + 17, 1) },
  ])
  await expect(card(page, 'build-2026-11-07.log')).toBeVisible()
  await expect(card(page, 'report final.pdf')).toContainText(/\d+% of|Waiting/)
  // No limit is hit, so no limit is said (2026-11-09, the user: "don't show this").
  await expect(composer(page)).not.toContainText(/Up to \d|per message|GB each|goes? as (a )?files?/)
  // Sent while the uploads run: it waits for them, says so, and then goes by itself.
  const input = composer(page).locator('textarea')
  await input.click()
  await input.fill('why does the build fail?')
  await input.press('Enter')
  await expect(composer(page).locator('.chat-attachments-note')).toContainText(/Sends when the (2 )?uploads? finish/)
  await expect(composer(page).getByRole('button', { name: "Don't send yet" })).toBeVisible()
  await shot(page, 'uploading')
  expect(await h.sent()).toHaveLength(0)
  await expect.poll(async () => (await h.sent()).length, { timeout: 40_000 }).toBe(1)
  // The 3 MB file went in two chunks, the second carrying the checksum.
  const pdfChunks = h.chunks.filter((c) => c.url.includes('report%20final.pdf') || c.url.includes('report+final.pdf'))
  expect(pdfChunks.map((c) => c.size)).toEqual([2 * 1024 * 1024, 1024 * 1024 + 17])
  expect(pdfChunks[1].url).toMatch(/sha256=[0-9a-f]{64}/)
  const [msg] = await h.sent()
  const lines = msg.message.split('\n')
  expect(lines[0]).toBe(FILES_LINE)
  expect(lines[1]).toMatch(new RegExp(`^- ${HOST_DIR}/up-[^/]+/build-2026-11-07\\.log$`))
  expect(lines[2]).toMatch(new RegExp(`^- ${HOST_DIR}/up-[^/]+/report final\\.pdf$`))
  expect(lines.slice(3).join('\n')).toBe('\nwhy does the build fail?')
  // The composer is empty again; the bubble shows the files as cards and the words, not the paths.
  await expect(composer(page).locator('.file-card')).toHaveCount(0)
  const bubble = page.locator('.session-history .session-msg-user').filter({ hasText: 'why does the build fail?' }).last()
  await expect(bubble.locator('.file-card')).toHaveCount(2)
  await expect(bubble.locator('.file-card').first()).toContainText('build-2026-11-07.log')
  // The bubble asks the host for each file's size (the message carries only paths).
  await expect(bubble.locator('.file-card').nth(1)).toContainText('3 MB')
  await expect(bubble).not.toContainText(HOST_DIR)
  await expect(bubble).not.toContainText('Files attached')
  await bubble.screenshot({ path: path.join(SHOTS, 'sent-bubble.png') })
})

test('a failed upload says why, blocks the send, and can be retried or removed on its own', async ({ page }) => {
  const h = await open(page)
  h.setPlan((name, attempt) => (name === 'core.zip' && attempt === 1
    ? { status: 507, body: { error: { code: 'host_disk_full', message: "The session's host does not have room for this file." } } }
    : { status: 200 }))
  await fileInput(page).setInputFiles([
    { name: 'core.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004zip') },
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# notes') },
    { name: 'extra.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2') },
  ])
  const failed = card(page, 'core.zip')
  await expect(failed).toHaveClass(/is-failed/)
  await expect(failed).toContainText("Not uploaded: The session's host does not have room for this file.")
  await expect(composer(page).locator('.chat-attachments-note')).toContainText('1 upload failed: retry or remove it to send')
  const input = composer(page).locator('textarea')
  await input.fill('look at these')
  await expect(composer(page).locator('.chat-send-btn-icon')).toBeDisabled()
  await input.press('Enter')
  expect(await h.sent()).toHaveLength(0)
  await shot(page, 'failed')

  // Remove one file on its own; the others stay.
  await card(page, 'extra.csv').getByRole('button', { name: 'Remove extra.csv' }).click()
  await expect(card(page, 'extra.csv')).toHaveCount(0)
  await expect(card(page, 'notes.md')).toBeVisible()

  // Retry the failed one: it uploads under a new id and the send opens.
  await failed.getByRole('button', { name: 'Retry uploading core.zip' }).click()
  await expect(failed).not.toHaveClass(/is-failed/)
  await expect(composer(page).locator('.chat-send-btn-icon')).toBeEnabled()
  await input.press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
  const [msg] = await h.sent()
  expect(msg.message).toContain('/core.zip')
  expect(msg.message).toContain('/notes.md')
  expect(msg.message).not.toContain('extra.csv')
})

test('dropped and pasted files attach too; a picture stays a picture, uploaded once', async ({ page }) => {
  const h = await open(page)
  await page.evaluate(() => {
    const target = document.querySelectorAll('.session-panel-input .chat-input-container')
    const box = target[target.length - 1]
    const dt = new DataTransfer()
    dt.items.add(new File(['{"ok":true}'], 'config.json', { type: 'application/json' }))
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(card(page, 'config.json')).toBeVisible()
  await page.evaluate(() => {
    const areas = document.querySelectorAll('.session-panel-input .chat-input-container textarea')
    const el = areas[areas.length - 1] as HTMLTextAreaElement
    el.focus()
    const dt = new DataTransfer()
    dt.items.add(new File(['fn main() {}'], 'main.rs', { type: '' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(card(page, 'main.rs')).toBeVisible()
  // A PNG (1x1) goes to the images folder as a tile, not a file card.
  await fileInput(page).setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG })
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(1)
  await expect(composer(page).locator('.file-card')).toHaveCount(2)
  await expect(composer(page).locator('.file-card-progress')).toHaveCount(0)
  await expect(composer(page).locator('.attachment-ring')).toHaveCount(0)
  await shot(page, 'mixed')
  await composer(page).locator('textarea').press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
  const [msg] = await h.sent()
  expect(msg.imageRefs).toEqual([{ filename: '1-abc.png' }])
  expect(msg.message.split('\n')[0]).toBe(FILES_LINE)
  expect(msg.message).toContain('/config.json')
  expect(msg.message).toContain('/main.rs')
})

test('a stored message with attachment headers reads as pictures and file cards', async ({ page }) => {
  await open(page, [
    {
      role: 'user',
      text: `[Images attached — use the Read tool to view them]\n- /tmp/open-walnut/images/1-abc.png\n\n${FILES_LINE}\n- ${HOST_DIR}/up-1/trace.log\n- ${HOST_DIR}/up-2/bundle.tar.gz\n\nplease read these`,
      timestamp: '2026-01-01T00:01:00.000Z',
    },
    { role: 'assistant', text: 'read them', timestamp: '2026-01-01T00:01:10.000Z' },
  ])
  const bubble = page.locator('.session-history .session-msg-user').filter({ hasText: 'please read these' })
  await expect(bubble.locator('.file-card')).toHaveCount(2)
  await expect(bubble.locator('.message-attachment-image')).toHaveCount(1)
  await expect(bubble.locator('.file-card').nth(1)).toContainText('bundle.tar.gz')
  await expect(bubble.locator('.file-card').nth(1)).toContainText('Archive')
  await expect(bubble).not.toContainText('[Files attached')
  await expect(bubble).not.toContainText('Read tool')
})

test('eight quick pastes keep five pictures and say so on each picture that went as a file', async ({ page }) => {
  const h = await open(page)
  const png = PNG.toString('base64')
  // All eight before any read finishes: each add waits for the one before it.
  await page.evaluate((base64) => {
    const areas = document.querySelectorAll('.session-panel-input .chat-input-container textarea')
    const el = areas[areas.length - 1] as HTMLTextAreaElement
    el.focus()
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    for (let i = 0; i < 8; i++) {
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], `shot${i}.png`, { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }
  }, png)
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(5)
  await expect(composer(page).locator('.file-card')).toHaveCount(3)
  // The limit is said on each attachment that hit it, never as a line for the box.
  const asFiles = composer(page).locator('.file-card')
  for (let i = 0; i < 3; i++) await expect(asFiles.nth(i)).toContainText('Over 5 pictures, sent as a file')
  await expect(composer(page).locator('.chat-attachments-note')).not.toContainText(/as files?|per message/)
  await expect(composer(page).locator('.chat-send-btn-icon')).toBeEnabled({ timeout: 15_000 })
  await composer(page).locator('textarea').press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
  const [msg] = await h.sent()
  expect(msg.imageRefs).toHaveLength(5)
  expect(msg.message.match(/\/shot\d\.png/g)).toHaveLength(3)
})

test('a TIFF attached shows no limits; the sixth picture says its limit on its own card', async ({ page }) => {
  await open(page)
  // The report: a TIFF (a file, not a picture past a limit) showed two standing limit lines.
  await fileInput(page).setInputFiles([{ name: 'scan.tiff', mimeType: 'image/tiff', buffer: Buffer.alloc(2_000_000, 7) }])
  await expect(card(page, 'scan.tiff')).toContainText('1.9 MB', { timeout: 15_000 })
  await expect(composer(page)).not.toContainText(/Up to \d|per message|GB each|goes? as (a )?files?|pictures? go/i)
  await shot(page, 'tiff-no-limits')
  // Six pictures: five show, the sixth goes as a file and says why on its card alone.
  await fileInput(page).setInputFiles([1, 2, 3, 4, 5, 6].map((i) => ({ name: `shot${i}.png`, mimeType: 'image/png', buffer: PNG })))
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(5)
  await expect(card(page, 'shot6.png')).toContainText('Over 5 pictures, sent as a file')
  await expect(card(page, 'scan.tiff')).not.toContainText('sent as a file')
  await expect(composer(page).locator('.chat-attachments-note')).not.toContainText(/as files?|per message/)
  await shot(page, 'sixth-picture-limit')
})

test('files dropped on the conversation attach, and the panel says it takes them', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const history = document.querySelector('.session-history')!
    const dt = new DataTransfer()
    dt.items.add(new File(['line one'], 'server.log', { type: 'text/plain' }))
    history.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
    history.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.session-panel[data-file-drop="over"]')).toHaveCount(1)
  // A pointer held still sends dragover only now and then: the overlay stays.
  await page.waitForTimeout(1000)
  await expect(page.locator('.session-panel[data-file-drop="over"]')).toHaveCount(1)
  // Leaving the panel takes it away; coming back brings it again.
  await page.evaluate(() => {
    const history = document.querySelector('.session-history')!
    const dt = new DataTransfer()
    dt.items.add(new File(['line one'], 'server.log', { type: 'text/plain' }))
    history.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.session-panel[data-file-drop]')).toHaveCount(0)
  await page.evaluate(() => {
    const history = document.querySelector('.session-history')!
    const dt = new DataTransfer()
    dt.items.add(new File(['line one'], 'server.log', { type: 'text/plain' }))
    history.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }))
    history.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('.session-panel[data-file-drop="over"]')).toHaveCount(1)
  await page.screenshot({ path: path.join(SHOTS, 'drop-overlay.png') })
  await page.evaluate(() => {
    const history = document.querySelector('.session-history')!
    const dt = new DataTransfer()
    dt.items.add(new File(['line one'], 'server.log', { type: 'text/plain' }))
    history.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(card(page, 'server.log')).toBeVisible()
  await expect(page.locator('.session-panel[data-file-drop]')).toHaveCount(0)
  // Let go of outside any panel: the page stays (the browser does not open the file).
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'stray.txt', { type: 'text/plain' }))
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(ev)
    return ev.defaultPrevented
  })
  expect(prevented).toBe(true)
  await expect(composer(page).locator('.file-card')).toHaveCount(1)
})

test('at most two uploads run at once; the rest wait their turn', async ({ page }) => {
  const h = await open(page)
  // Each upload holds long enough that the files behind the first two still read Waiting when
  // the check looks: at 300 ms the last ones left that state before a loaded runner saw it.
  h.setPlan(() => ({ status: 200, delayMs: 1500 }))
  await fileInput(page).setInputFiles(Array.from({ length: 6 }, (_, i) => ({
    name: `part-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`file ${i}`),
  })))
  await expect(composer(page).locator('.file-card').filter({ hasText: 'Waiting' }).first()).toBeVisible()
  await expect(composer(page).locator('.file-card-progress')).toHaveCount(0, { timeout: 20_000 })
  expect(h.peak()).toBeLessThanOrEqual(2)
  expect(h.chunks.length).toBe(6)
})

test('uploaded attachments stay with the draft over a reload', async ({ page }) => {
  const h = await open(page)
  await fileInput(page).setInputFiles({ name: 'kept.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
  await pasteFile(page, 'kept.png', 'image/png', PNG.toString('base64'))
  await expect(composer(page).locator('.file-card-progress')).toHaveCount(0)
  await expect(composer(page).locator('.attachment-ring')).toHaveCount(0)
  await composer(page).locator('textarea').fill('after the reload')
  await page.waitForTimeout(600)
  await page.reload()
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 90_000 })
  await expect(card(page, 'kept.csv')).toContainText('8 B')
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(1)
  // Its bytes come back from the upload (a new session's first message inlines pictures).
  await expect(composer(page).locator('.chat-image-preview img[src^="data:image/png;base64,"]')).toHaveCount(1)
  await expect(composer(page).locator('textarea')).toHaveValue('after the reload')
  await composer(page).locator('textarea').press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
  const [msg] = await h.sent()
  expect(msg.message).toMatch(/\/kept\.csv\n\nafter the reload$/)
  expect(msg.imageRefs).toEqual([{ filename: '1-abc.png' }])
  // Sent: nothing comes back on the next reload.
  await page.reload()
  await expect(page.locator('.session-history')).toContainText('earlier answer', { timeout: 30_000 })
  await expect(composer(page).locator('.file-card')).toHaveCount(0)
})

test('why an upload failed is said in words, for a picture too', async ({ page }) => {
  const h = await open(page)
  h.setPlan((name) => (name === 'down.log' ? { status: 503, body: {} } : { status: 200 }))
  h.setImageFailure('The images folder is full.')
  await fileInput(page).setInputFiles({ name: 'down.log', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await pasteFile(page, 'broken.png', 'image/png', PNG.toString('base64'))
  await expect(composer(page).locator('.chat-attachments-note')).toContainText('broken.png: The images folder is full.')
  await expect(card(page, 'down.log')).toContainText("The session's host is not reachable right now", { timeout: 20_000 })
  await shot(page, 'failed-words')
})

test('a reload while a send is still unconfirmed keeps its attachments with the words', async ({ page }) => {
  const h = await open(page)
  await fileInput(page).setInputFiles({ name: 'inflight.log', mimeType: 'text/plain', buffer: Buffer.from('boom\n') })
  await expect(composer(page).locator('.file-card-progress')).toHaveCount(0)
  await composer(page).locator('textarea').fill('read this log')
  await page.evaluate(() => sessionStorage.setItem('pw-hold-send', '1'))
  await composer(page).locator('textarea').press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
  await expect(composer(page).locator('.file-card')).toHaveCount(0)
  await page.evaluate(() => sessionStorage.removeItem('pw-hold-send'))
  await page.reload()
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 90_000 })
  await expect(card(page, 'inflight.log')).toBeVisible({ timeout: 30_000 })
  await expect(composer(page).locator('textarea')).toHaveValue('read this log')
})

test("a send waiting for uploads can be called off, and then waits for the person", async ({ page }) => {
  const h = await open(page)
  h.setPlan(() => ({ status: 200, delayMs: 700 }))
  await fileInput(page).setInputFiles({ name: 'slow.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(5 * 1024 * 1024, 2) })
  const input = composer(page).locator('textarea')
  await input.fill('later')
  await input.press('Enter')
  await composer(page).getByRole('button', { name: "Don't send yet" }).click()
  await expect(composer(page).locator('.file-card-progress')).toHaveCount(0, { timeout: 20_000 })
  await page.waitForTimeout(500)
  expect(await h.sent()).toHaveLength(0)
  await input.press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
})

test('a reload mid-upload says the file is missing instead of sending the words without it', async ({ page }) => {
  const h = await open(page)
  h.setPlan(() => ({ status: 200, delayMs: 8000 }))
  await fileInput(page).setInputFiles({ name: 'half.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(5 * 1024 * 1024, 3) })
  await expect(card(page, 'half.bin')).toContainText(/\d+% of|Waiting/)
  await composer(page).locator('textarea').fill('see the attached dump')
  await page.waitForTimeout(600)
  await page.reload()
  await page.waitForFunction(() => {
    const ws = (window as any).__capturedWs as WebSocket | undefined
    return ws && ws.readyState === WebSocket.OPEN
  }, null, { timeout: 90_000 })
  const missing = card(page, 'half.bin')
  await expect(missing).toHaveClass(/is-failed/, { timeout: 30_000 })
  await expect(missing).toContainText('stopped before it finished')
  await expect(missing.getByRole('button', { name: /Retry/ })).toHaveCount(0)
  await expect(composer(page).locator('.chat-attachments-note')).toContainText('did not finish uploading')
  await composer(page).locator('textarea').press('Enter')
  await page.waitForTimeout(500)
  expect(await h.sent()).toHaveLength(0)
  await shot(page, 'orphan-after-reload')
  await missing.getByRole('button', { name: 'Remove half.bin' }).click()
  await composer(page).locator('textarea').press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
})

test('a send that fails while the next message is typed keeps both: the failed words go back in front', async ({ page }) => {
  const h = await open(page)
  await page.evaluate(() => sessionStorage.setItem('pw-hold-send', '1'))
  const input = composer(page).locator('textarea')
  await input.fill('first message')
  await input.press('Enter')
  await expect.poll(async () => (await h.sent()).length).toBe(1)
  await input.fill('second message')
  // The server refuses the first one now.
  await page.evaluate(() => {
    const ws = (window as any).__capturedWs as WebSocket
    const id = (window as any).__lastSendId
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'res', id, ok: false, error: 'refused' }) }))
  })
  await expect(input).toHaveValue('first message\n\nsecond message')
  await expect(composer(page).locator('.chat-attachments-note')).toContainText('did not send')
})

test('words typed on after Enter go with the message: the auto-send waits for a pause in typing', async ({ page }) => {
  const h = await open(page)
  h.setPlan(() => ({ status: 200, delayMs: 1500 }))
  await fileInput(page).setInputFiles({ name: 'slow.log', mimeType: 'text/plain', buffer: Buffer.from('x\n') })
  const input = composer(page).locator('textarea')
  await input.fill('first part.')
  await input.press('Enter')
  // Keep typing past the moment the upload finishes.
  for (const word of [' second', ' part', ' typed', ' while', ' it', ' waits', ' and', ' after', ' the', ' finish.']) {
    await input.pressSequentially(word, { delay: 40 })
    await page.waitForTimeout(250)
  }
  await expect.poll(async () => (await h.sent()).length, { timeout: 20_000 }).toBe(1)
  const [msg] = await h.sent()
  expect(msg.message).toMatch(/first part\. second part typed while it waits and after the finish\.$/)
  await expect(input).toHaveValue('')
})

test('a send made while a dropped picture is still being read waits for it', async ({ page }) => {
  const h = await open(page)
  // A slow read (a big photo, a HEIC conversion): the picture is not in the strip yet.
  await page.evaluate(() => {
    const orig = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) {
      setTimeout(() => orig.call(this, blob), 2000)
    }
  })
  await pasteFile(page, 'slow-read.png', 'image/png', PNG.toString('base64'))
  const input = composer(page).locator('textarea')
  await input.fill('look at this')
  await input.press('Enter')
  await page.waitForTimeout(800)
  expect(await h.sent()).toHaveLength(0)
  await expect.poll(async () => (await h.sent()).length, { timeout: 20_000 }).toBe(1)
  const [msg] = await h.sent()
  expect(msg.imageRefs).toEqual([{ filename: '1-abc.png' }])
  expect(msg.message).toBe('look at this')
})
