// An Org thread's text opens on the machine of whoever wrote each block (web/src/components/org/
// OrgThreads.tsx, thread-text-source.ts; 2026-11-07: a summary's path and an answer's picture
// were read on the node's current machine though another session on another host wrote them).
//
// Scenario matrix (one lead, two threads):
//  1. a summary written through the route by the remote session (`pw-limits-remote-session`, host
//     `fixture-remote`), with a forged writer in the body, then pinned by the user and repeated by a
//     caller Walnut cannot place: the server keeps the remote session; its path opens the remote
//     host's copy on the first press, reading nothing here and no session record;
//  2. in one conversation: an answer read from the remote session (its picture loads from that host,
//     its path opens there), an answer kept before writers were recorded (no picture loads anywhere,
//     its path opens nowhere and says why, no file read on either host), and the user's own words
//     with the same path and picture (his picture and his path are this machine's);
//  3. no page error, no file write on either host.
//
// Real: the fixture server, its Org routes and threads file, the session record of the remote
// session, the Org page, the renderer, the openers and every React handler. Mocked at the host
// boundary only (page.route): the remote host's file answers (`/api/files/*`, `/api/file-content`,
// `/api/local-image` with that host), because the host fixture serves no file bytes. The same
// absolute path on this machine holds different bytes, so a wrong pick shows the primary's copy.
// The answers Walnut reads from a chat are proven on a real transcript in
// tests/e2e/org-thread-text-source.test.ts; here the conversation's answers are seeded in the
// threads file in the shape the server keeps.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { AGENT_TEXT_BASE as base, click, closeFile, openApp, showPointer } from './agent-text-entry-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs } from './todo-panel-helpers'

