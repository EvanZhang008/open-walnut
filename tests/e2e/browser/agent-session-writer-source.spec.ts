// Words inside a session timeline that another writer wrote render and open with THAT writer's
// machine, never the receiving session's (2026-11-07: a remote peer's note, a notice about a
// remote session, an earlier session's rows and an injected skill dump all drew and opened paths
// against the receiving session's folder and this machine).
//
// Real: the fixture server, the `pw-writer-source-session` transcript (test-server.ts, written with
// the PRODUCTION envelope builders: a LOCAL session quoting a remote peer whose envelope saved
// host `fixture-remote`, a Claude Code delivery naming no session, a Walnut note naming the remote
// session but no host, an injected skill dump, a person's message with a picture beside a notice
// about the remote session, its own send to the remote session, a Glob result naming a picture,
// a Read result with a base64 picture), the history route, the renderers, the opener and every
// React handler. Mocked at the host boundary only (page.route): the remote host's answers for the
// seeded paths (the host fixture serves no file bytes; its picture is a different PNG), and the
// timing of the remote session's record read where a test holds it.
// Boundary stubs, NOT store-proved (the fixture has no seed path for them; their server side is
// covered by integration tests): the task's earlier-session list and the earlier row's transcript
// (test 3), the receiving session's record answering a remote host (test 5), and the record and
// plan read of a session run from another session's plan (tests 9, 10), the streaming session's
// record answering the remote host (test 11; its task, session and turns are real: the mock CLI
// streams the reply and the server keeps it), and one row naming the seeded paths added to the
// REAL chat-earlier answer of the fixture's continued phone chat (test 12; a seeded conversation
// would be filed as an ask on every other spec's board).
// Runs on a test server only (:3456 is refused). Video per test; screenshots in
// /tmp/agent-session-source; run with `--output "$WALNUT_TASK_DIR/pw-agent-session-source"`.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { test, expect, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { AGENT_TEXT_BASE as base, click, closeFile, openApp, openTaskSession, showPointer, tabTo, taskWithReply } from './agent-text-entry-helpers'
import { CONT_ASK, addEarlierAsks, openAsk } from './ask-chat-earlier-helpers'
import { EARLIER_CONT_SESSION } from './chat-earlier-fixture'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openAllTurnFolds } from './turn-fold-helpers'

const REMOTE = 'fixture-remote'
const REMOTE_SID = 'pw-limits-remote-session'
const SID = 'pw-writer-source-session'
const TASK = 'pw-task-writer-source'
const TITLE = 'Writer source fixture task'
const OLD_SID = 'pw-writer-source-old-session'
const REMOTE_TEXT = 'Remote copy\nRemote line two from fixture-remote\nRemote line three\n'
const SHOTS = '/tmp/agent-session-source'
const REMOTE_PICTURE = fileURLToPath(new URL('../../../web/public/icon-512.png', import.meta.url))
const LOCAL = new Set(['', 'local', '__local__'])

let DOC = ''
let SHOT = ''
let remotePng: Buffer

test.describe.configure({ mode: 'default' })
test.setTimeout(150_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: 'on' })

test.beforeAll(async () => {
  if (new URL(base).port === '3456') throw new Error('These checks read fixture sessions: run them on a test server, never production')
  const { walnutHome } = await discoverBrowserFixture(Number(new URL(base).port))
  DOC = path.join(walnutHome, 'ss', 'notes.txt')
  SHOT = path.join(walnutHome, 'ss', 'shot.png')
  // The primary's own copies, written by the fixture: a wrong pick shows these bytes.
  expect(await fs.readFile(DOC, 'utf8')).toContain('Primary line two')
  remotePng = await fs.readFile(REMOTE_PICTURE)
  expect(createHash('sha256').update(remotePng).digest('hex')).not.toBe(createHash('sha256').update(await fs.readFile(SHOT)).digest('hex'))
  await fs.mkdir(SHOTS, { recursive: true })
})

// ── The remote host's answers, and what the page asked for ──

