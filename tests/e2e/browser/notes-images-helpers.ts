/**
 * Shared seed and helpers for the notes image specs (invented notes and
 * generated pictures through the public API of the fixture server).
 */
import { expect, type Page } from '@playwright/test'
import zlib from 'node:zlib'

const API = 'http://localhost:3457'

/** A solid-colour PNG of w×h (real bytes, so naturalWidth is real). */
export function pngOf(w: number, h: number, [r, g, b]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

export async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`)
  return res.json()
}

/** Upload a picture beside `note`, then move it to `to` (a name of our choosing). */
export async function placeImage(note: string, to: string, color: [number, number, number], w = 240, h = 140) {
  const { path } = await api('POST', '/api/notes-v2/attachment', { notePath: note, data: pngOf(w, h, color), mediaType: 'image/png' })
  await api('POST', '/api/notes-v2/move', { from: path, to })
}

const BODY = [
  'Image forms',
  '',
  '![bare](photo.png)',
  '',
  '![encoded](Untitled%201.png)',
  '',
  '![up](../shared/map.png)',
  '',
  '![[embed.png]]',
  '',
  '![[sized.png|120]]',
  '',
  '![gone](nowhere.png)',
  '',
].join('\n')

export async function seed() {
  const root = `ImgForms${Date.now()}`
  const note = `${root}/Trips/Plan.md`
  await api('PUT', `/api/notes-v2/content/${note}`, { content: 'seeding\n' })
  await placeImage(note, `${root}/Trips/photo.png`, [220, 80, 60])
  await placeImage(note, `${root}/Trips/Untitled 1.png`, [60, 140, 220])
  await placeImage(note, `${root}/shared/map.png`, [70, 170, 90])
  await placeImage(note, `${root}/Trips/_attachment/embed.png`, [200, 160, 40])
  await placeImage(note, `${root}/Trips/_attachment/sized.png`, [150, 80, 200], 480, 280)
  await api('PUT', `/api/notes-v2/content/${note}`, { content: BODY })
  return { root, note }
}

export async function openNote(page: Page, root: string, firstLine = 'Image forms') {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.sidebar-nav a[href="/notes"], a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.locator('.notes-tree-folder', { hasText: root }).click()
  await page.locator(`[data-drop-folder="${root}"] .notes-tree-folder`, { hasText: 'Trips' }).click()
  await page.locator(`[data-drop-folder="${root}/Trips"] .notes-tree-file`, { hasText: 'Plan' }).click()
  // The Notes page's own pane: Home stays mounted on every route, and a Scratchpad another
  // test left open there keeps its editor in the DOM first (tests/web/notes-page-editor-scope-guard.test.ts).
  const editor = page.locator('.notes-editor-pane .notes-editor .tiptap').first()
  await expect(editor).toContainText(firstLine, { timeout: 10_000 })
  return editor
}

/** Every visible <img> in the editor that finished loading with real pixels. */
export async function drawn(page: Page): Promise<number> {
  return page.locator('.notes-editor-pane .notes-editor .tiptap img').evaluateAll((imgs) =>
    (imgs as HTMLImageElement[]).filter((i) => !i.hidden && i.complete && i.naturalWidth > 0).length)
}