const REMOTE = 'fixture-remote'
const REMOTE_SID = 'pw-limits-remote-session'
const UNPLACED_SID = 'pw-thread-source-no-such-session'
const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Thread sources ${stamp}`
const PRIMARY_TEXT = 'Primary copy\nPrimary line two\nPrimary line three\n'
const REMOTE_TEXT = 'Remote copy\nRemote line two from fixture-remote\nRemote line three\n'
const asset = (name: string) => fileURLToPath(new URL(`../../../web/public/${name}`, import.meta.url))
const pngWidth = (png: Buffer) => png.readUInt32BE(16)
const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

let dir = '', doc = '', picture = '', threadsFile = ''
let remotePng = Buffer.alloc(0)
let remoteWidth = 0
let primaryWidth = 0
const ids = { lead: '', summary: '', talk: 'th-5a17ce0de001' }
const made: string[] = []

test.describe.configure({ mode: 'default' })
test.setTimeout(180_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: { mode: 'on', size: { width: 1280, height: 900 } } })

async function ok(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string): Promise<any> {
  const text = await res.text()
  expect(res.ok(), `${what}: ${res.status()} ${text}`).toBe(true)
  return text ? JSON.parse(text) : null
}

async function thread(request: APIRequestContext, id: string): Promise<Record<string, any>> {
  const { threads } = await ok(await request.get(`/api/v1/tasks/${ids.lead}/threads`), 'threads')
  return (threads as Array<Record<string, any>>).find((t) => t.id === id)!
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  if (new URL(base).port === '3456') throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const { fixtureRoot, walnutHome } = await discoverBrowserFixture(Number(new URL(base).port))
  dir = path.join(fixtureRoot, 'projects', 'walnut', `thread-source-${stamp}`)
  doc = path.join(dir, 'notes.txt')
  picture = path.join(dir, 'design.png')
  remotePng = await fs.readFile(asset('icon-192.png'))
  remoteWidth = pngWidth(remotePng)
  const primaryPng = await fs.readFile(asset('icon-512.png'))
  primaryWidth = pngWidth(primaryPng)
  expect(primaryWidth).not.toBe(remoteWidth)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(doc, PRIMARY_TEXT)
  await fs.writeFile(picture, primaryPng)

  const record = await ok(await request.get(`/api/sessions/${REMOTE_SID}`), 'session record')
  expect(record.session.host, 'the fixture session runs on the remote host').toBe(REMOTE)

  // A lead needs a project of two tasks.
  for (const title of [`Notes ${stamp}`, `Design ${stamp}`]) {
    made.push((await ok(await request.post('/api/tasks', { data: { title, project: PROJECT, source: 'local' } }), 'task')).task.id)
  }
  ids.lead = (await ok(await request.post('/api/v1/org/contact', { data: { to: PROJECT } }), 'lead')).task.id
  made.push(ids.lead)

  // The conversation, in the shape the server keeps: one answer read from the remote session, one
  // kept before writers were recorded; his own words name the same path and picture.
  const t0 = Date.now() - 10 * 60_000
  const at = (s: number) => new Date(t0 + s * 1000).toISOString()
  threadsFile = path.join(walnutHome, 'org', 'threads', `${ids.lead}.json`)
  await fs.mkdir(path.dirname(threadsFile), { recursive: true })
  await fs.writeFile(threadsFile, JSON.stringify({
    version: 1, taskId: ids.lead, threads: [{
      id: ids.talk, title: `Where things are ${stamp}`, titled: true, state: 'answered', createdAt: at(0), updatedAt: at(90),
      messages: [
        {
          id: 'tm-5a17ce0de001', at: at(0), via: 'chat', text: `Mine are at ${doc}:1`, images: [picture],
          answer: { at: at(30), text: `Remote notes: ${doc}:2\n\n${picture}`, sid: REMOTE_SID, host: REMOTE },
        },
        { id: 'tm-5a17ce0de002', at: at(60), via: 'chat', text: 'and the older copy?', answer: { at: at(90), text: `Older notes: ${doc}:3\n\n${picture}` } },
      ],
    }],
  }))

  // The summary, through the route the node's thread_update op calls: the remote session writes it
  // (a writer forged in the body is not read), the user pins it, an unplaced caller repeats it.
  ids.summary = (await ok(await request.post(`/api/v1/tasks/${ids.lead}/threads`, { data: { text: `Summary of the notes ${stamp}` } }), 'file ask')).thread.id
  await ok(await request.patch(`/api/v1/tasks/${ids.lead}/threads/${ids.summary}`, {
    headers: { 'x-walnut-caller-sid': REMOTE_SID },
    data: { title: `Notes summary ${stamp}`, state: 'answered', reply: `Summary: ${doc}:2`, reply_sid: 'forged', reply_host: 'local', sid: 'forged', host: 'local', by: 'human' },
  }), 'remote summary')
  await ok(await request.patch(`/api/v1/tasks/${ids.lead}/threads/${ids.summary}`, { data: { pin: true } }), 'pin')
  await ok(await request.patch(`/api/v1/tasks/${ids.lead}/threads/${ids.summary}`, {
    headers: { 'x-walnut-caller-sid': UNPLACED_SID }, data: { state: 'answered', reply: `Summary: ${doc}:2` },
  }), 'same words again')
  const stored = await thread(request, ids.summary)
  expect(stored).toMatchObject({ reply: `Summary: ${doc}:2`, reply_sid: REMOTE_SID, reply_host: REMOTE })
  // The remote session's own writer (its task, or an agent with no task), never the body's `human`.
  expect(stored.reply_by).not.toBe('human')
  expect(stored.pinned).toBeTruthy()
  const talk = await thread(request, ids.talk)
  expect(talk.messages[0].answer).toMatchObject({ sid: REMOTE_SID, host: REMOTE })
  expect(talk.messages[1].answer.sid).toBeUndefined()
  await ok(await request.put(`/api/v1/tasks/${ids.lead}/brief`, {
    headers: { 'x-walnut-caller-sid': UNPLACED_SID },
    data: { content: `### Needs you\n\nNone.\n\n### Working\n\n<a class="file-link" data-rel-path="src/notes.ts" data-cwd="${dir}" data-file-line="2" data-file-end-line="3">Relative notes</a>\n\n### Waiting / snoozed\n\nNone.` },
  }), 'unknown writer brief')
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (threadsFile) await fs.rm(threadsFile, { force: true })
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