const FILE_API = /^\/api\/(?:file-content$|file-raw\/|local-image$|files\/(?:locate|list|list-many|exists)$)/
type Touch = { api: string; host: string; path: string }

function touchOf(req: Request): Touch | null {
  const url = new URL(req.url())
  if (!FILE_API.test(url.pathname)) return null
  if (url.pathname.startsWith('/api/file-raw/')) {
    const [, , , host, ...rest] = url.pathname.split('/')
    return { api: 'file-raw', host: decodeURIComponent(host!), path: '/' + rest.map(decodeURIComponent).join('/') }
  }
  let body: { paths?: string[]; host?: string } = {}
  if (req.method() === 'POST') { try { body = req.postDataJSON() ?? {} } catch { /* not JSON */ } }
  const q = url.searchParams
  const p = q.get('ref') ?? q.get('path') ?? body.paths?.find((x) => x === DOC || x === SHOT || x === path.dirname(DOC)) ?? ''
  return { api: url.pathname.replace('/api/', ''), host: q.get('host') ?? body.host ?? 'local', path: p }
}

const ours = (t: Touch) => t.path === DOC || t.path === SHOT || t.path === path.dirname(DOC)

function listing(p: string) {
  // The file's own folder holds the file; any other folder (the session's, once Files is pressed) holds a few unrelated entries.
  const entries = p === path.dirname(DOC)
    ? [{ name: 'notes.txt', type: 'file', size: Buffer.byteLength(REMOTE_TEXT) }]
    : [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file', size: 64 }]
  return p === DOC ? { path: path.dirname(p), entries: listing(path.dirname(p)).entries, selectedFile: 'notes.txt' } : { path: p, entries }
}

async function remoteHost(route: Route): Promise<void> {
  const t = touchOf(route.request())
  if (!t || t.host !== REMOTE) return route.fallback()
  const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const req = route.request()
  switch (t.api) {
    case 'files/locate': return json(t.path === DOC ? { path: DOC, host: REMOTE, hostName: 'Big remote host', found: true } : { path: t.path, host: REMOTE, found: false, missing: true })
    case 'files/list': return json(listing(t.path))
    case 'files/list-many': return json({ listings: ((req.postDataJSON()?.paths ?? []) as string[]).map(listing), truncated: false, timedOut: false })
    case 'files/exists': return json({ exists: Object.fromEntries(((req.postDataJSON()?.paths ?? []) as string[]).map((x) => [x, x === DOC || x === SHOT])) })
    case 'file-content':
      if (t.path !== DOC) return json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: path.extname(t.path).slice(1) })
      return json({ content: REMOTE_TEXT, size: Buffer.byteLength(REMOTE_TEXT), truncated: false, binary: false, extension: 'txt', contentHash: createHash('sha256').update(REMOTE_TEXT).digest('hex') })
    case 'local-image':
      if (t.path !== SHOT) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ status: 200, contentType: 'image/png', body: remotePng })
    default: return route.fallback()
  }
}

/** Holds the remote session's record read while `held`. */
class Gate {
  held = false
  private waiting: Array<() => void> = []
  get count(): number { return this.waiting.length }
  wait(): Promise<void> { return new Promise((go) => this.waiting.push(go)) }
  release(): void { this.held = false; for (const go of this.waiting.splice(0)) go() }
}

interface Net {
  gate: Gate
  lookups(): number
  /** Requests for a seeded path on this machine, `api host path`. */
  primary(api?: string): string[]
  remote(api?: string): string[]
  /** File reads other than pictures (the person's own picture in the fixture loads from here by design). */
  reads(): string[]
  errors: string[]
}

