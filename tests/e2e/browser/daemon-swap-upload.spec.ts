/**
 * An upload in the composer goes on through a daemon swap (2026-11-10: a 6.6 MB TIFF
 * stopped at 0% with "Not uploaded: The session's host could not save the file
 * (internal daemon error handling upload.part: Daemon is shutting down; retry after
 * reconnecting)" and a Retry button, in the seconds a deploy replaced the Mac's daemon).
 *
 * Its own fixture (daemon-swap-upload.config.ts): a real local daemon, replaced through
 * the server's own version-mismatch restart while the first part of the file is on its
 * way; the old daemon drains for a few seconds and refuses what reaches it. The person
 * sees the file upload and finish: no error, no Retry, every part answered 200, and the
 * file on the host is the file sent, saved by the NEW daemon.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { draftComposer, draftCwdPill, openDraft, REAL_PANEL } from './draft-helpers'

interface Fixture { port: number; controlPort: number; root: string; project: string; holdMs: number }
let fx: Fixture
const port = Number(process.env.PW_TEST_PORT ?? 3541)
const shots = process.env.PW_SCREENSHOT_DIR ?? '/tmp/daemon-swap-upload'

test.skip(!process.env.DAEMON_SWAP_MANIFEST, 'Requires the daemon-swap-upload.config.ts fixture')
test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  fx = JSON.parse(fs.readFileSync(process.env.DAEMON_SWAP_MANIFEST!, 'utf8')) as Fixture
  expect(fx.root).toContain('walnut-daemon-swap-ui-')
  expect(fx.port).toBe(port)
  fs.mkdirSync(shots, { recursive: true })
})

const control = async (method: 'GET' | 'POST', route: string) => {
  const res = await fetch(`http://127.0.0.1:${fx.controlPort}${route}`, { method })
  const body = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error(`control ${route}: ${String(body.error)}`)
  return body
}

async function openWalnut(page: Page) {
  await page.setContent(`<a href="http://localhost:${port}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 60_000 })
}

async function startSession(page: Page): Promise<string> {
  const draft = await openDraft(page)
  await draftCwdPill(draft).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible()
  await picker.locator('.sps-search-input').fill(fx.project)
  await picker.locator('.sps-search-input').press('Shift+Enter')
  await expect(picker).toBeHidden()
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).fill('Hello, I will send you a scan.')
  await draftComposer(page).press('Enter')
  const response = await started
  expect(response.ok()).toBe(true)
  const { taskId } = await response.json() as { taskId: string }
  let sid = ''
  await expect.poll(async () => {
    const rows = (await (await page.request.get(`/api/sessions/task/${taskId}`)).json()).sessions as Array<{ claudeSessionId: string }>
    sid = rows[0]?.claudeSessionId ?? ''
    return sid
  }, { timeout: 30_000 }).not.toBe('')
  // Its turn is over (the mock CLI may end with it): the upload goes to the host either way.
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).session?.process_status, { timeout: 60_000 }).toMatch(/^(idle|stopped)$/)
  return sid
}

test('a 6.6 MB scan attached while the daemon is replaced uploads by itself, with no error and no Retry', async ({ page, browserName }) => {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  const parts: Array<{ status: number; offset: string; body: Record<string, unknown> | null }> = []
  page.on('response', async (r) => {
    const url = new URL(r.url())
    if (!/\/api\/v1\/sessions\/[^/]+\/uploads\//.test(url.pathname)) return
    let body: Record<string, unknown> | null = null
    try { body = await r.json() as Record<string, unknown> } catch { /* not JSON */ }
    parts.push({ status: r.status(), offset: url.searchParams.get('offset') ?? '', body })
  })

  await openWalnut(page)
  const sid = await startSession(page)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const composer = panel.locator('.session-panel-input .chat-input-container')
  await expect(composer).toBeVisible()

  // Anything the person would read as a failure, at any moment of the upload.
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __failures: string[] }).__failures = seen
    new MutationObserver(() => {
      const text = document.body.innerText
      if (/Not uploaded|shutting down|could not save the file/i.test(text)) seen.push(text.match(/.{0,80}(Not uploaded|shutting down|could not save the file).{0,80}/i)?.[0] ?? 'failure text')
      if (document.querySelector('.file-card.is-failed, .chat-image-preview.is-failed, .attachment-retry')) seen.push('a failed card or a Retry button')
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })

  const before = await control('GET', '/state')
  // The deploy starts as the first part leaves the browser: that part reaches a daemon that drains.
  let swapped: Record<string, unknown> | null = null
  await page.route('**/api/v1/sessions/*/uploads/**', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'PUT' && url.searchParams.get('offset') === '0' && !swapped) {
      swapped = await control('POST', '/swap')
    }
    await route.continue()
  })

  const scan = crypto.randomBytes(6_881_046)
  await composer.locator('input[type="file"]').setInputFiles([{ name: 'scan.tiff', mimeType: 'image/tiff', buffer: scan }])
  await expect(composer.locator('.file-card-progress')).toHaveCount(1, { timeout: 15_000 })
  await page.screenshot({ path: path.join(shots, `${browserName}-1-uploading-through-swap.png`) })

  // It finishes by itself: the progress goes, the card reads its size, no failure, nothing to retry.
  const card = composer.locator('.file-card').filter({ hasText: 'scan.tiff' })
  await expect(card).toBeVisible()
  await expect(card.locator('.file-card-progress')).toHaveCount(0, { timeout: 120_000 })
  await expect(card.locator('.file-card-detail')).toHaveText('6.6 MB')
  await expect(composer.locator('.file-card.is-failed, .chat-image-preview.is-failed, .attachment-retry')).toHaveCount(0)
  await page.screenshot({ path: path.join(shots, `${browserName}-2-uploaded.png`) })

  expect(swapped, 'the swap ran during the upload').not.toBeNull()
  // The new daemon serves (the server reconnected to it by itself).
  let swaps: Array<{ from: string; to: string; drainSeenAt: number; releasedAt: number }> = []
  await expect.poll(async () => {
    swaps = (await control('GET', '/state')).swaps as typeof swaps
    return swaps[0]?.to ?? ''
  }, { timeout: 60_000 }).not.toBe('')
  expect(swaps).toHaveLength(1)
  expect(swaps[0].to).not.toBe(before.instance)
  expect(swaps[0].releasedAt - swaps[0].drainSeenAt).toBeGreaterThanOrEqual(fx.holdMs - 100)

  // Every part answered 200 (no 502 or 503 the browser had to retry), and the file is whole.
  expect(parts.length).toBeGreaterThanOrEqual(4)
  expect(parts.filter((p) => p.status !== 200), JSON.stringify(parts.map((p) => [p.status, p.offset]))).toEqual([])
  const last = parts.find((p) => p.body?.done === true)
  expect(last, 'the last part says the file is done').toBeTruthy()
  const saved = String(last!.body!.path)
  expect(saved.startsWith(fx.root)).toBe(true)
  expect(crypto.createHash('sha256').update(fs.readFileSync(saved)).digest('hex')).toBe(crypto.createHash('sha256').update(scan).digest('hex'))

  expect(await page.evaluate(() => (window as unknown as { __failures: string[] }).__failures)).toEqual([])
  expect(problems).toEqual([])
})