// ── The remote host's answers, and what the page asked ──

const FILE_API = /^\/api\/(?:file-content$|file-raw\/|local-image$|files\/(?:locate|list|list-many|exists)$)/
const LOCAL = new Set(['', 'local', '__local__'])
type Touch = { api: string; host: string; path: string; method: string }

function touchOf(req: Request): Touch | null {
  const url = new URL(req.url())
  const api = url.pathname
  if (!FILE_API.test(api)) return null
  if (api.startsWith('/api/file-raw/')) {
    const [, , , host, ...rest] = api.split('/')
    return { api: 'file-raw', host: decodeURIComponent(host!), path: '/' + rest.map(decodeURIComponent).join('/'), method: req.method() }
  }
  let body: { paths?: string[]; host?: string } = {}
  if (req.method() === 'POST') { try { body = req.postDataJSON() ?? {} } catch { /* not JSON */ } }
  const q = url.searchParams
  const target = q.get('ref') ?? q.get('path') ?? body.paths?.find((p) => p === doc || p === picture || p === dir) ?? ''
  return { api: api.replace('/api/', ''), host: q.get('host') ?? body.host ?? 'local', path: target, method: req.method() }
}

const ours = (t: Touch) => t.path === doc || t.path === picture || t.path === dir

function listing(p: string) {
  const files = [doc, picture]
  const entries = (d: string) => files.filter((f) => path.dirname(f) === d).map((f) => ({ name: path.basename(f), type: 'file', size: f === doc ? Buffer.byteLength(REMOTE_TEXT) : remotePng.length }))
  if (files.includes(p)) return { path: path.dirname(p), entries: entries(path.dirname(p)), selectedFile: path.basename(p) }
  return { path: p, entries: entries(p) }
}

/** The remote host, as its server routes answer for it; this machine's requests pass through. */
async function remoteHost(route: Route, writes: string[]): Promise<void> {
  const t = touchOf(route.request())
  if (!t || t.host !== REMOTE) return route.fallback()
  const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const p = t.path
  if (t.method !== 'GET' && t.api !== 'files/list-many' && t.api !== 'files/exists') {
    writes.push(`${t.method} ${t.api} ${p}`)
    return json({ error: 'the remote stand-in takes no writes', code: 'host_reconnecting' }, 503)
  }
  switch (t.api) {
    case 'files/locate': {
      const found = p === doc || p === picture
      return json(found ? { path: p, host: REMOTE, hostName: 'Big remote host', found: true } : { path: p, host: REMOTE, found: false, missing: true, checked: ['Big remote host'] })
    }
    case 'files/list': return json(listing(p))
    case 'files/list-many': {
      const paths = (route.request().postDataJSON()?.paths ?? []) as string[]
      return json({ listings: paths.map(listing), truncated: false, timedOut: false })
    }
    case 'files/exists': {
      const paths = (route.request().postDataJSON()?.paths ?? []) as string[]
      return json({ exists: Object.fromEntries(paths.map((x) => [x, x === doc || x === picture])) })
    }
    case 'file-content':
      if (p !== doc) return json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: path.extname(p).slice(1) })
      return json({ content: REMOTE_TEXT, size: Buffer.byteLength(REMOTE_TEXT), truncated: false, binary: false, extension: 'txt', contentHash: createHash('sha256').update(REMOTE_TEXT).digest('hex') })
    case 'file-raw':
    case 'local-image':
      return p === picture ? route.fulfill({ status: 200, contentType: 'image/png', body: remotePng }) : json({ error: 'not found' }, 404)
    default: return route.fallback()
  }
}