async function watchNet(page: Page): Promise<Net> {
  const seen: Request[] = []
  const errors: string[] = []
  const gate = new Gate()
  page.on('request', (r) => seen.push(r))
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route((url) => FILE_API.test(url.pathname), remoteHost)
  await page.route((url) => url.pathname === `/api/sessions/${REMOTE_SID}`, async (route) => {
    if (route.request().method() === 'GET' && gate.held) await gate.wait()
    return route.fallback()
  })
  const touches = () => seen.map(touchOf).filter((t): t is Touch => !!t && ours(t))
  const line = (t: Touch) => `${t.api} ${t.host} ${t.path}`
  return {
    gate, errors,
    lookups: () => seen.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`).length,
    primary: (api) => touches().filter((t) => LOCAL.has(t.host) && (!api || t.api === api)).map(line),
    remote: (api) => touches().filter((t) => t.host === REMOTE && (!api || t.api === api)).map(line),
    reads: () => touches().filter((t) => t.api !== 'local-image').map(line),
  }
}

let net: Net

test.beforeEach(async ({ page }) => {
  await showPointer(page)
  await isolateUiPrefs(page)
  net = await watchNet(page)
})

test.afterEach(async ({ page }, info) => {
  net.gate.release()
  await page.screenshot({ path: `${SHOTS}/${info.title.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 80)}.png` }).catch(() => {})
  expect(net.errors, 'no page error').toEqual([])
})

// ── Steps ──

async function openFixture(page: Page): Promise<Locator> {
  await openApp(page)
  const panel = await openTaskSession(page, TITLE, TASK, SID)
  await expect(panel.getByText('WS_LAST')).toBeVisible({ timeout: 30_000 })
  await openAllTurnFolds(panel)
  return panel
}

/** A provenance card by its folded title (or words), opened by a press on its fold. */
async function openCard(page: Page, panel: Locator, words: string): Promise<Locator> {
  return unfold(page, panel.locator('.provenance-card').filter({ hasText: words }).first())
}

/** A card's own fold toggle: a provenance card's fold row, or an op card's Details button (a send). */
const foldOf = (card: Locator) => card.locator('.provenance-fold, .op-card-main').first()

/** One provenance card, opened by a press on its fold. */
async function unfold(page: Page, card: Locator): Promise<Locator> {
  await expect(card).toHaveCount(1, { timeout: 20_000 })
  if ((await card.getAttribute('data-folded')) === 'true') await click(page, foldOf(card))
  await expect(card).toHaveAttribute('data-folded', 'false')
  return card
}

/** XPath test for one class in an element's class list. */
const hasClass = (name: string) => `contains(concat(" ", normalize-space(@class), " "), " ${name} ")`

/** A collapsed row's own toggle and the row it heads, by the label on that toggle (never a fold that holds the row). */
function runRow(panel: Locator, label: string): { label: Locator; toggle: Locator; row: Locator; body: Locator } {
  const own = panel.locator('.tool-run-row:not(.process-fold) > .tool-run-toggle > .tool-run-label', { hasText: label })
  const toggle = own.locator(`xpath=parent::button[${hasClass('tool-run-toggle')}]`)
  const row = toggle.locator(`xpath=parent::div[${hasClass('tool-run-row')}]`)
  return { label: own, toggle, row, body: row.locator(':scope > .tool-run-body') }
}

const docLink = (scope: Locator) => scope.locator(`a.file-link[data-file-path="${DOC}"]`).first()
const pictures = (scope: Locator) => scope.locator('img[src*="local-image"]')

async function expectRemoteText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Remote line two from fixture-remote', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Primary')
}

/** `viewer`: where the file opens, the overlay unless the panel shows it beside the chat. */
async function expectPrimaryText(page: Page, viewer: Locator = page.locator('.file-viewer-overlay')): Promise<void> {
  await expect(viewer.locator('.cm-content')).toContainText('Primary line two', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Remote')
}

/** Nothing is read anywhere, and the viewer says the writer was not recorded. */
async function expectRefused(page: Page): Promise<void> {
  const failure = page.getByTestId('file-viewer-source-error')
  await expect(failure).toBeVisible({ timeout: 20_000 })
  await expect(failure).toContainText('No file was read')
  await settle(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
}

/** Every picture in `scope` loaded, from the remote host only. */
async function expectRemotePictures(scope: Locator): Promise<void> {
  const imgs = pictures(scope)
  await expect(imgs.first()).toBeVisible({ timeout: 20_000 })
  for (const src of await imgs.evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''))) {
    expect(src).toContain(`host=${REMOTE}`)
  }
  await expect.poll(() => imgs.first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 20_000 }).toBe(512)
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((go) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(go, 800)))))
}

/**
 * The tool card named `name`: inside the merged run whose line reads `run` ("Searched files, read
 * a file ›") when the page draws one, opened by a press on its own line (a turn fold's body is no
 * run body); an opened turn draws its calls flat, one row each (main's "every step of a turn is one
 * row", 2026-11-11), so there the card is on the page as it is. Then the card's own header.
 */
async function openTool(page: Page, panel: Locator, run: string, name: string): Promise<Locator> {
  const named = (scope: Locator) => scope.locator('.chat-tool-block').filter({ has: page.locator('.chat-tool-block-name', { hasText: new RegExp(`^${name}$`) }) })
  const r = runRow(panel, run)
  await expect.poll(async () => (await r.label.count()) + (await named(panel).count()), { timeout: 15_000 }).toBeGreaterThan(0)
  let scope = panel
  if ((await r.label.count()) === 1) {
    if ((await r.body.count()) === 0) await click(page, r.toggle)
    await expect(r.body).toBeVisible()
    scope = r.body
  }
  const tool = named(scope)
  await expect(tool).toHaveCount(1, { timeout: 15_000 })
  // A card the page remembers open is restored a moment after it draws: pressing before that closes it again.
  await settle(page)
  if ((await tool.locator('.chat-tool-block-body').count()) === 0) await click(page, tool.locator('.chat-tool-block-header'))
  await expect(tool.locator('.chat-tool-block-body')).toBeVisible()
  return tool
}

// ── Tests ──

test('(1) a remote peer\'s note opens and draws on its saved host; a sender Walnut cannot name reads nothing', async ({ page }) => {
  const panel = await openFixture(page)
  const card = await openCard(page, panel, 'WS_PEER_REMOTE note')
  const body = card.locator('.provenance-body')
  await expectRemotePictures(body)

  await click(page, docLink(body))
  await expectRemoteText(page)
  await closeFile(page)
  // The keyboard from the board's search box, as a person tabs into the column.
  await tabTo(page, page.locator('.todo-search-input'), docLink(body))
  await page.keyboard.press('Enter')
  await expectRemoteText(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  expect(net.primary('file-content'), 'nothing of the remote note was read on this machine').toEqual([])

  // Claude Code's own delivery names no session and no host: no picture, and a press reads nothing.
  const before = net.reads().length
  const unknown = await openCard(page, panel, 'Unknown notes')
  await expect(pictures(unknown)).toHaveCount(0)
  await click(page, docLink(unknown.locator('.provenance-body')))
  await expectRefused(page)
  expect(net.reads().slice(before), 'zero bytes read for an unknown writer').toEqual([])
})

test('(2) this session\'s own send opens its words on this machine, never on its remote target', async ({ page }) => {
  const panel = await openFixture(page)
  const card = await openCard(page, panel, 'WS_OUTBOUND send')
  await expect(card).toHaveAttribute('data-envelope-kind', 'outbound')
  await click(page, docLink(card.locator('.provenance-body')))
  await expectPrimaryText(page)
  await closeFile(page)
  expect(net.remote(), 'nothing was asked of the target\'s host').toEqual([])
})

test('(3) a task\'s earlier session draws and opens its rows on that session\'s own host and folder', async ({ page }) => {
  // Boundary stubs (not store-proved): the record says this session resumed an earlier one, the
  // task lists that earlier session on the remote host, and its transcript names the paths.
  const at = new Date().toISOString()
  await page.route((url) => url.pathname === `/api/sessions/${SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json()
    body.session = { ...body.session, resumedBySwitch: { fromSessionId: OLD_SID, at, carriedTurns: 1 } }
    return route.fulfill({ response: res, json: body })
  })
  await page.route((url) => url.pathname === `/api/v1/tasks/${TASK}/sessions`, (route) => route.fulfill({ json: {
    taskId: TASK, activeSessionId: SID, legacySessionIds: [],
    sessions: [
      { session_id: OLD_SID, engine: 'claude-code', model: null, host: REMOTE, cwd: path.dirname(DOC), started_at: at, last_active_at: at, message_count: 1, process_status: 'stopped', active: false },
      { session_id: SID, engine: 'claude-code', model: null, host: null, cwd: null, started_at: at, last_active_at: at, message_count: 8, process_status: 'stopped', active: true,
        resumed: { session_id: OLD_SID, engine: 'claude-code', at, carried_turns: 1 } },
    ],
  } }))
  await page.route((url) => url.pathname === `/api/v1/sessions/${OLD_SID}/transcript`, (route) => route.fulfill({ json: {
    messages: [{ id: 'ws-old-1', role: 'assistant', text: `Earlier notes at ${DOC}:2 and ${SHOT} WS_EARLIER` }],
  } }))
  const panel = await openFixture(page)
  const block = panel.locator(`[data-testid="task-earlier-session"][data-session-id="${OLD_SID}"]`)
  await expect(block).toBeVisible({ timeout: 20_000 })
  await click(page, block.locator('.task-earlier-toggle'))
  await expect(block.getByText('WS_EARLIER')).toBeVisible({ timeout: 20_000 })
  await expectRemotePictures(block)
  await click(page, docLink(block))
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.primary('file-content'), 'the current session\'s machine was never read for the earlier rows').toEqual([])
  await expect(block.locator('img[src*="local-image"]:not([src*="host="])')).toHaveCount(0)
})

