/**
 * The harness of the composer's send specs: the real SPA and composer on a
 * session whose REST reads and upload routes are answered in the page (so a slow
 * or failing host is controlled), the WS `session:send` RPC captured. Shared by
 * composer-file-attachments.spec.ts and composer-camera.spec.ts.
 */
import { expect, type Page, type Route } from '@playwright/test'

export const SESSION_ID = 'pw-file-attach-session'
export const TASK_ID = 'pw-file-attach-task'
export const HOST_DIR = '/home/me/.local/state/open-walnut/tasks/pw-file-attach-task/uploads'
export const FILES_LINE = '[Files attached — open them from these paths]'

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export type ChunkPlan = (name: string, attempt: number) => { status: number; body?: unknown; delayMs?: number }

export interface Harness {
  sent: () => Promise<Array<{ message: string; imageRefs?: Array<{ filename: string }> }>>
  chunks: Array<{ url: string; size: number }>
  setPlan: (plan: ChunkPlan) => void
  /** The most chunk requests the host held open at one time. */
  peak: () => number
  setImageFailure: (message: string | null) => void
  /** Walnut is down (its connection refused) until set back to false. */
  setImageDown: (down: boolean) => void
  imageTries: () => number
}

export const ok: ChunkPlan = () => ({ status: 200 })


export async function open(page: Page, history: unknown[] = []): Promise<Harness> {
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
                // A refused send hears the server's refusal (its words, as the server says them).
                const refusal = sessionStorage.getItem('pw-refuse-send')
                if (refusal) setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: p.id, ok: false, error: refusal }),
                })), 10)
                // A held send never hears back (the server has not confirmed it).
                else if (!sessionStorage.getItem('pw-hold-send')) answer(p.id, { messageId: `qm-file${++n}` })
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

  // Its recovery state, as a session at rest has it (the fixture server knows no such session).
  await page.route(`**/api/sessions/${SESSION_ID}/supervision`, (route) => route.fulfill({ json: {
    available: true, startup: 'on-demand', stopRequest: null,
    supervision: { enabled: false, state: 'inactive', reason: null, generation: 1, retryAt: null, updatedAt: Date.now() },
  } }))
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
  let imageDown = false
  let imageTries = 0
  await page.route('**/api/images/upload', (route) => (++imageTries, imageDown
    ? route.abort('connectionrefused')
    : imageFailure
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
    setImageDown: (d) => { imageDown = d },
    imageTries: () => imageTries,
  }
}