interface Net {
  /** File requests for the seeded paths, either host, since the page opened. */
  files(): string[]
  /** The same, on this machine, less inline pictures: what a press opened or looked up here. */
  opens(): string[]
  lookups(): number
  writes: string[]
  errors: string[]
}

async function watchNet(page: Page): Promise<Net> {
  const seen: Request[] = []
  const writes: string[] = []
  const errors: string[] = []
  page.on('request', (r) => seen.push(r))
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route((url) => FILE_API.test(url.pathname), (route) => remoteHost(route, writes))
  const touches = () => seen.map(touchOf).filter((t): t is Touch => !!t && ours(t))
  const line = (t: Touch) => `${t.method} ${t.api} host=${t.host} ${t.path}`
  return {
    writes, errors,
    files: () => touches().map(line),
    opens: () => touches().filter((t) => LOCAL.has(t.host) && t.api !== 'local-image').map(line),
    lookups: () => seen.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`).length,
  }
}

let net: Net

test.beforeEach(async ({ page }) => {
  await showPointer(page)
  await isolateUiPrefs(page)
  net = await watchNet(page)
})

test.afterEach(async () => {
  expect(net.writes, 'no file write reached either host').toEqual([])
  expect(net.files().filter((f) => !f.startsWith('GET') && !f.startsWith('POST files/list-many') && !f.startsWith('POST files/exists')), 'no write to the seeded files').toEqual([])
  expect(net.errors, 'no page error').toEqual([])
})

// ── Steps ──

async function openThreads(page: Page): Promise<Locator> {
  await openApp(page)
  await click(page, page.getByTestId('sidebar-org'))
  await expect(page.getByTestId('org-page')).toBeVisible()
  await click(page, page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`))
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  const top = detail.getByTestId('org-top')
  if ((await top.getAttribute('data-view')) !== 'threads') await click(page, detail.getByTestId('org-top-threads'))
  await expect(top).toHaveAttribute('data-view', 'threads')
  return detail.getByTestId('org-threads')
}

const card = (scope: Locator, id: string) => scope.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
const docIn = (scope: Locator) => scope.locator(`a.file-link[data-file-path="${doc}"]`).first()
const pictureLink = (scope: Locator) => scope.locator(`a.file-link[data-file-path="${picture}"]`)
const imageIn = (scope: Locator) => scope.locator('img[src*="/api/local-image"]').first()

async function expectViewerText(page: Page, words: string, not: string): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText(words, { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText(not)
}

async function loadedWidth(image: Locator): Promise<number> {
  await expect(image).toBeVisible({ timeout: 30_000 })
  let width = 0
  await expect.poll(async () => (width = await image.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0))), { timeout: 30_000 }).toBeGreaterThan(0)
  return width
}

