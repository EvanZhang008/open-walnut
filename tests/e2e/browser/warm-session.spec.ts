import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openDraft, draftComposer, draftCwdPill, REAL_PANEL } from './draft-helpers'

const enabled = Boolean(process.env.WARM_FIXTURE_MANIFEST)
test.skip(!enabled, 'Requires the isolated built-SPA warm-session config')
let root = ''
const port = Number(process.env.PW_TEST_PORT ?? 3457)
const evidence = process.env.PW_SCREENSHOT_DIR ?? '/tmp/warm-session-fix'
const errors = new WeakMap<Page, string[]>()

test.beforeAll(() => {
  root = JSON.parse(fs.readFileSync(process.env.WARM_FIXTURE_MANIFEST!, 'utf8')).root
  expect(root).toContain('walnut-warm-ui-')
  fs.mkdirSync(evidence, { recursive: true })
})
test.beforeEach(({ page }) => {
  const found: string[] = []
  errors.set(page, found)
  page.on('pageerror', error => found.push(error.message))
  page.on('response', response => {
    if (response.status() >= 500) found.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
})
test.afterEach(({ page }) => {
  for (const file of fs.readdirSync(root)) {
    if (file.startsWith('received-')) release(file.slice('received-'.length, -'.json'.length))
  }
  expect(errors.get(page)).toEqual([])
})

async function record(page: Page, sid: string) {
  const response = await page.request.get(`/api/sessions/${sid}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).session as { pid?: number; process_status: string; model?: string }
}
function release(tag: string) { fs.writeFileSync(path.join(root, `release-${tag}`), '') }
async function received(tag: string) {
  const file = path.join(root, `received-${tag}.json`)
  await expect.poll(() => fs.existsSync(file), { timeout: 15_000 }).toBe(true)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; sid: string; args: string[]; text: string }
}
async function idle(page: Page, sid: string) {
  await expect.poll(async () => (await record(page, sid)).process_status, { timeout: 15_000 }).toBe('idle')
}
async function send(panel: Locator, tag: string, extra = '') {
  const composer = panel.locator('.chat-input-textarea')
  await composer.fill(`warm-check ${tag}${extra}`)
  await composer.press('Enter')
}

for (const shape of ['regular', 'dense'] as const) {
  test(`${shape} history: warm starts precede output across repeated sends and reconnect`, async ({ page, browserName }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { warmSockets: WebSocket[] }
      w.warmSockets = []
      window.WebSocket = new Proxy(window.WebSocket, {
        construct(Target, args) {
          const socket = new Target(...args as [string, string[]?])
          w.warmSockets.push(socket)
          return socket
        },
      })
    })
    await page.setContent(`<a href="http://localhost:${port}/">Open Walnut</a>`)
    await page.getByRole('link', { name: 'Open Walnut' }).click()
    await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
    const draft = await openDraft(page)
    await draftCwdPill(draft).click()
    const picker = page.locator('.session-path-selector')
    await expect(picker).toBeVisible()
    await picker.locator('.sps-search-input').fill(path.join(root, 'project'))
    await picker.locator('.sps-search-input').press('Shift+Enter')
    await expect(picker).toBeHidden()
    const initial = `${browserName}-seed-${shape}`
    const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions/quick-start')
    await draftComposer(page).fill(`warm-check ${initial}`)
    await draftComposer(page).press('Enter')
    const response = await responsePromise
    expect(response.ok()).toBe(true)
    const { taskId } = await response.json()
    let sid = ''
    await expect.poll(async () => {
      const response = await page.request.get(`/api/sessions/task/${taskId}`)
      expect(response.ok()).toBe(true)
      const rows = (await response.json()).sessions
      if (rows.length === 1) sid = rows[0].claudeSessionId
      return rows.length
    }).toBe(1)
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
    await expect(panel).toBeVisible()
    const seed = await received(initial)
    expect(seed.sid).toBe(sid)
    release(initial)
    await idle(page, sid)
    await expect.poll(async () => {
      const history = await page.request.get(`/api/sessions/${sid}/history`)
      expect(history.ok()).toBe(true)
      return (await history.json()).messages.filter((row: { role: string }) => row.role === 'assistant').length
    }).toBe(1)
    if (shape === 'dense') await expect(panel.getByText('Section 80', { exact: false })).toBeVisible()
    else await expect(panel.getByText(`Verified reply ${initial}:`, { exact: false })).toBeVisible()
    await expect(page.getByText("A session's summary couldn't be parsed", { exact: false })).toHaveCount(0)
    const stablePid = (await record(page, sid)).pid
    expect(stablePid).toBeGreaterThan(1)
    expect((await record(page, sid)).model).toBe('mock-warm-model')
    const timings: number[] = []

    for (let round = 1; round <= 3; round++) {
      const tag = `${browserName}-${shape}-${round}`
      const started = Date.now()
      await send(panel, tag, round === 2 ? ` ${String.fromCodePoint(0x4f60, 0x597d, 0x1f680)}\n${'Long request details. '.repeat(3000)}` : '')
      const input = await received(tag)
      expect(input.pid).toBe(seed.pid)
      expect(input.args).not.toContain('--resume')
      if (round === 2) {
        expect(input.text).toContain(String.fromCodePoint(0x4f60, 0x597d, 0x1f680))
        expect(input.text).toContain(`warm-check ${tag} ${String.fromCodePoint(0x4f60, 0x597d, 0x1f680)}\n${'Long request details. '.repeat(3000).trimEnd()}`)
      }
      await expect(panel.getByText('Claude Code is working', { exact: false })).toBeVisible({ timeout: 5000 })
      timings.push(Date.now() - started)
      expect((await record(page, sid)).process_status).toBe('running')
      await expect(panel.getByText('Waiting for response...', { exact: true })).toHaveCount(0)
      expect((await record(page, sid)).pid).toBe(stablePid)
      expect(fs.existsSync(path.join(root, `release-${tag}`))).toBe(false)
      await expect(panel.getByText(`Verified reply ${tag}:`, { exact: false })).toHaveCount(0)
      if (round === 1) {
        const working = panel.getByText('Claude Code is working', { exact: false })
        await working.hover()
        await page.mouse.wheel(0, 500)
        await expect.poll(() => working.evaluate(element => {
          const rect = element.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return Boolean(hit && (element.contains(hit) || hit.contains(element)))
        })).toBe(true)
        await page.screenshot({ path: path.join(evidence, `${browserName}-${shape}-working.png`) })
      }
      if (round === 2) {
        const composer = panel.locator('.chat-input-textarea')
        await composer.fill('Unsent draft survives reconnect')
        const reconnected = page.waitForEvent('websocket')
        await page.evaluate(() => {
          const sockets = (window as unknown as { warmSockets: WebSocket[] }).warmSockets
          const live = sockets.filter(socket => socket.readyState === WebSocket.OPEN)
          if (!live.length) throw new Error('No live WebSocket to disconnect')
          for (const socket of live) socket.close()
        })
        await (await reconnected).waitForEvent('framereceived')
        await expect(composer).toHaveValue('Unsent draft survives reconnect')
        await expect(panel.getByText('Claude Code is working', { exact: false })).toBeVisible({ timeout: 10_000 })
        await composer.fill('')
      }
      release(tag)
      await expect(panel.getByText(`Verified reply ${tag}:`, { exact: false })).toBeVisible({ timeout: 15_000 })
      await idle(page, sid)
      expect((await record(page, sid)).pid).toBe(stablePid)
      await expect(panel.getByText(`Verified reply ${tag}:`, { exact: false })).toHaveCount(1)
    }
    const fast = `${browserName}-${shape}-fast`
    release(fast)
    await send(panel, fast)
    await expect(panel.getByText(`Verified reply ${fast}:`, { exact: false })).toBeVisible()
    await idle(page, sid)
    expect((await received(fast)).pid).toBe(seed.pid)
    expect((await record(page, sid)).pid).toBe(stablePid)
    if (shape === 'regular') {
      const crash = `${browserName}-crash`
      await send(panel, crash)
      await received(crash)
      await expect.poll(async () => (await record(page, sid)).process_status, { timeout: 15_000 }).toMatch(/stopped|error/)
      const recovered = `${browserName}-recovered`
      await send(panel, recovered)
      const resumed = await received(recovered)
      expect(resumed.pid).not.toBe(seed.pid)
      expect(resumed.args).toContain('--resume')
      await expect(panel.getByText('Claude Code is working', { exact: false })).toBeVisible({ timeout: 5000 })
      release(recovered)
      await expect(panel.getByText(`Verified reply ${recovered}:`, { exact: false })).toBeVisible()
      await idle(page, sid)
      const warmAgain = `${browserName}-after-recovery`
      await send(panel, warmAgain)
      expect((await received(warmAgain)).pid).toBe(resumed.pid)
      await expect(panel.getByText('Claude Code is working', { exact: false })).toBeVisible({ timeout: 5000 })
      release(warmAgain)
      await expect(panel.getByText(`Verified reply ${warmAgain}:`, { exact: false })).toBeVisible()
      await idle(page, sid)
    }
    await page.screenshot({ path: path.join(evidence, `${browserName}-${shape}-answered.png`) })
    fs.writeFileSync(path.join(evidence, `${browserName}-${shape}-metrics.json`), JSON.stringify({ sid, stablePid, timings }, null, 2))
  })
}