test('(4) an injected skill dump has no writer: no picture, and a press reads nothing', async ({ page }) => {
  const panel = await openFixture(page)
  // The skill line's own row, not the "Received 1 message" fold around it.
  const skill = runRow(panel, 'Loaded skill ws-source')
  await expect(skill.label).toHaveCount(1, { timeout: 15_000 })
  await click(page, skill.toggle)
  const row = skill.body
  await expect(row.getByText('WS_INJECTED')).toBeVisible()
  await expect(pictures(row)).toHaveCount(0)
  const before = net.reads().length
  await click(page, docLink(row))
  await expectRefused(page)
  expect(net.reads().slice(before), 'zero bytes read').toEqual([])
})

test('(5) a remote session\'s own reply, tool output and Read picture draw from its host', async ({ page }) => {
  // Boundary stub (not store-proved): the session's record answers the remote host, as a remote
  // session's does; the history itself is the real fixture transcript.
  await page.route((url) => url.pathname === `/api/sessions/${SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json()
    body.session = { ...body.session, host: REMOTE }
    return route.fulfill({ response: res, json: body })
  })
  const panel = await openFixture(page)
  const reply = panel.locator('.session-msg-assistant').filter({ hasText: 'WS_OWN_REPLY' }).first()
  await expectRemotePictures(reply)
  const list = await openTool(page, panel, 'Searched files', 'Glob')
  await expectRemotePictures(list)
  // The result text's path opens once, on the session's host, never this machine's copy.
  const preview = panel.locator('.session-file-explorer-preview')
  await expect(preview).toHaveCount(0)
  const resultLink = docLink(list.locator('.chat-tool-block-result'))
  await resultLink.scrollIntoViewIfNeeded()
  const historyBox = await panel.locator('.session-history').boundingBox()
  expect(historyBox).not.toBeNull()
  await page.mouse.move(historyBox!.x + historyBox!.width / 2, historyBox!.y + historyBox!.height / 2)
  await page.mouse.wheel(0, -180)
  await page.waitForTimeout(200)
  await click(page, resultLink)
  await expect(preview.locator('.cm-content')).toContainText('Remote line two from fixture-remote', { timeout: 30_000 })
  await expect(preview.locator('.cm-content')).not.toContainText('Primary')
  // The `:2` of the path lands on line 2 (the landing flash), in a tree rooted at the file's own folder.
  await expect(preview.locator('.cm-jump-flash')).toHaveText('Remote line two from fixture-remote')
  await expect(panel.locator('.session-file-explorer-body')).not.toContainText('README.md')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  const files = panel.getByRole('button', { name: 'Files', exact: true }).first()
  await click(page, files)
  await expect(preview.locator('.cm-content')).toContainText('Remote line two from fixture-remote')
  // Files is the session's own folder (the landing flash was the click's, not this view's).
  await expect(panel.locator('.session-file-explorer-body')).toContainText('README.md')
  await click(page, files)
  await expect(preview).toHaveCount(0)
  const read = await openTool(page, panel, 'Searched files', 'Read')
  await expect(read).toContainText('WS_TOOL_BASE64')
  await expectRemotePictures(read)
  await expect(read.locator('.tool-result-images img')).toHaveCount(1)
  expect(net.primary('file-content'), 'nothing of the remote session was read on this machine').toEqual([])
  for (const scope of [reply, list]) await expect(scope.locator('img[src*="local-image"]:not([src*="host="])')).toHaveCount(0)
})

test('(6) a person\'s picture beside a notice loads from this machine; the notice\'s quote opens on its own writer', async ({ page }) => {
  const panel = await openFixture(page)
  // The person's words are their own bubble; the notice that came with them is a step of
  // the turn, in its fold (2026-11-11: notices after the words fold).
  const plain = panel.locator('.session-msg-user .markdown-body').filter({ hasText: 'WS_PERSON' })
  await expect(plain).toHaveCount(1, { timeout: 20_000 })
  const img = pictures(plain).first()
  await expect(img).toBeVisible({ timeout: 20_000 })
  expect(await img.getAttribute('src')).not.toContain('host=')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 20_000 }).toBe(192)

  // The notice delivered with those words: Walnut's one notification in the turn's fold right
  // after them. Its sender's name is no key (every remote peer card names the same session).
  const fold = plain.locator('xpath=following::*[@data-testid="turn-fold"][1]')
  await expect(fold).toHaveCount(1)
  if ((await fold.getAttribute('data-open')) !== 'true') await click(page, fold.locator(':scope > .tool-run-toggle'))
  await expect(fold).toHaveAttribute('data-open', 'true')
  const card = await unfold(page, fold.locator('.provenance-card[data-envelope-kind="notification"]'))
  const quote = card.locator('.provenance-quote').filter({ hasText: 'WS_NOTICE_QUOTE' })
  await click(page, docLink(quote))
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.lookups(), 'the quote\'s writer was read on the press').toBeGreaterThanOrEqual(1)
  expect(net.primary('file-content'), 'the quote was never read on this machine').toEqual([])
})

test('(7) a press whose writer lookup is still out opens nothing once the card is closed', async ({ page }) => {
  const panel = await openFixture(page)
  const card = await openCard(page, panel, 'WS_PEER_PENDING note')
  const body = card.locator('.provenance-body')
  // No record held yet: nothing loads before the press.
  await expect(pictures(body)).toHaveCount(0)
  net.gate.held = true
  const before = net.lookups()
  await click(page, docLink(body))
  await expect.poll(() => net.gate.count, { timeout: 10_000 }).toBe(1)
  expect(net.lookups()).toBe(before + 1)
  // The card closes while the read is out; the late answer must open nothing.
  await click(page, foldOf(card))
  await expect(card).toHaveAttribute('data-folded', 'true')
  net.gate.release()
  await settle(page)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  expect(net.reads(), 'no file was read on either host').toEqual([])
})

// ── Plans: the panel's own, and one inherited from the session it was started from ──

/** Boundary stubs (not store-proved): the record says the session runs from `writer`'s plan, and the plan read names that writer. */
async function inheritPlan(page: Page, writer: string): Promise<void> {
  await page.route((url) => url.pathname === `/api/sessions/${SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json()
    body.session = { ...body.session, fromPlanSessionId: writer }
    return route.fulfill({ response: res, json: body })
  })
  await page.route((url) => url.pathname === `/api/sessions/${SID}/plan`, (route) => route.fulfill({ json: {
    content: `# Inherited plan\n\nRead ${DOC}:2 and see ${SHOT} WS_INHERITED_PLAN`, sourceSessionId: writer,
  } }))
}

async function planCard(page: Page, panel: Locator, words: string): Promise<Locator> {
  // A plan card starts folded (SessionMessage.tsx PlanCard): its words show once it is opened,
  // as the person opens it, with its own toggle.
  const cards = panel.locator('.session-plan-card')
  await expect(cards.first()).toBeVisible({ timeout: 20_000 })
  for (const toggle of await cards.locator('.session-plan-card-toggle[aria-expanded="false"]').all()) await click(page, toggle)
  const card = cards.filter({ hasText: words }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  return card
}

async function openPopover(page: Page, card: Locator): Promise<Locator> {
  await click(page, card.locator('.plan-card-expand-btn'))
  const body = page.locator('.plan-popup-overlay .plan-popup-body')
  await expect(body).toBeVisible({ timeout: 15_000 })
  return body
}

test('(8) the session\'s own plan opens through the panel, on this machine', async ({ page }) => {
  const panel = await openFixture(page)
  const card = await planCard(page, panel, 'WS_OWN_PLAN')
  await click(page, docLink(card))
  // The panel's own file pane beside the chat shows it; no overlay opens.
  await expectPrimaryText(page, panel.locator('.session-file-explorer-preview'))
  await expect(panel.locator('.session-file-explorer-preview .cm-jump-flash')).toHaveText('Primary line two')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  expect(net.remote(), 'the own plan asked nothing of the remote host').toEqual([])
})

test('(9) a plan inherited from a remote writer draws nothing from this machine and opens only on the writer\'s host', async ({ page }) => {
  await inheritPlan(page, REMOTE_SID)
  const panel = await openFixture(page)
  const card = await planCard(page, panel, 'WS_INHERITED_PLAN')
  await expect(card.locator('img[src*="local-image"]:not([src*="host="])'), 'the card drew no picture from this machine').toHaveCount(0)
  await click(page, docLink(card))
  await expectRemoteText(page)
  await closeFile(page)
  const popover = await openPopover(page, card)
  await expect(popover).toContainText('WS_INHERITED_PLAN')
  await expect(popover.locator('img[src*="local-image"]:not([src*="host="])'), 'the popover drew no picture from this machine').toHaveCount(0)
  await click(page, docLink(popover))
  await expectRemoteText(page)
  expect(net.primary('file-content'), 'nothing of the inherited plan was read on this machine').toEqual([])
})

test('(10) a plan whose writer Walnut no longer knows reads no file at all', async ({ page }) => {
  await inheritPlan(page, 'pw-ws-missing-plan-writer')
  const panel = await openFixture(page)
  const card = await planCard(page, panel, 'WS_INHERITED_PLAN')
  await expect(pictures(card)).toHaveCount(0)
  await click(page, docLink(card))
  await expectRefused(page)
  const popover = await openPopover(page, card)
  await expect(pictures(popover)).toHaveCount(0)
  await click(page, docLink(popover))
  await expect(page.getByTestId('file-viewer-source-error')).toBeVisible({ timeout: 20_000 })
  expect(net.reads(), 'zero file reads on either host').toEqual([])
})

// ── A reply while it streams and once it lands; a phone chat's earlier rows ──

test('(11) a remote session\'s reply draws its picture from the same host while it streams and once it lands', async ({ page, request }) => {
  const title = `Writer stream ${Date.now().toString(36)}`
  const made = await taskWithReply(request, title, 'Walnut', 'WS stream warmup', { keepSession: true })
  let release: () => void = () => {}
  try {
    // Boundary stub (not store-proved), as in (5): the session's record answers the remote host.
    await page.route((url) => url.pathname === `/api/sessions/${made.sid}`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const res = await route.fetch()
      const body = await res.json()
      body.session = { ...body.session, host: REMOTE }
      return route.fulfill({ response: res, json: body })
    })
    // History reads from the send on wait, so the streamed block is measured alone.
    let holding = false
    const held = new Promise<void>((go) => { release = go })
    await page.route((url) => url.pathname === `/api/sessions/${made.sid}/history`, async (route) => {
      if (holding) await held
      return route.fallback()
    })
    await openApp(page)
    const panel = await openTaskSession(page, title, made.id, made.sid)
    // The first history read has landed (the warm-up reply shows) before the gate closes.
    await expect(panel.getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    const marker = `WS_STREAM_${Date.now().toString(36)}`
    const words = `Streaming check. Saved the screenshot: ${SHOT} and nothing more ${marker}`
    await click(page, panel.locator('.chat-input-textarea').first())
    // The words travel encoded: the sender's own bubble must not draw the picture itself.
    await page.keyboard.type(`chunk-delay:600 stream-partial-say:${Buffer.from(words).toString('base64url')}`)
    // Closed before the send, so no read between the send and the first streamed frame slips past.
    holding = true
    await page.keyboard.press('Enter')

    const streamed = panel.locator('[data-stream-reply]', { hasText: 'Streaming check.' }).first()
    await expect(streamed).toBeVisible({ timeout: 40_000 })
    await expect(streamed).toContainText(marker, { timeout: 30_000 })
    await expectRemotePictures(streamed)
    const streamedSrc = await pictures(streamed).first().getAttribute('src')
    await page.screenshot({ path: `${SHOTS}/11-streamed.png` })
    await expect(panel.locator('.session-working-indicator')).toHaveCount(0, { timeout: 20_000 })
    const persisted = panel.locator('[data-msg-ts]:not([data-stream-reply])', { hasText: marker })
    expect(await persisted.count(), 'the history read is held: no persisted row yet').toBe(0)

    holding = false
    release()
    await expect(persisted).toHaveCount(1, { timeout: 20_000 })
    await expectRemotePictures(persisted)
    expect(await pictures(persisted).first().getAttribute('src'), 'the landed row draws from the streamed block\'s host').toBe(streamedSrc)
    await expect.poll(async () => ((await panel.locator('.session-history').textContent()) ?? '').split(marker).length - 1).toBe(1)
    await expect(panel.locator('img[src*="local-image"]:not([src*="host="])'), 'no picture from this machine').toHaveCount(0)
    expect(net.primary('local-image'), 'the picture was never asked of this machine').toEqual([])
  } finally {
    release()
    await request.post(`/api/sessions/${made.sid}/terminate`).catch(() => {})
    await request.delete(`/api/tasks/${made.id}?force=true`).catch(() => {})
  }
})

test('(12) a phone chat\'s earlier row names no writer: no picture, no read, and a press asks which machine', async ({ page }) => {
  await page.route((url) => url.pathname === `/api/v1/sessions/${EARLIER_CONT_SESSION}/chat-earlier`, async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as { messages?: unknown[] }
    body.messages = [...(body.messages ?? []), { id: 'ws-chat-earlier-paths', role: 'assistant', text: `Earlier notes at ${DOC}:2 and ${SHOT} WS_CHAT_EARLIER` }]
    return route.fulfill({ response: res, json: body })
  })
  await addEarlierAsks(page)
  const session = await openAsk(page, CONT_ASK.title, EARLIER_CONT_SESSION, base)
  const row = session.locator('[data-testid="chat-earlier-row"]', { hasText: 'WS_CHAT_EARLIER' })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(pictures(row)).toHaveCount(0)
  await expect(row.locator(`a.file-link[data-file-path="${SHOT}"]`)).toHaveCount(1)
  await settle(page)
  expect(net.primary(), 'nothing loaded or probed on this machine before a press').toEqual([])
  expect(net.remote(), 'nor on the remote host').toEqual([])

  await click(page, docLink(row))
  const failure = page.getByTestId('file-viewer-source-error')
  await expect(failure).toBeVisible({ timeout: 20_000 })
  await expect(failure).toContainText('No file was read')
  const choice = page.getByTestId('file-source-choice')
  await expect(choice).toBeVisible()
  await settle(page)
  expect(net.reads(), 'zero reads before a machine is picked').toEqual([])
  await page.screenshot({ path: `${SHOTS}/12-choose-machine.png` })

  // The person names this machine: only then is it read, and nothing is asked of the other host.
  await click(page, choice.getByTestId('file-source-local'))
  await expectPrimaryText(page)
  await closeFile(page)
  expect(net.remote(), 'only the picked machine was asked').toEqual([])
})