/** Two frames and a pause: long enough for a late answer to open a viewer if it were going to. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 800)))))
}

// ── Tests ──

test('an unknown Brief relative link reads no file or session before the source is chosen', async ({ page }) => {
  await openThreads(page)
  await click(page, page.getByTestId('org-top-brief'))
  const link = page.getByTestId('org-brief-body').locator('a.file-link').filter({ hasText: 'Relative notes' })
  await expect(link).toHaveAttribute('data-rel-path', 'src/notes.ts')
  const chatSid = await page.getByTestId('org-detail').locator('.session-panel[data-session-id]').getAttribute('data-session-id')
  expect(chatSid).toBeTruthy()
  // The mounted chat reads its own record and whatever else its panel shows (history, supervision,
  // slash commands, permission decisions, a new panel read in time): any GET under its own id.
  // A read of another session, and every file route, is still caught below.
  const ownChat = (pathname: string) => pathname === `/api/sessions/${chatSid}` || pathname.startsWith(`/api/sessions/${chatSid}/`)
  const reads: string[] = []
  page.on('request', (req) => {
    const url = new URL(req.url())
    if (FILE_API.test(url.pathname)) reads.push(req.url())
    if (!url.pathname.startsWith('/api/sessions/')) return
    // The page polls its session lists on its own clock (status and git batches, model catalogs): those name no
    // writer. A read of one other session's record or history, which is what a guess would make, is caught.
    const list = ['status', 'git-status', 'host-model-catalogs', 'working-dirs'].includes(url.pathname.split('/')[3] ?? '')
    if (req.method() !== 'GET' || (!ownChat(url.pathname) && !list)) reads.push(req.url())
  })
  await click(page, link)
  await expect(page.getByTestId('file-viewer-source-error')).toContainText('No file was read')
  await expect(page.locator('.file-viewer-line')).toHaveText(':2')
  await settle(page)
  expect(reads, 'no writer or path was guessed').toEqual([])
  await closeFile(page)
})

test('a summary the remote session wrote opens on its host on the first press, after a pin and a repeat by other callers', async ({ page }) => {
  const list = await openThreads(page)
  const summary = card(list, ids.summary).getByTestId('org-thread-reply')
  await expect(summary).toContainText('Summary:')
  await click(page, docIn(summary))
  await expectViewerText(page, 'Remote line two from fixture-remote', 'Primary')
  await expect(page.locator('.file-viewer-overlay .file-viewer-host')).toContainText('SSH:')
  await closeFile(page)
  // The host was recorded with the words: no session read, nothing read on this machine.
  expect(net.lookups()).toBe(0)
  expect(net.opens()).toEqual([])
  expect(net.files().some((f) => f.includes(`file-content host=${REMOTE} ${doc}`))).toBe(true)
})

test('in one conversation each block opens from its own writer: the remote answer there, the unrecorded one nowhere, his words here', async ({ page }) => {
  const list = await openThreads(page)
  const talk = card(list, ids.talk)
  await expect(talk).toBeVisible({ timeout: 20_000 })
  await click(page, talk.getByTestId('org-thread-history'))
  const answers = talk.getByTestId('org-thread-messages').getByTestId('org-thread-answer')
  await expect(answers).toHaveCount(2)
  const remote = answers.nth(0)
  const unrecorded = answers.nth(1)
  const words = talk.getByTestId('org-thread-message').nth(0).getByTestId('org-thread-words')
  await expect(remote).toHaveAttribute('data-text-source', 'host')
  await expect(unrecorded).toHaveAttribute('data-text-source', 'unknown')

  // Pictures: the remote answer's from its host, his own from here, the unrecorded one's from nowhere.
  const remoteImage = imageIn(remote)
  await expect(remoteImage).toHaveAttribute('src', new RegExp(`host=${REMOTE}`))
  expect(await loadedWidth(remoteImage)).toBe(remoteWidth)
  const myImage = imageIn(words)
  await expect(myImage).not.toHaveAttribute('src', /host=/)
  expect(await loadedWidth(myImage)).toBe(primaryWidth)
  await expect(unrecorded.locator('img')).toHaveCount(0)
  await expect(pictureLink(unrecorded)).toHaveCount(1)
  if (process.env.AGENT_TEXT_SHOTS) await talk.screenshot({ path: `${process.env.AGENT_TEXT_SHOTS}/thread-sources.png` })

  // The remote answer's path: the remote copy, on the first press.
  await click(page, docIn(remote))
  await expectViewerText(page, 'Remote line two from fixture-remote', 'Primary')
  await closeFile(page)
  expect(net.opens(), 'the remote answer read nothing here').toEqual([])

  // The unrecorded answer's path: nothing read on either host, and the viewer says why.
  const before = net.files().length
  await click(page, docIn(unrecorded))
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer).toContainText('did not record which session wrote these words', { timeout: 20_000 })
  await settle(page)
  expect(net.files().slice(before), 'no machine was guessed').toEqual([])
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // His own words with the same path: this machine's copy.
  await click(page, docIn(words))
  await expectViewerText(page, 'Primary line two', 'Remote')
  await closeFile(page)
  expect(net.lookups(), 'no block needed a session read').toBe(0)
})
