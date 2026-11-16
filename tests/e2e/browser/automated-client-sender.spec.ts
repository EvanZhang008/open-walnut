import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'

/**
 * A browser under automation types into the composer: the words are an agent's, never the
 * person's (2026-11-16: a proof-video task drove headless Chromium on the user's own Walnut and
 * typed into another task's composer; both rows read `sentBy: "person"`, and the "the user is
 * using this task" guard then held that task's completion).
 *
 * Real browser, real composer, real server with the rule on (automated-client-server.ts): the row
 * the server queued for the CLI is read back from its store (its sentBy, and its text, from which
 * `task_history` reads the same word: tests/e2e/automated-client-sender.test.ts).
 *   1. The Playwright window (navigator.webdriver) sends: its socket says `automated=webdriver`,
 *      and the row reads `agent`, framed as Walnut's.
 *   2. A window like the person's (no webdriver, a person's browser user agent) sends: no mark,
 *      and the row reads `person`, unframed.
 */

interface Fixture { port: number; apiPort: number; home: string; taskIds: string[]; sessions: string[] }

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(300_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 820 } })

const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Automated client fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /AUTOMATED_CLIENT_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as Fixture)
      } else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Automated client fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  const port = await reservePort()
  child = spawn(bunRuntime(), ['tests/e2e/browser/automated-client-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_AUTOMATED_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (child.exitCode === null) child.kill('SIGKILL')
})

const base = () => `http://127.0.0.1:${fixture!.port}`
const api = () => `http://127.0.0.1:${fixture!.apiPort}`

/** Open the session's panel, type `words` into its composer and send them; returns what the page sent with. */
async function typeAndSend(page: Page, sid: string, words: string) {
  const sockets: string[] = []
  const marked: string[] = []
  page.on('websocket', (ws) => sockets.push(ws.url()))
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/') && req.headers()['x-walnut-automated']) marked.push(req.url())
  })
  await page.goto(`${base()}/sessions?id=${sid}`)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`).last()
  const input = panel.locator('textarea[placeholder*="Send a message to this session"]').first()
  await expect(input).toBeVisible({ timeout: 90_000 })
  await input.click()
  await input.pressSequentially(words, { delay: 15 })
  await input.press('Enter')
  return { sockets, marked }
}

/** The queue row holding `words`, as the server stored it: who sent it, and the text the CLI gets. */
async function queuedRow(sid: string, words: string): Promise<{ sentBy?: string; text: string }> {
  let found: { sentBy?: string; message: string } | undefined
  await expect.poll(async () => {
    const raw = await fs.readFile(path.join(fixture!.home, 'session-message-queue.json'), 'utf8').catch(() => '')
    const store = raw ? JSON.parse(raw) as { queues?: Record<string, Array<{ sentBy?: string; message: string }>> } : {}
    found = store.queues?.[sid]?.find((m) => m.message.includes(words))
    return found ? 'found' : 'missing'
  }, { timeout: 30_000, intervals: [250, 500, 1000] }).toBe('found')
  return { sentBy: found!.sentBy, text: found!.message }
}

test('the Playwright window\'s words are an agent\'s', async ({ page }) => {
  expect(await page.evaluate(() => navigator.webdriver)).toBe(true)
  const sid = fixture!.sessions[0]!
  const words = 'Video step: start a Walnut subagent'
  const sent = await typeAndSend(page, sid, words)
  expect(sent.sockets.some((u) => new URL(u).searchParams.get('automated') === 'webdriver')).toBe(true)
  expect(sent.marked.length).toBeGreaterThan(0)
  const row = await queuedRow(sid, words)
  expect(row.sentBy).toBe('agent')
  expect(row.text).toContain('browser automation (webdriver)')
})

test('a window like the person\'s still sends as the person', async ({ browser }: { browser: Browser }) => {
  // The person's browser: navigator.webdriver false and a browser's own user agent.
  const context = await browser.newContext({ userAgent: SAFARI_UA, viewport: { width: 1280, height: 820 } })
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }))
  const page = await context.newPage()
  try {
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false)
    const sid = fixture!.sessions[1]!
    const words = 'My own question about the release'
    const sent = await typeAndSend(page, sid, words)
    expect(sent.sockets.length).toBeGreaterThan(0)
    expect(sent.sockets.every((u) => !new URL(u).searchParams.has('automated'))).toBe(true)
    expect(sent.marked).toEqual([])
    const row = await queuedRow(sid, words)
    expect(row.sentBy).toBe('person')
    expect(row.text).toContain(words)
    expect(row.text).not.toContain('<walnut-message')
  } finally {
    await context.close()
  }
})
