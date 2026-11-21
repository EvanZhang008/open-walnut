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
import { test, expect, type Page } from '@playwright/test'
import { FILES_LINE, HOST_DIR, PNG, SESSION_ID, open } from './composer-send-harness'
import fs from 'node:fs'
import path from 'node:path'

// A cold page on a loaded test host can take a while to open its socket.
test.describe.configure({ timeout: 180_000 })
const SHOTS = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '/tmp/composer-file-attachments'

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
  h.setPlan((name) => (name === 'down.log' ? { status: 507, body: { error: { code: 'host_disk_full', message: "The session's host does not have room for this file." } } } : { status: 200 }))
  h.setImageFailure('The images folder is full.')
  await fileInput(page).setInputFiles({ name: 'down.log', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await pasteFile(page, 'broken.png', 'image/png', PNG.toString('base64'))
  await expect(composer(page).locator('.chat-attachments-note')).toContainText('broken.png: The images folder is full.')
  await expect(card(page, 'down.log')).toContainText("The session's host does not have room for this file.", { timeout: 20_000 })
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

test('a send that fails while the next message is typed keeps both: the failed words in their own row, the typed ones in the box', async ({ page }) => {
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
  // A session send's refused words live on in their own row, with Retry; the words typed since
  // stay in the box, alone (ChatInput.tsx sendWith, useSessionSend).
  const failed = page.locator('.session-msg-failed').filter({ hasText: 'first message' })
  await expect(failed).toHaveCount(1)
  await expect(failed.locator('.session-msg-failed-badge')).toContainText('Send failed')
  await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(input).toHaveValue('second message')
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
  // A slow read (a big photo, a HEIC conversion): the picture is not in the strip yet. The read
  // waits for the test, not for a clock: a 2 s delay ended before the send on a loaded runner,
  // where the fill and the Enter alone took that long (2026-11-13, every CI run).
  await page.evaluate(() => {
    const w = window as unknown as { __releaseRead?: () => void }
    const gate = new Promise<void>((resolve) => { w.__releaseRead = resolve })
    const orig = FileReader.prototype.readAsDataURL
    FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) {
      void gate.then(() => orig.call(this, blob))
    }
  })
  await pasteFile(page, 'slow-read.png', 'image/png', PNG.toString('base64'))
  const input = composer(page).locator('textarea')
  await input.fill('look at this')
  await input.press('Enter')
  await page.waitForTimeout(800)
  expect(await h.sent()).toHaveLength(0)
  await page.evaluate(() => (window as unknown as { __releaseRead: () => void }).__releaseRead())
  await expect.poll(async () => (await h.sent()).length, { timeout: 20_000 }).toBe(1)
  const [msg] = await h.sent()
  expect(msg.imageRefs).toEqual([{ filename: '1-abc.png' }])
  expect(msg.message).toBe('look at this')
})

test('a picture pasted while Walnut restarts waits, uploads by itself, and a send made meanwhile goes once it is up', async ({ page }) => {
  const h = await open(page)
  h.setImageDown(true)
  await pasteFile(page, 'image.png', 'image/png', PNG.toString('base64'))
  const tile = composer(page).locator('.chat-image-preview')
  // Waiting, not failed: no red ring, no Retry, the line says it goes on by itself.
  await expect(tile).toHaveClass(/is-waiting/, { timeout: 15_000 })
  await expect(tile).not.toHaveClass(/is-failed/)
  await expect(composer(page).getByRole('button', { name: 'Retry uploading image.png' })).toHaveCount(0)
  const note = composer(page).locator('.chat-attachments-note')
  await expect(note).toContainText('Waiting for the connection to Walnut: the upload goes on by itself')
  await expect(note).not.toHaveClass(/is-warning/)
  await shot(page, 'restart-waiting')
  // Enter while it waits: the message waits for the picture instead of being refused.
  const input = composer(page).locator('textarea')
  await input.fill("didn't see this")
  await input.press('Enter')
  await expect(note).toContainText('then the message sends')
  // Several tries while down (well past the old one-and-fail), and nothing sent yet.
  await expect.poll(() => h.imageTries(), { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
  expect(await h.sent()).toHaveLength(0)
  // Walnut is back: the picture goes up by itself and the message with it, once.
  h.setImageDown(false)
  await expect.poll(async () => (await h.sent()).length, { timeout: 20_000 }).toBe(1)
  const [msg] = await h.sent()
  expect(msg.message).toContain("didn't see this")
  expect(msg.imageRefs).toEqual([{ filename: '1-abc.png' }])
  await expect(composer(page).locator('.chat-image-preview')).toHaveCount(0)
  await expect(composer(page).locator('.chat-attachments-note')).toHaveCount(0)
})
