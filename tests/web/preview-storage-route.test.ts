/**
 * /api/preview-storage: what a page in the Files preview keeps for its site, on disk per file, and
 * put back into the page the raw route serves (src/web/routes/preview-storage.ts). Real server, real
 * HTTP. Pins:
 *  - a PUT keeps the text as sent, and the next raw load of that page carries it in a data block
 *    (a text holding a `<`, which could end that block, is left out);
 *  - another page, or the same page under another URL path, gets none of it;
 *  - only a page URL path names a page, and only a state of version 2 within the cap is kept;
 *  - DELETE forgets it; the folder stays under its total cap, the oldest files first out.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-preview-storage-route'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { PREVIEW_STORAGE_DIR, prunePreviewStorage, PREVIEW_STORAGE_TOTAL_MAX } from '../../src/web/routes/preview-storage.js'
import { PREVIEW_STATE_MAX } from '../../src/lib/preview-state-envelope.js'
import { withPreviewBridge } from '../../src/web/preview-bridge.js'

let server: HttpServer
let port = 0
const url = (p: string) => `http://localhost:${port}${p}`
let dir = ''
const docOf = (abs: string) => `/api/file-raw/local/${abs.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  dir = path.join(WALNUT_HOME, 'pages')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'a.html'), '<!doctype html><html><head><title>a</title></head><body>a</body></html>')
  await fs.writeFile(path.join(dir, 'b.html'), '<!doctype html><html><head><title>b</title></head><body>b</body></html>')
  server = await startServer({ port: 0, dev: true })
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const put = (doc: string, body: string) => fetch(url(`/api/preview-storage?doc=${encodeURIComponent(doc)}`), {
  method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body,
})
const raw = async (doc: string) => (await fetch(url(doc))).text()
/** The disk copy the served page carries in its data block, or 'null' when it carries none. */
function seedOf(html: string): string {
  const m = /<script type="application\/json" data-walnut-seed>([^<]*)<\/script>/.exec(html)
  return m ? m[1]! : 'null'
}

describe('preview storage', () => {
  it('keeps a page state and puts it back into that page only, in a data block nothing can end early', async () => {
    const a = docOf(path.join(dir, 'a.html'))
    const b = docOf(path.join(dir, 'b.html'))
    // As the page writes it: every < escaped (preview-state-script.ts).
    const state = JSON.stringify({ v: 2, p: a, t: 1, ls: { k: '</script><!-- <b>x ' } }).replace(/</g, '\\u003c')
    expect((await put(a, state)).status).toBe(204)
    const html = await raw(a)
    expect(seedOf(html)).toBe(state)
    expect(JSON.parse(seedOf(html))).toEqual({ v: 2, p: a, t: 1, ls: { k: '</script><!-- <b>x ' } })
    // Walnut's two script elements, nothing the state opened.
    expect(html.match(/<\/script>/g)?.length).toBe(2)
    expect(seedOf(await raw(b))).toBe('null')
    // A text holding a < (not written by the page's state script) is refused and never in the page.
    expect((await put(a, JSON.stringify({ v: 2, p: a, t: 2, ls: { k: '</script><script>alert(1)' } }))).status).toBe(400)
    const html2 = await raw(a)
    expect(seedOf(html2)).toBe(state)
    expect(html2).not.toContain('alert(1)')
    expect(withPreviewBridge('<head>', '{"v":2,"x":"</script>"}')).not.toContain('<script type="application/json" data-walnut-seed>')
  })

  it('refuses what is not a page or not a state', async () => {
    const a = docOf(path.join(dir, 'a.html'))
    expect((await put('/etc/passwd', '{"v":2,"p":"x"}')).status).toBe(400)
    expect((await put('/api/sessions', '{"v":2,"p":"x"}')).status).toBe(400)
    expect((await put(a, '{"v":1}')).status).toBe(400)
    expect((await put(a, 'not json')).status).toBe(400)
    expect((await put(a, `{"v":2,"p":"${'x'.repeat(PREVIEW_STATE_MAX)}"}`)).status).toBe(400)
  })

  it('forgets on DELETE', async () => {
    const a = docOf(path.join(dir, 'a.html'))
    expect((await put(a, JSON.stringify({ v: 2, p: a, t: 2 }))).status).toBe(204)
    expect(seedOf(await raw(a))).not.toBe('null')
    expect((await fetch(url(`/api/preview-storage?doc=${encodeURIComponent(a)}`), { method: 'DELETE' })).status).toBe(204)
    expect(seedOf(await raw(a))).toBe('null')
  })

  it('keeps the folder under its cap, the least recently written first out', async () => {
    const d = PREVIEW_STORAGE_DIR()
    await fs.mkdir(d, { recursive: true })
    const big = Math.ceil(PREVIEW_STORAGE_TOTAL_MAX / 3) + 1
    for (const [i, n] of ['old', 'mid', 'new'].entries()) {
      const f = path.join(d, `${n}.json`)
      await fs.writeFile(f, Buffer.alloc(big, 32))
      const at = new Date(Date.now() - (3 - i) * 60_000)
      await fs.utimes(f, at, at)
    }
    await prunePreviewStorage(Date.now(), true)
    const left = (await fs.readdir(d)).filter((n) => ['old.json', 'mid.json', 'new.json'].includes(n)).sort()
    expect(left).toEqual(['mid.json', 'new.json'])
    for (const n of left) await fs.rm(path.join(d, n))
  })
})
