/**
 * Walnut in the browser's side panel, through the real extension in Chromium
 * (packages/browser-extension/src/sidepanel.ts, web/src/popout/PopoutExtPanel.tsx): the panel
 * names the page the person is on and what they selected; a question starts an Ask Walnut
 * session about that page, whose first message carries the page as a folded block and its text
 * as a file; the person lets the ask act in their tab and the ask can then read it (another
 * caller cannot); a selection asked about later leads the next message; turning acting off
 * gives the tab back; another page gets a conversation of its own, and the first one comes back.
 *
 * The panel page opens here as a window of its own for the person's window (`?window=`, what a
 * browser with no side panel gets): Playwright cannot open Chrome's side panel itself.
 */
import { expect, test, chromium, type BrowserContext, type FrameLocator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'

test.describe.configure({ mode: 'serial' })

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
let doc: Page
let panel: Page
let docTab = 0
let askSession = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`

const PAGES: Record<string, { title: string; body: string }> = {
  '/notes': {
    title: 'Release notes 4.2',
    body: `<h1>Release notes 4.2</h1>
      <p id="p1">The sync engine now retries a failed upload three times before it gives up.</p>
      <p id="p2">Dark mode follows the system setting on every page.</p>
      <label>Feedback <input id="fb" name="fb"></label>
      <label>Password <input id="pw" type="password" value="Never-Read-This-42"></label>
      <label>Code <input id="otp" name="otp" value="913524"></label>`,
  },
  '/other': { title: 'Another page', body: '<h1>Another page</h1><p>Nothing to see.</p>' },
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ? `<!doctype html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>` : 'not found')
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

const sw = () => ctx.serviceWorkers()[0]
/** The agent frame on the person's tab (its host sits at that z-index; the field icons sit lower). */
const framed = () => doc.evaluate(() => [...document.querySelectorAll('walnut-ext')].some((e) => (e as HTMLElement).style.cssText.includes('2147483645')))
const view = (): FrameLocator => panel.frameLocator('iframe.panel-frame')

async function act(body: Record<string, unknown>, sid?: string): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = sid ? { 'x-walnut-caller-sid': sid } : { 'x-walnut-caller-kind': 'automation' }
  const r = await doc.request.post(`${base}/api/v1/browser/act`, { data: body, headers, timeout: 80_000 })
  return { status: r.status(), body: await r.json() }
}

test.beforeAll(async ({}, info) => {
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-panel-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.example.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  worker.on('console', (m) => { if (m.type() === 'error') console.log(`[background error] ${m.text()}`) })
  extId = new URL(worker.url()).host
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('connect the extension, then open the panel beside a page with a selection', async () => {
  test.setTimeout(150_000)
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()

  doc = ctx.pages()[0]
  await doc.goto(site('docs.example.test', '/notes'))
  await doc.bringToFront()
  await doc.evaluate(() => {
    const r = document.createRange()
    r.selectNodeContents(document.getElementById('p1')!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
  })
  const ids = await sw().evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, url: 'http://docs.example.test/*' })
    return { tab: t?.id ?? 0, window: t?.windowId ?? 0 }
  })
  docTab = ids.tab
  expect(docTab).toBeGreaterThan(0)
  const panelOpened = ctx.waitForEvent('page')
  await sw().evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`sidepanel.html?window=${w}`), type: 'popup', width: 420, height: 760 }), ids.window)
  panel = await panelOpened
  await expect(view().getByTestId('ext-panel')).toBeVisible({ timeout: 60_000 })
  await expect(view().locator('.ext-panel-title')).toHaveText('Release notes 4.2', { timeout: 30_000 })
  await expect(view().locator('.ext-panel-host')).toHaveText(`docs.example.test:${port}`)
  await expect(view().getByTestId('ask-object-quote')).toContainText('retries a failed upload three times')
  await expect(view().getByTestId('ext-panel-include')).toBeChecked()
  await expect(view().getByTestId('ext-panel-act')).not.toBeChecked()
  // A new selection on the page shows in the panel at once, without going to the panel.
  const select = (id: string) => doc.evaluate((id) => {
    const r = document.createRange()
    r.selectNodeContents(document.getElementById(id)!)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
  }, id)
  await select('p2')
  await expect(view().getByTestId('ask-object-quote')).toContainText('Dark mode follows', { timeout: 10_000 })
  await select('p1')
  await expect(view().getByTestId('ask-object-quote')).toContainText('retries a failed upload three times', { timeout: 10_000 })
})

/** The session's rows as history shows them: each user row's words, and the Walnut hints beside them. */
async function rows(sid: string): Promise<Array<{ role: string; text: string; hints?: Array<{ kind: string; text: string }> }>> {
  const r = await (await doc.request.get(`${base}/api/sessions/${sid}/history`)).json()
  return (Array.isArray(r) ? r : r.messages ?? []) as Array<{ role: string; text: string; hints?: Array<{ kind: string; text: string }> }>
}
/**
 * What the CLI received for the message with these words: the mock echoes its raw input for a
 * message holding `echo-input` (tests/providers/mock-claude.mjs), Walnut's hints included.
 */
async function received(sid: string, words: string): Promise<string> {
  let raw = ''
  await expect.poll(async () => {
    raw = (await rows(sid)).find((r) => r.role === 'assistant' && r.text.includes(words))?.text ?? ''
    return raw.length > 0
  }, { timeout: 30_000 }).toBe(true)
  return raw
}
/** The object-context hint's words in a raw message. */
const contextIn = (raw: string) => /<system-reminder>\s*Walnut \(object-context [^)]*\):([\s\S]*?)<\/system-reminder>/.exec(raw)?.[1] ?? ''

test('a question starts an ask about the page: its words alone, the page beside them as a Walnut hint, its text in a file', async () => {
  test.setTimeout(120_000)
  const launch = panel.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 60_000 })
  const composer = view().locator('.draft-session-panel textarea')
  await composer.fill('What changed for uploads? echo-input')
  await composer.press('Enter')
  const body = (await launch).postDataJSON() as { message: string; walnutAgent?: boolean }
  expect(body.walnutAgent).toBe(true)
  // The person's words go as they typed them: Walnut's note on the page is a hint beside them.
  expect(body.message).toBe('What changed for uploads? echo-input')
  expect((body as { hints?: Record<string, { arg?: string }> }).hints?.['object-context']?.arg).toMatch(/^hc-[0-9a-f]{16}$/)
  const session = view().getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  askSession = (await session.getAttribute('data-session-id')) ?? ''
  expect(askSession).not.toBe('')
  const raw = await received(askSession, 'What changed for uploads?')
  const note = contextIn(raw)
  expect(note).toContain(`Address: ${site('docs.example.test', '/notes')}`)
  expect(note).toContain('> The sync engine now retries a failed upload three times before it gives up.')
  expect(note).not.toContain('Dark mode follows') // the page's text is in the file, not the message
  const file = /The page's text is in (\S+?): read it/.exec(note)?.[1] ?? ''
  expect(file).toMatch(/browser-pages\/.+\.md$/)
  expect(fs.readFileSync(file, 'utf8')).toContain('Dark mode follows the system setting on every page.')
  // The panel folds the page block into one row: the bubble reads as the question.
  await expect(view().getByText('What changed for uploads?').first()).toBeVisible({ timeout: 30_000 })
  // No agent acts in the person's tab until they say so.
  // (Agents are still off in this browser, so there is no browser to send it to at all.)
  const before = await act({ action: 'snapshot', tab: docTab }, askSession)
  expect(before.status, JSON.stringify(before.body)).not.toBe(200)
  expect(['browser_not_connected', 'not_your_tab']).toContain(before.body.code)
})

test('the person lets the ask act in their tab: only it can read and act there', async () => {
  test.setTimeout(90_000)
  await view().getByTestId('ext-panel-act').check()
  await expect(view().getByTestId('ext-panel-act')).toBeChecked()
  // The tab wears the agent frame, and the conversation's next message carries a Walnut hint that it
  // may act there: nothing is typed into the person's composer.
  await expect.poll(framed, { timeout: 20_000 }).toBe(true)
  const composer = view().locator('.ask-object-session textarea')
  await expect(composer).toHaveValue('')
  await composer.fill('Fill in the feedback, please echo-input')
  await composer.press('Enter')
  const raw = await received(askSession, 'Fill in the feedback, please')
  expect(contextIn(raw)).toContain(`They let you act in this tab: tab ${docTab} of their browser`)
  // The person's own words are outside every Walnut block, as they typed them.
  expect(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')).toContain('Fill in the feedback, please echo-input')
  const snap = await act({ action: 'snapshot', tab: docTab }, askSession)
  expect(snap.status, JSON.stringify(snap.body)).toBe(200)
  expect(snap.body.snapshot).toContain('Release notes 4.2')
  const typed = await act({ action: 'type', tab: docTab, ref: /\[(e\d+)\] textbox "Feedback"/.exec(snap.body.snapshot)![1], text: 'Looks good' }, askSession)
  expect(typed.status, JSON.stringify(typed.body)).toBe(200)
  await expect(doc.locator('#fb')).toHaveValue('Looks good')
  // Another caller does not get the tab.
  const other = await act({ action: 'snapshot', tab: docTab })
  expect(other.status).toBe(403)
  // The site is allowed in this tab alone: no agent may open it elsewhere on that click.
  const status = await (await doc.request.get(`${base}/api/v1/browser/status`)).json()
  expect(status.sites.map((s: { site: string }) => s.site)).not.toContain('example.test')
})

test('a selection asked about later leads the next message', async () => {
  const composer = view().locator('.ask-object-session textarea')
  await composer.fill('')
  const w = await sw().evaluate(async (tab: number) => (await chrome.tabs.get(tab)).windowId, docTab)
  await sw().evaluate(({ win }) => chrome.storage.session.set({ panelAsk: { windowId: win, text: 'Dark mode follows the system setting', at: Date.now() } }), { win: w })
  await expect(composer).toHaveValue(/^> Dark mode follows the system setting\n\n/, { timeout: 15_000 })
})

test('turning acting off gives the tab back', async () => {
  await view().getByTestId('ext-panel-act').uncheck()
  await expect.poll(framed, { timeout: 15_000 }).toBe(false)
  await expect.poll(async () => (await act({ action: 'snapshot', tab: docTab }, askSession)).status, { timeout: 15_000 }).toBe(403)
})

test('Stop on the page takes the tab back, and the panel\'s switch follows', async () => {
  await view().getByTestId('ext-panel-act').check()
  await expect.poll(framed, { timeout: 20_000 }).toBe(true)
  await doc.bringToFront()
  const vw = await doc.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  // The Stop button is the right end of the pill in the bottom right corner (a closed shadow root).
  await doc.mouse.click(vw.w - 14 - 8 - 20, vw.h - 14 - 7 - 11)
  await expect(view().getByTestId('ext-panel-act')).not.toBeChecked({ timeout: 15_000 })
  await expect.poll(async () => (await act({ action: 'snapshot', tab: docTab }, askSession)).status, { timeout: 15_000 }).toBe(403)
})

test('another page has its own conversation, and the first one comes back', async () => {
  test.setTimeout(90_000)
  await doc.goto(site('docs.example.test', '/other'))
  await expect(view().locator('.ext-panel-title')).toHaveText('Another page', { timeout: 30_000 })
  await expect(view().getByTestId('ask-object-compose')).toBeVisible({ timeout: 30_000 })
  await doc.goto(site('docs.example.test', '/notes'))
  await expect(view().locator('.ext-panel-title')).toHaveText('Release notes 4.2', { timeout: 30_000 })
  await expect(view().getByTestId('ask-object-session')).toHaveAttribute('data-session-id', askSession, { timeout: 30_000 })
})

test('a secret field\'s selection never reaches the panel; a text box\'s does', async () => {
  // What the panel page is told about the tab, asked the way it asks.
  const context = () => panel.evaluate((tabId: number) => chrome.runtime.sendMessage({ type: 'panel-page', tabId }), docTab) as Promise<{ page: { selection?: string; text?: string } }>
  for (const id of ['#pw', '#otp']) {
    await doc.locator(id).evaluate((el: HTMLInputElement) => { if (el.type === 'password') el.type = 'text'; el.focus(); el.select() })
    const r = await context()
    expect(r.page.selection ?? '').toBe('')
    expect(r.page).not.toHaveProperty('text') // the page's text only when a question asks for it
  }
  await doc.locator('#fb').fill('a note to select')
  await doc.locator('#fb').evaluate((el: HTMLInputElement) => { el.focus(); el.select() })
  expect((await context()).page.selection).toBe('a note to select')
  const withText = await panel.evaluate((tabId: number) => chrome.runtime.sendMessage({ type: 'panel-page', tabId, withText: true }), docTab) as { page: { text?: string } }
  expect(withText.page.text).toContain('Dark mode follows the system setting')
  expect(withText.page.text).not.toContain('Never-Read-This-42')
  await doc.locator('#pw').evaluate((el: HTMLInputElement) => { el.type = 'password' })
})

test('acting turned on before the first question: the new ask gets the tab once it exists', async () => {
  test.setTimeout(120_000)
  await view().getByTestId('ext-panel-new').click()
  await expect(view().getByTestId('ask-object-compose')).toBeVisible({ timeout: 30_000 })
  await view().getByTestId('ext-panel-act').check()
  await expect(view().getByTestId('ext-panel-act')).toBeChecked()
  const launch = panel.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 60_000 })
  const composer = view().locator('.draft-session-panel textarea')
  await composer.fill('Fill in the feedback for me')
  await composer.press('Enter')
  const launched = (await launch).postDataJSON() as { message: string; hints?: Record<string, { arg?: string }> }
  expect(launched.message).toBe('Fill in the feedback for me')
  expect(launched.hints?.['object-context']?.arg).toBeTruthy()
  const session = view().getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const second = (await session.getAttribute('data-session-id')) ?? ''
  expect(second).not.toBe(askSession)
  await expect.poll(async () => (await act({ action: 'snapshot', tab: docTab }, second)).status, { timeout: 20_000 }).toBe(200)
  expect(await framed()).toBe(true)
  // The earlier conversation does not get it.
  expect((await act({ action: 'snapshot', tab: docTab }, askSession)).status).toBe(403)
  await expect(view().getByTestId('ext-panel-act')).toBeChecked()
})

test('New chat while the ask acts in the tab: the new conversation keeps the switch and gets the tab', async () => {
  test.setTimeout(120_000)
  const before = (await view().getByTestId('ask-object-session').getAttribute('data-session-id')) ?? ''
  await view().getByTestId('ext-panel-new').click()
  await expect(view().getByTestId('ask-object-compose')).toBeVisible({ timeout: 30_000 })
  // No "another conversation is acting" for the person's own conversation: the switch stays on.
  await expect(view().getByTestId('ext-panel-act')).toBeChecked()
  await expect(view().getByTestId('ext-panel-other-owner')).toHaveCount(0)
  const composer = view().locator('.draft-session-panel textarea')
  await composer.fill('Read the feedback box for me')
  await composer.press('Enter')
  const session = view().getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const third = (await session.getAttribute('data-session-id')) ?? ''
  expect(third).not.toBe(before)
  await expect.poll(async () => (await act({ action: 'snapshot', tab: docTab }, third)).status, { timeout: 20_000 }).toBe(200)
  expect((await act({ action: 'snapshot', tab: docTab }, before)).status).toBe(403)
  askSession = third
})

test('the page in a handed tab moves on (a link, a mail app opening a message): the same conversation, still acting', async () => {
  test.setTimeout(90_000)
  await doc.goto(site('docs.example.test', '/other'))
  await expect(view().locator('.ext-panel-title')).toHaveText('Another page', { timeout: 30_000 })
  await expect(view().getByTestId('ask-object-session')).toHaveAttribute('data-session-id', askSession, { timeout: 30_000 })
  await expect(view().getByTestId('ext-panel-other-owner')).toHaveCount(0)
  await expect(view().getByTestId('ext-panel-act')).toBeChecked()
  const snap = await act({ action: 'snapshot', tab: docTab }, askSession)
  expect(snap.status, JSON.stringify(snap.body)).toBe(200)
  expect(snap.body.snapshot).toContain('Another page')
  await doc.goto(site('docs.example.test', '/notes'))
  await expect(view().locator('.ext-panel-title')).toHaveText('Release notes 4.2', { timeout: 30_000 })
})

test('a tab another task acts in is said so, never offered to this one; Take it back', async () => {
  await sw().evaluate(async (tab: number) => {
    const { agentTabs } = await chrome.storage.session.get('agentTabs')
    await chrome.storage.session.set({ agentTabs: { ...(agentTabs ?? {}), [String(tab)]: { owner: 'task:someone-else', handed: 'example.test', history: [] } } })
  }, docTab)
  // Back in the panel: it asks the page again (its focus refresh).
  const inner = panel.frames().find((f) => f !== panel.mainFrame())!
  await inner.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(view().getByTestId('ext-panel-other-owner')).toBeVisible({ timeout: 15_000 })
  await expect(view().getByTestId('ext-panel-act')).toHaveCount(0)
  await view().getByTestId('ext-panel-take-back').click()
  await expect.poll(framed, { timeout: 15_000 }).toBe(false)
  await expect(view().getByTestId('ext-panel-act')).not.toBeChecked({ timeout: 15_000 })
})

test('the page script put in again (page-reach.ts, after an update) runs once and still answers', async () => {
  // Mark the copy that runs now (the content scripts' own world, as page-reach.ts injects).
  const mark = (tab: number) => chrome.scripting.executeScript({ target: { tabId: tab }, func: () => {
    const g = globalThis as { __walnutContentLive?: unknown; __probe?: unknown }
    g.__probe = g.__walnutContentLive
    return typeof g.__walnutContentLive
  } }).then((r) => r[0]?.result)
  expect(await sw().evaluate(mark, docTab)).toBe('function')
  for (let i = 0; i < 2; i++) await sw().evaluate(async (tab: number) => { await chrome.scripting.executeScript({ target: { tabId: tab, allFrames: true }, files: ['content.js'] }) }, docTab)
  // No second copy started: the liveness check is still the first copy's.
  const same = await sw().evaluate((tab: number) => chrome.scripting.executeScript({ target: { tabId: tab }, func: () => {
    const g = globalThis as { __walnutContentLive?: unknown; __probe?: unknown }
    return g.__probe === g.__walnutContentLive
  } }).then((r) => r[0]?.result), docTab)
  expect(same).toBe(true)
  const r = await sw().evaluate(async (tab: number) => chrome.tabs.sendMessage(tab, { type: 'agent-check' }, { frameId: 0 }), docTab) as { ok?: boolean }
  expect(r.ok).toBe(true)
  // The page itself cannot see it (another world).
  expect(await doc.evaluate(() => typeof (globalThis as { __walnutContentLive?: unknown }).__walnutContentLive)).toBe('undefined')
})
