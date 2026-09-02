/**
 * A markdown file's IMAGES must follow the file's Refresh.
 *
 * Reported: an agent regenerated `images/architecture.png`; opening the PNG in
 * the Files panel showed the new drawing, but the markdown that embeds it kept
 * showing the old one — through Refresh, for half an hour. The server log had
 * NO request for the image in that window: the preview rendered the same
 * `<img src="/api/local-image?path=…">` every time, and WebKit (the Mac app is a
 * WKWebView) serves a URL it has already loaded in this document from its memory
 * cache without asking the server, so `Cache-Control: no-cache` never got a say.
 *
 * Pinned in WEBKIT deliberately, with the engine asserted (`test.use` does not
 * rename the project, so a silent fallback to Chromium would still print
 * "passed"). The fix is engine-agnostic — the image URL carries a token that
 * changes with the pane's reload — but the bug is only reliably visible here.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

test.use({ browserName: 'webkit' })

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/image-refresh'

// ── A tiny PNG encoder: the test needs two DIFFERENT valid images whose
//    difference the browser can report (naturalWidth), not two byte blobs. ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** A solid-colour RGBA PNG of the given square size. */
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const row = Buffer.alloc(1 + size * 4)
  for (let x = 0; x < size; x++) row.set([...rgb, 255], 1 + x * 4)
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  const cwd = body?.session?.cwd ?? body?.cwd
  expect(typeof cwd).toBe('string')
  return cwd as string
}

async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

/** The embedded image's decoded width, or -1 while it is still loading/broken. */
async function embeddedWidth(img: Locator): Promise<number> {
  return img.evaluate((el) => {
    const i = el as HTMLImageElement
    return i.complete ? i.naturalWidth : -1
  })
}

test.beforeEach(async ({ page, browserName }) => {
  expect(browserName, 'this spec must run in WebKit — see the file header').toBe('webkit')
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('Refresh on a markdown file re-fetches an embedded image that changed on disk', async ({ page }) => {
  const cwd = await fixtureCwd(page)
  const stamp = Date.now()
  const dir = path.join(cwd, `imgdoc-${stamp}`)
  const docName = `design-${stamp}.md` // unique: `hasText` is a substring match
  // The fixture server is local, so the "agent regenerating the diagram" is a
  // plain write to disk — the one thing no API-side cache could know about.
  await fs.mkdir(path.join(dir, 'images'), { recursive: true })
  await fs.writeFile(path.join(dir, 'images/pic.png'), solidPng(1, [220, 40, 40]))
  const put = await page.request.put('/api/file-content', {
    data: { path: path.join(dir, docName), content: '# Doc\n\nBelow is the diagram.\n\n![pic](images/pic.png)\n' },
  })
  expect(put.ok(), await put.text()).toBe(true)

  try {
    const explorer = await openFilesPanel(page)
    await nodeByName(explorer, `imgdoc-${stamp}`).click()
    const docRow = nodeByName(explorer, docName)
    await expect(docRow).toBeVisible({ timeout: 10_000 })
    await docRow.click()

    // Plain markdown opens in the WYSIWYG editor; the image is a real <img>.
    const img = page.locator('.fv-wysiwyg-editor img, .fv-md-preview img').first()
    await expect(img).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => embeddedWidth(img), { timeout: 10_000 }).toBe(1)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/1-first-image.png` })

    // The diagram is regenerated: same name, different picture.
    await fs.writeFile(path.join(dir, 'images/pic.png'), solidPng(2, [40, 120, 220]))

    // The markdown itself did not change. Refresh must still show the NEW image:
    // a preview that keeps painting the old bytes after Refresh is the bug.
    await page.getByRole('button', { name: 'Refresh' }).click()
    const fresh = page.locator('.fv-wysiwyg-editor img, .fv-md-preview img').first()
    await expect.poll(() => embeddedWidth(fresh), { timeout: 15_000 }).toBe(2)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/2-after-refresh.png` })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
