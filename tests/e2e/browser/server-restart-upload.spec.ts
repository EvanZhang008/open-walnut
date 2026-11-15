/**
 * A picture pasted while Walnut's server restarts uploads by itself (2026-11-15:
 * the Mac app's composer showed "1 upload failed: retry or remove it to send" and
 * "image.png: The connection to Walnut dropped" after a deploy restarted the
 * server; a manual Retry worked).
 *
 * Its own fixture (server-restart-upload.config.ts): a real production-mode
 * server, stopped as a deploy stops it, its port closed for the gap a deploy
 * leaves, then started again on the same port. The person pastes a picture while
 * it is down into a new session's composer and presses Enter: the picture says it waits for the connection
 * (never "failed", never a Retry), goes up once the server is back, and the
 * message goes with it, once.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { draftComposer, draftCwdPill, openDraft, REAL_PANEL } from './draft-helpers'

interface Fixture { port: number; controlPort: number; root: string; project: string; gapMs: number }
let fx: Fixture
const port = Number(process.env.PW_TEST_PORT ?? 3542)
const shots = process.env.PW_SCREENSHOT_DIR ?? '/tmp/server-restart-upload'
const PICTURE = path.resolve(import.meta.dirname, '../../../docs/assets/workflow-viz.png')

test.skip(!process.env.RESTART_FIXTURE_MANIFEST, 'Requires the server-restart-upload.config.ts fixture')
test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  fx = JSON.parse(fs.readFileSync(process.env.RESTART_FIXTURE_MANIFEST!, 'utf8')) as Fixture
  expect(fx.root).toContain('walnut-restart-upload-')
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

/** A new session's draft, its folder picked, ready to take the first message. */
async function openReadyDraft(page: Page) {
  const draft = await openDraft(page)
  await draftCwdPill(draft).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible()
  await picker.locator('.sps-search-input').fill(fx.project)
  await picker.locator('.sps-search-input').press('Shift+Enter')
  await expect(picker).toBeHidden()
  return draft
}

test('a picture pasted while the server restarts uploads by itself, and the message sent meanwhile goes once it is up', async ({ page, browserName }) => {
  const problems: string[] = []
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  const uploads: number[] = []
  page.on('response', (r) => { if (new URL(r.url()).pathname === '/api/images/upload') uploads.push(r.status()) })
  let refused = 0
  page.on('requestfailed', (r) => { if (new URL(r.url()).pathname === '/api/images/upload') refused++ })

  await openWalnut(page)
  const draft = await openReadyDraft(page)
  const composer = draft.locator('.chat-input-container')
  await expect(composer).toBeVisible()

  // Anything the person would read as a failure, at any moment.
  await page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __failures: string[] }).__failures = seen
    new MutationObserver(() => {
      const text = document.body.innerText
      const m = text.match(/.{0,60}(upload failed|Not uploaded|connection to Walnut dropped|retry or remove).{0,60}/i)
      if (m) seen.push(m[0])
      if (document.querySelector('.file-card.is-failed, .chat-image-preview.is-failed, .attachment-retry')) seen.push('a failed tile or a Retry button')
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  })

  // The deploy: the server goes down, its port closed. The person pastes a screenshot meanwhile.
  const stop = await control('POST', '/restart')
  await draftComposer(page).evaluate((el, base64) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, fs.readFileSync(PICTURE).toString('base64'))
  const tile = composer.locator('.chat-image-preview')
  await expect(tile).toHaveClass(/is-waiting/, { timeout: 15_000 })
  const note = composer.locator('.chat-attachments-note')
  await expect(note).toContainText('Waiting for the connection to Walnut: the upload goes on by itself')
  await page.screenshot({ path: path.join(shots, `${browserName}-1-waiting.png`) })

  // Enter while it waits: the message waits for the picture.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
  await draftComposer(page).fill("didn't see this")
  await draftComposer(page).press('Enter')
  await expect(note).toContainText('then the message sends')
  await page.screenshot({ path: path.join(shots, `${browserName}-2-sends-after.png`) })

  // The server comes back by itself; the picture goes up and the message with it, once.
  const response = await started
  expect(response.ok()).toBe(true)
  const { taskId } = await response.json() as { taskId: string }
  let sid = ''
  await expect.poll(async () => {
    const rows = (await (await page.request.get(`/api/sessions/task/${taskId}`)).json()).sessions as Array<{ claudeSessionId: string }>
    sid = rows[0]?.claudeSessionId ?? ''
    return sid
  }, { timeout: 30_000 }).not.toBe('')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-history').getByText("didn't see this")).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('.session-history img').first()).toBeVisible()
  // Its turn ran: the mock agent answered the message that carried the picture.
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).session?.process_status, { timeout: 60_000 }).toMatch(/^(idle|stopped)$/)
  await page.screenshot({ path: path.join(shots, `${browserName}-3-sent.png`) })

  const state = await control('GET', '/state')
  const restarts = state.restarts as Array<{ stoppedAt: number; startedAt: number }>
  expect(restarts).toHaveLength(1)
  expect(restarts[0].startedAt - Number(stop.stoppedAt)).toBeGreaterThanOrEqual(fx.gapMs - 100)
  // It tried while the port was closed, then got through once.
  expect(refused).toBeGreaterThanOrEqual(2)
  expect(uploads.filter((s) => s === 200)).toHaveLength(1)
  // The message went once, with the picture (the mock agent echoes it, so the record is read, not the page).
  // The session's own record: the message, with the picture, reached the agent and it answered.
  const history = (await (await page.request.get(`/api/sessions/${sid}/history`)).json()).messages as Array<{ role: string; text?: string }>
  const mine = history.filter((m) => m.role === 'user' && (m.text ?? '').includes("didn't see this"))
  expect(mine, JSON.stringify(history).slice(0, 2000)).toHaveLength(1)
  expect(JSON.stringify(mine[0])).toMatch(/images\/[\w.-]+\.(?:png|jpe?g|webp)/)
  expect(history.some((m) => m.role === 'assistant'), JSON.stringify(history).slice(0, 2000)).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { __failures: string[] }).__failures)).toEqual([])
  expect(problems).toEqual([])
})
