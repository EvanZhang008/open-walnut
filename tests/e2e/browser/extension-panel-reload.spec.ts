/**
 * The side panel's Ask after a reload, on the product's real path: this spec boots its own
 * fixture Walnut with PW_MOCK_TRANSCRIPTS=1, so the mock CLI files every turn as its transcript the
 * way the real CLI does (tests/providers/mock-claude.mjs MOCK_CLAUDE_PERSIST_ALL). The shared
 * fixture keeps no transcript for a new session, which is what the second review saw: after a
 * reload only the replies, and a sent bubble left "Delivered" below the reply it asked for.
 *
 * Here: two questions (the second with a selection), each followed by its answer, in that order,
 * with no stray "Delivered" line; reopened, the person's own questions are still there, in order,
 * and the second still shows what it took from the page (read back from its saved hint).
 */
import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { bunRuntime } from '../../helpers/bun-runtime'
import { askView, openPanel, selectText, startPanelLab, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let server: ChildProcess | undefined
let lab: PanelLab

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve) })
  const a = s.address()
  await new Promise<void>((resolve) => s.close(() => resolve()))
  if (!a || typeof a === 'string') throw new Error('no port')
  return a.port
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const port = await freePort()
  let out = ''
  server = spawn(bunRuntime(), ['tests/e2e/browser/test-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_TEST_PORT: String(port), PW_MOCK_TRANSCRIPTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout?.on('data', (c) => { out = `${out}${String(c)}`.slice(-12_000) })
  server.stderr?.on('data', (c) => { out = `${out}${String(c)}`.slice(-12_000) })
  const deadline = Date.now() + 180_000
  for (;;) {
    if (server.exitCode !== null) throw new Error(`fixture exited (${server.exitCode})\n${out}`)
    if (Date.now() > deadline) throw new Error(`fixture did not start\n${out}`)
    try { if ((await fetch(`http://127.0.0.1:${port}/api/dashboard`)).ok) break } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  lab = await startPanelLab(`http://localhost:${port}`, 'reload')
})

test.afterAll(async () => {
  await lab?.close()
  if (server && server.exitCode === null) {
    const gone = new Promise<void>((r) => server!.once('exit', () => r()))
    server.kill('SIGTERM')
    await Promise.race([gone, new Promise((r) => setTimeout(r, 20_000))])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
})

/** The conversation as drawn, top to bottom: who and the words (nothing while the frame loads). */
const rowsOf = (panel: Page) => askView(panel).locator('.session-msg-user, .session-msg-assistant').evaluateAll((els) =>
  els.map((e) => `${e.classList.contains('session-msg-user') ? 'person' : 'walnut'}: ${(e.querySelector('.session-msg-content .markdown-body') as HTMLElement | null)?.innerText.trim() ?? ''}`))
  .catch(() => [] as string[])

const EXPECTED = [
  'person: What is this page about?',
  'walnut: Hello! I processed your message: What is this page about?',
  'person: Summarize the selection',
  'walnut: Hello! I processed your message: Summarize the selection',
]

test('two questions read question, answer, question, answer; reopened, the person\'s words are still there', async () => {
  test.setTimeout(180_000)
  let { panel } = await openPanel(lab, 'ask')
  const v = askView(panel)
  const first = v.locator('[data-testid="ask-object-compose"] textarea')
  await first.fill('What is this page about?')
  await first.press('Enter')
  await expect(v.getByText('Hello! I processed your message: What is this page about?')).toBeVisible({ timeout: 60_000 })

  await selectText(lab.doc, 'p2')
  await expect(v.getByTestId('ext-panel-selection')).toContainText('Dark mode follows', { timeout: 15_000 })
  const next = v.locator('.ask-object-session textarea')
  await next.fill('Summarize the selection')
  await next.press('Enter')
  await expect(v.getByText('Hello! I processed your message: Summarize the selection')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => rowsOf(panel), { timeout: 20_000 }).toEqual(EXPECTED)
  // No bubble is left waiting as "Delivered" once its row is saved, and no bare "Delivered" line.
  await expect(v.locator('.session-msg-assistant', { hasText: /^\s*Delivered\s*$/ })).toHaveCount(0)
  await expect(v.getByText('Delivered', { exact: true })).toHaveCount(0, { timeout: 15_000 })
  await panel.close()

  // Reopened (the panel loads the conversation from Walnut again): the same four, in order.
  ;({ panel } = await openPanel(lab, 'ask'))
  await expect.poll(() => rowsOf(panel), { timeout: 60_000 }).toEqual(EXPECTED)
  const second = askView(panel).locator('.session-msg-user').filter({ hasText: 'Summarize the selection' })
  await expect(second.getByTestId('ext-panel-attached')).toContainText('Dark mode follows the system setting')
  await expect(askView(panel).locator('.session-msg-user').filter({ hasText: 'What is this page about?' }).getByTestId('ext-panel-attached')).toHaveCount(0)
  const dir = process.env.PANEL_SHOTS_DIR
  if (dir) await panel.screenshot({ path: `${dir}/r2-reload-order.png` })
  await panel.close()
})
