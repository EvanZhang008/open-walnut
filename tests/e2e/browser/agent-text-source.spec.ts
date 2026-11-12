// A path in agent words opens on the machine that wrote them, on the first press: a letter whose
// sender host is known, and a reply another task wrote in the user's place (only its session id).
//
// Real: the fixture server, its letters, thread turns and the session record of
// `pw-limits-remote-session` (host `fixture-remote`), the inbox UI, the renderer, the opener and
// every React handler. Mocked at the host boundary only (page.route): the remote host's file
// answers (`/api/files/locate|list|list-many|exists`, `/api/file-content`, `/api/file-raw`,
// `/api/local-image` with that host), because the host fixture lists folders but serves no
// file bytes; and the timing of the real session read (held, or failed with a 503) where a
// test says so. The same absolute path on this machine holds different bytes, so a wrong
// pick shows the primary's copy.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page, type Request, type Route } from '@playwright/test'
import {
  AGENT_TEXT_BASE as base, click, closeFile, closeLetter, openApp, openDraftOnCwd, openSessionBoard, showCustomBoard, showPointer,
} from './agent-text-entry-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { REAL_PANEL, draftComposer, leaveFullscreen } from './draft-helpers'

const REMOTE = 'fixture-remote'
const REMOTE_SID = 'pw-limits-remote-session'
const stamp = Date.now().toString(36)
const subjects = {
  host: `Remote notes ${stamp}`,
  picture: `Remote picture ${stamp}`,
  peer: `Answered elsewhere ${stamp}`,
  other: `Other letter ${stamp}`,
}
const PRIMARY_TEXT = 'Primary copy\nPrimary line two\nPrimary line three\n'
const REMOTE_TEXT = 'Remote copy\nRemote line two from fixture-remote\nRemote line three\n'
const asset = (name: string) => fileURLToPath(new URL(`../../../web/public/${name}`, import.meta.url))
const pngWidth = (png: Buffer) => png.readUInt32BE(16)

let dir = '', doc = '', picture = ''
let remotePng = Buffer.alloc(0)
let remoteWidth = 0
const notesRef = (line?: number) => {
  const ref = `${doc}${line ? `:${line}` : ''}`
  return `[${ref}](<${ref}>)`
}
const notesHtml = (line?: number) => {
  const ref = `${doc}${line ? `:${line}` : ''}`
  return `<a href="${ref}">Source notes</a>`
}
let otherLetter = ''
const letters: string[] = []

test.describe.configure({ mode: 'default' })
test.setTimeout(180_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: 'on' })

async function ok(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string): Promise<any> {
  const text = await res.text()
  expect(res.ok(), `${what}: ${res.status()} ${text}`).toBe(true)
  return text ? JSON.parse(text) : null
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000)
  if (new URL(base).port === '3456') throw new Error('These checks write letters: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(Number(new URL(base).port))
  dir = path.join(fixtureRoot, 'projects', 'walnut', `agent-source-${stamp}`)
  doc = path.join(dir, 'Plan notes.txt')
  picture = path.join(dir, 'design.png')
  // The remote picture: a real one when the run names it, else the repo's 192px icon. The
  // primary's is a different size, so the viewer's pixels say which machine answered.
  remotePng = await fs.readFile(process.env.AGENT_TEXT_PATH || asset('icon-192.png'))
  remoteWidth = pngWidth(remotePng)
  const primaryPng = await fs.readFile(asset(remoteWidth === 512 ? 'apple-touch-icon.png' : 'icon-512.png'))
  expect(pngWidth(primaryPng)).not.toBe(remoteWidth)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(doc, PRIMARY_TEXT)
  await fs.writeFile(picture, primaryPng)

  // The real record the source names: a session on the remote host.
  const record = await ok(await request.get(`/api/sessions/${REMOTE_SID}`), 'session record')
  expect(record.session.host, 'the fixture session runs on the remote host').toBe(REMOTE)
  const asRemote = { 'x-walnut-caller-sid': REMOTE_SID }

  const send = async (headers: Record<string, string>, data: Record<string, unknown>) =>
    (await ok(await request.post('/api/v1/human-inbox', { headers, data: { type: 'info', user_asked: true, ...data } }), `letter ${data.subject}`)).id as string
  // Sent by the remote session: the server stamps its host on the envelope.
  const hostLetter = await send(asRemote, { subject: subjects.host, text: `[Source notes](<${doc}:2>)`, markdown: `Notes: ${notesRef(2)}` })
  // The raw <img> names this machine (`host=local`) in its own URL: it must still draw from the
  // letter's writer, whose copy is a different size.
  const rawPicture = `<img class="raw-local-picture" alt="Raw design" src="/api/local-image?path=${encodeURIComponent(picture)}&amp;host=local"><img class="raw-v1-picture" alt="Raw v1 design" src="/api/v1/file-raw/local${picture}"><img class="raw-alias-picture" alt="Raw alias design" src="http://127.0.0.1:3457/api/local-image?path=${encodeURIComponent(picture)}&amp;host=local"><svg><use href="/api/file-history/version?path=${encodeURIComponent(picture)}&amp;host=local&amp;id=fixture"/></svg>`
  const pictureLetter = await send(asRemote, { subject: subjects.picture, text: 'A design picture from the remote host.', markdown: `Design:\n\n${picture}\n\n${rawPicture}` })
  // Sent by no session: its own host is this machine.
  otherLetter = await send({}, { subject: subjects.other, text: 'Nothing to open here.', markdown: 'Nothing to open here.' })
  const peerLetter = await send({}, { subject: subjects.peer, text: 'A local letter another task answered.', markdown: `The other letter: ${otherLetter}` })
  letters.push(hostLetter, pictureLetter, otherLetter, peerLetter)
  for (const id of [hostLetter, pictureLetter]) {
    const { letter } = await ok(await request.get(`/api/v1/human-inbox/${id}`), 'read letter')
    expect(letter.sender).toMatchObject({ sessionId: REMOTE_SID, host: REMOTE })
  }
  // Three turns the remote session's task wrote in the user's place.
  const replies = [`Notes are in ${notesRef(2)}`, `Design is ${picture}`, `Same notes again: ${notesRef()}`]
  for (const [i, text] of replies.entries()) {
    await ok(await request.post(`/api/v1/human-inbox/${peerLetter}/human-reply`, {
      headers: asRemote, data: { text, clientId: `source-${stamp}-${i}`, user_words: 'Answer it with the notes path' },
    }), `reply ${i}`)
  }
  const { letter } = await ok(await request.get(`/api/v1/human-inbox/${peerLetter}`), 'read answered letter')
  expect(letter.sender.sessionId).toBe('external')
  const turns = (letter.thread as Array<Record<string, any>>).filter((t) => t.from === 'human')
  expect(turns).toHaveLength(3)
  for (const turn of turns) {
    // The turn names its session and nothing of a host: the host comes from the session record.
    expect(turn.by?.sessionId).toBe(REMOTE_SID)
    expect(turn).not.toHaveProperty('host')
    expect(turn.by).not.toHaveProperty('host')
  }
})

test.afterAll(async ({ request }) => {
  for (const id of letters) await request.delete(`/api/v1/human-inbox/${id}`).catch(() => {})
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

// ── The remote host's answers, the session read's timing, and what the page asked ──

type Touch = { api: string; host: string; path: string; method: string }

class Gate {
  mode: 'pass' | 'down' | 'hold' = 'pass'
  private waiting: Array<() => void> = []
  get held(): number { return this.waiting.length }
  wait(): Promise<void> { return new Promise((resolve) => this.waiting.push(resolve)) }
  release(): void { this.mode = 'pass'; for (const go of this.waiting.splice(0)) go() }
}

const FILE_API = /^\/api\/(?:file-content$|(?:v1\/)?file-raw\/|local-image$|file-history(?:\/|$)|(?:v1\/)?files\/(?:locate|list|list-many|exists)$)/
const LOCAL = new Set(['', 'local', '__local__'])

function touchOf(req: Request): Touch | null {
  const url = new URL(req.url())
  const api = url.pathname
  if (!FILE_API.test(api)) return null
  if (/^\/api\/(?:v1\/)?file-raw\//.test(api)) {
    const index = api.startsWith('/api/v1/') ? 4 : 3
    const [host, ...rest] = api.split('/').slice(index)
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
  gate: Gate
  reset(): void
  /** GETs of the remote session's record since the page opened. */
  lookups(): number
  /** File reads of the seeded paths on this machine (each would show the primary's bytes). */
  primary(): string[]
  /** The same, less inline pictures (`local-image`): what a press opened or looked up here. */
  opens(): string[]
  /** Every file request for the seeded paths, either host. */
  files(): string[]
  remote(): string[]
  writes: string[]
  errors: string[]
}

async function watchNet(page: Page): Promise<Net> {
  const gate = new Gate()
  const seen: Request[] = []
  const writes: string[] = []
  const errors: string[] = []
  page.on('request', (r) => seen.push(r))
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route((url) => FILE_API.test(url.pathname), (route) => remoteHost(route, writes))
  await page.route((url) => url.pathname === `/api/sessions/${REMOTE_SID}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (gate.mode === 'down') {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'the session store is not answering' } }) })
    }
    if (gate.mode === 'hold') await gate.wait()
    return route.fallback()
  })
  const touches = () => seen.map(touchOf).filter((t): t is Touch => !!t && ours(t))
  const line = (t: Touch) => `${t.method} ${t.api} host=${t.host} ${t.path}`
  return {
    gate, writes, errors,
    reset: () => { seen.length = 0 },
    lookups: () => seen.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`).length,
    primary: () => touches().filter((t) => LOCAL.has(t.host)).map(line),
    opens: () => touches().filter((t) => LOCAL.has(t.host) && t.api !== 'local-image').map(line),
    files: () => touches().map(line),
    remote: () => touches().filter((t) => t.host === REMOTE).map(line),
  }
}

let net: Net

test.beforeEach(async ({ page }) => {
  await showPointer(page)
  await isolateUiPrefs(page)
  net = await watchNet(page)
})

test.afterEach(async () => {
  net.gate.release()
  expect(net.writes, 'no file write reached either host').toEqual([])
  expect(net.files().filter((f) => !f.startsWith('GET') && !f.startsWith('POST files/list-many') && !f.startsWith('POST files/exists')), 'no write to the seeded files').toEqual([])
  expect(net.errors, 'no page error').toEqual([])
})

// ── Steps ──

async function openInbox(page: Page): Promise<Locator> {
  await click(page, page.getByRole('button', { name: 'Notifications', exact: true }))
  const center = page.locator('.notification-panel')
  await click(page, center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }))
  return center
}

async function openLetter(page: Page, center: Locator, subject: string): Promise<Locator> {
  const row = center.locator('.hib-row').filter({ hasText: subject })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await click(page, row.locator('.hib-subject'))
  const reader = page.locator('.hib-reader')
  await expect(reader).toContainText(subject, { timeout: 20_000 })
  return reader
}

/** The three turns the other task wrote, drawn with their links and no picture. */
async function peerTurns(reader: Locator): Promise<Locator> {
  const turns = reader.locator('.hib-turn--human')
  await expect(turns).toHaveCount(3, { timeout: 20_000 })
  await expect(turns.locator('[data-agent-text] a.file-link')).toHaveCount(3)
  return turns
}

const docIn = (scope: Locator) => scope.locator(`a.file-link[data-file-path="${doc}"]`).first()
const pictureIn = (scope: Locator) => scope.locator(`a.file-link[data-file-path="${picture}"]`).first()

async function expectRemoteText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Remote line two from fixture-remote', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Primary')
  await expect(viewer.locator('.file-viewer-host')).toContainText('SSH:')
}

async function expectRemotePicture(page: Page): Promise<void> {
  const image = page.locator('.file-viewer-overlay img[src*="/api/file-raw/"]').first()
  await expect(image).toBeVisible({ timeout: 30_000 })
  await expect(image).toHaveAttribute('src', new RegExp(`^/api/file-raw/${REMOTE}/`))
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 30_000 }).toBe(remoteWidth)
}

/** Two frames and a pause: long enough for a late answer to open a viewer if it were going to. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 800)))))
}

// ── Tests ──

test('a letter from a known remote host opens its path there on the first press, from the inbox row and the letter', async ({ page }) => {
  await openApp(page)
  const center = await openInbox(page)
  const row = center.locator('.hib-row').filter({ hasText: subjects.host })
  await expect(row).toBeVisible({ timeout: 20_000 })
  const preview = row.locator('.hib-preview')
  await expect(preview).toHaveAttribute('data-agent-text', 'true')
  // The bounded envelope has one complete destination, not a truncated Markdown link.
  await expect(docIn(preview)).toHaveText('Source notes')
  expect(await preview.evaluate((el) => {
    const clip = el.getBoundingClientRect()
    const notes = el.querySelector('a.file-link')!.getClientRects()[0]!
    return notes.top >= clip.top && notes.bottom <= clip.bottom
  }), 'the notes link stays inside the two shown lines').toBe(true)
  await click(page, docIn(preview))
  await expectRemoteText(page)
  await expect(page.locator('.hib-reader')).toHaveCount(0)
  await closeFile(page)

  const reader = await openLetter(page, center, subjects.host)
  await click(page, docIn(reader))
  await expectRemoteText(page)
  await closeFile(page)
  await expect(reader).toBeVisible()

  // The host was known: no session was read for it, and nothing was read on this machine.
  expect(net.lookups()).toBe(0)
  expect(net.primary()).toEqual([])
  expect(net.remote().some((f) => f.includes(`file-content host=${REMOTE} ${doc}`))).toBe(true)
})

test('a source file its writer\'s machine lacks opens from the machine that has it, marked as there; one no machine has says so; the next press recovers', async ({ page }) => {
  // A lead relays a worker's evidence path: the writer's machine is asked first, never alone
  // (2026-11-11 on production: a VP's card read "Couldn't find … on Local" for a video on another Mac).
  await openApp(page)
  const center = await openInbox(page)
  const reader = await openLetter(page, center, subjects.host)
  const asked: URL[] = []
  for (const elsewhere of [false, true]) {
    const response = async (route: Route) => {
      asked.push(new URL(route.request().url()))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        elsewhere ? { path: doc, found: true, elsewhere: true } : { path: doc, host: REMOTE, found: false, missing: true, checked: ['Big remote host', 'Local'] },
      ) })
    }
    const match = (url: URL) => url.pathname === '/api/files/locate' && url.searchParams.get('ref') === doc
    await page.route(match, response)
    const before = net.files().length
    try {
      await click(page, docIn(reader))
      if (elsewhere) {
        // The writer's machine lacks it and this machine has a file there: that file opens, marked as this machine's.
        await expectPrimaryText(page)
        await expect(page.locator('.file-viewer-overlay').getByTestId('sfe-host-chip')).toBeVisible()
      } else {
        await expect(page.getByTestId('file-viewer-missing')).toContainText('Couldn\'t find')
        expect(net.files().slice(before).filter((f) => !f.includes('files/locate'))).toEqual([])
      }
      await closeFile(page)
      await expect(reader).toBeVisible()
    } finally { await page.unroute(match, response) }
  }
  expect(asked.length).toBeGreaterThanOrEqual(2)
  for (const url of asked) {
    expect(url.searchParams.get('host'), 'the writer\'s machine is asked first').toBe(REMOTE)
    expect(url.searchParams.get('sourceOnly'), 'never that machine alone').toBeNull()
  }
  await click(page, docIn(reader))
  await expectRemoteText(page)
  await closeFile(page)
})

test('a reply another task wrote opens on its session\'s host on the first press; drawing the turns reads no session', async ({ page }) => {
  await openApp(page)
  const center = await openInbox(page)
  const reader = await openLetter(page, center, subjects.peer)
  const turns = await peerTurns(reader)
  // Unknown host while drawn: the picture stays a link, so nothing loads from this machine.
  await expect(turns.locator('img')).toHaveCount(0)
  await settle(page)
  expect(net.lookups(), 'mounting three turns read no session').toBe(0)
  expect(net.files()).toEqual([])

  await click(page, docIn(turns.nth(0)))
  await expectRemoteText(page)
  expect(net.lookups(), 'the press read the record once').toBe(1)
  await closeFile(page)

  await click(page, pictureIn(turns.nth(1)))
  await expectRemotePicture(page)
  await closeFile(page)
  await click(page, docIn(turns.nth(2)))
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.lookups(), 'later presses use the record the first one read').toBe(1)
  // Once the record is known a redraw may show the picture inline; where it loads from is the last test's.
  expect(net.opens()).toEqual([])
})

test('a session read that fails reads no file on any host and shows why; after closing, the next press opens the session\'s host', async ({ page }) => {
  await openApp(page)
  const center = await openInbox(page)
  const reader = await openLetter(page, center, subjects.peer)
  const turns = await peerTurns(reader)
  net.gate.mode = 'down'
  await click(page, docIn(turns.nth(0)))
  const failure = page.getByTestId('file-viewer-source-error')
  await expect(failure).toBeVisible({ timeout: 20_000 })
  await expect(failure).toContainText("Couldn't open the path")
  await expect(failure).toContainText('No file was read')
  await expect.poll(() => failure.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + 20, r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  })).toBe(true)
  await settle(page)
  expect(net.lookups()).toBe(1)
  expect(net.files(), 'nothing was looked up or read on either host').toEqual([])
  if (process.env.AGENT_TEXT_SHOTS) await page.screenshot({ path: `${process.env.AGENT_TEXT_SHOTS}/source-unavailable.png` })
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await expect(reader).toBeVisible()

  // The read answers again; closing the error and pressing its original link retries.
  net.gate.mode = 'pass'
  await click(page, docIn(turns.nth(0)))
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.lookups()).toBe(2)
  expect(net.opens()).toEqual([])
})

test('a session read that answers after the letter closed opens nothing; the next press opens at once', async ({ page }) => {
  await openApp(page)
  let center = await openInbox(page)
  let reader = await openLetter(page, center, subjects.peer)
  let turns = await peerTurns(reader)
  net.gate.mode = 'hold'
  await click(page, docIn(turns.nth(0)))
  await expect.poll(() => net.gate.held, { timeout: 20_000 }).toBe(1)
  await closeLetter(page)
  await expect(page.locator('.hib-reader')).toHaveCount(0)

  const late = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`)
  net.gate.release()
  const answer = await late
  expect(answer.ok()).toBe(true)
  expect((await answer.json()).session.host).toBe(REMOTE)
  await settle(page)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  expect(net.files(), 'the late answer opened nothing').toEqual([])

  // That answer is the page's record now: the next press opens on the remote host with no read.
  center = await openInbox(page)
  reader = await openLetter(page, center, subjects.peer)
  turns = await peerTurns(reader)
  await click(page, docIn(turns.nth(0)))
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.lookups()).toBe(1)
  // Known now, the turn may draw its picture inline: where that loads from is the last test's.
  expect(net.opens()).toEqual([])
})

test('a session read that answers after the reader moved to another letter opens nothing there', async ({ page }) => {
  await openApp(page)
  const center = await openInbox(page)
  const reader = await openLetter(page, center, subjects.peer)
  const turns = await peerTurns(reader)
  net.gate.mode = 'hold'
  await click(page, docIn(turns.nth(0)))
  await expect.poll(() => net.gate.held, { timeout: 20_000 }).toBe(1)
  // The letter's body names another letter: the reader moves to it while the read is out.
  await click(page, reader.locator(`a.letter-link[data-letter-id="${otherLetter}"]`).first())
  await expect(page.locator('.hib-reader')).toContainText(subjects.other, { timeout: 20_000 })
  await expect(page.locator('.hib-reader .hib-turn--human')).toHaveCount(0)

  const late = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`)
  net.gate.release()
  expect((await late).ok()).toBe(true)
  await settle(page)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await expect(page.locator('.hib-reader')).toContainText(subjects.other)
  expect(net.files(), 'the late answer opened nothing').toEqual([])
  expect(net.lookups()).toBe(1)
})

// A known source applies to both the inline picture and the caption's viewer.
test('a known remote host letter draws its inline picture from that host, a raw picture naming this machine too, and its caption opens there', async ({ page }) => {
  await openApp(page)
  const center = await openInbox(page)
  const reader = await openLetter(page, center, subjects.picture)
  const inline = reader.locator('img.inline-image').first()
  await expect(inline).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => inline.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 30_000 }).toBe(remoteWidth)
  const raw = reader.locator('img.raw-local-picture')
  await expect(raw).toHaveCount(1)
  await expect.poll(() => raw.evaluate((el: HTMLImageElement) => new URL(el.currentSrc || el.src).searchParams.getAll('host'))).toEqual([REMOTE])
  await expect.poll(() => raw.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 30_000 }).toBe(remoteWidth)
  const v1 = reader.locator('img.raw-v1-picture')
  await expect(v1).toHaveAttribute('src', `/api/v1/file-raw/${REMOTE}${picture}`)
  await expect.poll(() => v1.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 30_000 }).toBe(remoteWidth)
  const alias = reader.locator('img.raw-alias-picture')
  await expect(alias).toHaveAttribute('src', `/api/local-image?path=${encodeURIComponent(picture)}&host=${REMOTE}`)
  await expect.poll(() => alias.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)), { timeout: 30_000 }).toBe(remoteWidth)
  await expect(reader.locator('svg use[href]')).toHaveCount(0)
  await click(page, reader.locator(`a.inline-image-path.file-link[data-file-path="${picture}"]`).first())
  await expectRemotePicture(page)
  await closeFile(page)
  expect(net.lookups()).toBe(0)
  expect(net.primary()).toEqual([])
})

// ── The Board (TaskBoardPane.tsx): the page and each post open on the machine that wrote them ──
//
// Real: a leader task with a mock-CLI session on this machine (its Board's owner), the board
// routes, the frame and its runtime, and `pw-limits-remote-session` posting and writing the page
// as a caller (the server stores that session on the post and the page version, never a body
// field). Mocked: only the remote host's file answers and the session read's timing, as above.

const boardHtml = (heading: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Board</title></head><body>
<h1 id="page-heading">${heading}</h1>
<p id="page-notes">Page notes: ${notesHtml()}</p>
<walnut-thread id="notes" title="Notes"></walnut-thread>
<walnut-choice id="source" title="Path source" options="yes:Use the notes,no:Skip"></walnut-choice>
</body></html>`

/** The chooser's buttons are machines: this one ("Local: …") or the remote host, each naming its copies after it. */
const LOCAL_CHOICE = /^Local: /
const REMOTE_CHOICE = /^(?!Local: )[^:]+: /

async function chooseBoardHost(page: Page, where: 'local' | 'remote', copy: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: "Choose the path's source", exact: true });
  await expect(dialog).toBeVisible();
  const button = dialog.getByRole('button', { name: where === 'local' ? LOCAL_CHOICE : REMOTE_CHOICE });
  await expect(button).toHaveCount(1);
  await expect(button).toContainText(copy);
  await expect(dialog, 'a source never reads as a session id').not.toContainText(REMOTE_SID);
  await click(page, button);
}

async function expectPrimaryText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Primary line two', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Remote')
}

test('a Board page path opens on its writer\'s machine and a post\'s path on the session that posted it; a path typed by two machines asks which; drawing reads no session, a cancelled read opens nothing late', async ({ page, request }) => {
  const remoteReads = () => net.remote().filter((f) => f.includes('file-content'))
  const litter: string[] = []
  try {
    await presetPanelView(page, { section: 'all', project: '' })
    await openApp(page)

    // ── The owner: a leader on this machine, its Board written by a person ──
    await openDraftOnCwd(page, path.dirname(dir), { engine: 'Claude' })
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
    await click(page, draftComposer(page))
    await page.keyboard.type('snapshot-clean-turn:Board source ready', { delay: 20 })
    await page.keyboard.press('Enter')
    const { taskId: leader, sessionId: leaderSid } = await ok(await started, 'quick start') as { taskId: string; sessionId: string }
    litter.push(leader)
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${leaderSid}"]`)
    await expect(panel.getByText('Board source ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
    const unsent = panel.locator('.chat-input-textarea')
    await click(page, unsent)
    await page.keyboard.type('Keep these words while the Board changes the column width.', { delay: 12 })
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Written by a person') } }), 'board by a person')

    let pane = await openSessionBoard(page, panel)
    await showCustomBoard(pane)
    const frame = page.frameLocator('.task-board-frame')
    await expect(frame.locator('#page-heading')).toHaveText('Written by a person', { timeout: 20_000 })
    const pageLink = frame.locator('#page-notes a[data-walnut-ref="file"]')
    await expect(pageLink).toBeVisible()
    await settle(page)
    expect(net.lookups(), 'mounting the Board read no session').toBe(0)
    expect(net.files()).toEqual([])

    // A person's page: the owner's machine, which is this one.
    await click(page, pageLink)
    await expectPrimaryText(page)
    await closeFile(page)
    expect(remoteReads()).toEqual([])
    await fs.unlink(doc)
    try {
      await click(page, pageLink)
      await expect(page.getByTestId('file-viewer-missing')).toContainText('on Local')
      await expect(page.locator('.file-viewer-overlay .cm-content')).toHaveCount(0)
      expect(remoteReads(), 'a missing primary source is never replaced with the remote copy').toEqual([])
      await closeFile(page)
    } finally { await fs.writeFile(doc, PRIMARY_TEXT) }
    await click(page, pageLink)
    await expectPrimaryText(page)
    await closeFile(page)

    // Editing other text does not move a path written on this machine to the editor's machine.
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { edits: [
        { old: 'Written by a person', new: 'Page title edited remotely' },
      ] },
    }), 'remote title edit')
    await expect(frame.locator('#page-heading')).toHaveText('Page title edited remotely', { timeout: 20_000 })
    await click(page, pageLink)
    await expectPrimaryText(page)
    await closeFile(page)
    expect(remoteReads(), 'a title edit kept the original path source').toEqual([])
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, {
      data: { html: boardHtml('Page title edited remotely').replace(doc, doc.replace(/notes\.txt$/, 'old notes.txt')) },
    }), 'person writes a path before a deletion')
    // The page shows this version before the remote edit lands: the path alone would read as the old
    // one (it is the path the page began with) and a press could use the pane's earlier sources.
    const linkedPath = async () => new URLSearchParams(new URL((await pageLink.getAttribute('href'))!, base).search || new URL((await pageLink.getAttribute('href'))!, base).hash.slice(1)).get('path')
    await expect.poll(linkedPath, { timeout: 20_000 }).toBe(doc.replace(/notes\.txt$/, 'old notes.txt'))
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { edits: [{ old: 'old notes.txt"', new: 'notes.txt"' }] },
    }), 'remote deletion creates the shortened path')
    await expect.poll(async () => new URLSearchParams(new URL((await pageLink.getAttribute('href'))!, base).search || new URL((await pageLink.getAttribute('href'))!, base).hash.slice(1)).get('path'), { timeout: 20_000 }).toBe(doc)
    const beforeDeletion = net.files().length
    await click(page, pageLink)
    const deletionChoices = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
    await expect(deletionChoices).toBeVisible()
    expect(net.files(), 'deleting characters cannot give the old writer the shortened path').toHaveLength(beforeDeletion)
    await chooseBoardHost(page, 'remote', 'Board page')
    await expectRemoteText(page)
    await closeFile(page)
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Page title edited remotely') } }), 'restore the person source')
    // One path typed in parts: the person's text, one letter the remote session retyped, the person's
    // text again (A, B, A). Saved spans like these used to fail every press; now the press reads both
    // writers' machines and asks which one, probing no file before the choice.
    const typo = doc.replace(/notes\.txt$/, 'nXtes.txt')
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Page title edited remotely').replace(doc, typo) } }), 'person writes the path with a typo')
    await expect.poll(async () => new URLSearchParams(new URL((await pageLink.getAttribute('href'))!, base).search || new URL((await pageLink.getAttribute('href'))!, base).hash.slice(1)).get('path'), { timeout: 20_000 }).toBe(typo)
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { edits: [
        { old: 'nXtes.txt"', new: 'notes.txt"' },
      ] },
    }), 'one letter of the path fixed remotely')
    await expect.poll(async () => new URLSearchParams(new URL((await pageLink.getAttribute('href'))!, base).search || new URL((await pageLink.getAttribute('href'))!, base).hash.slice(1)).get('path'), { timeout: 20_000 }).toBe(doc)
    const split = (await ok(await request.get(`/api/v1/tasks/${leader}/board`), 'split spans')).board as { html: string; html_sources: Array<{ start: number; end: number; by: string; sessionId?: string }> }
    const at = split.html.indexOf(doc)
    const covering = split.html_sources.filter((x) => x.start < at + doc.length && x.end > at)
    expect(covering.map((x) => x.by), 'the path is the person\'s, the remote session\'s, the person\'s').toEqual(['human', 'task:pw-task-remote-writer', 'human'])
    expect(covering[1]).toMatchObject({ sessionId: REMOTE_SID, end: covering[1]!.start + 1 })
    for (const where of ['remote', 'local'] as const) {
      const beforeSplit = net.files().length
      const lookupsBefore = net.lookups()
      await click(page, pageLink)
      const splitChoices = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
      await expect(splitChoices.getByRole('button', { name: LOCAL_CHOICE })).toHaveText('Local: Board page')
      await expect(splitChoices.getByRole('button', { name: REMOTE_CHOICE })).toContainText('Board page')
      expect(net.files(), 'reading the writers\' machines probes no file').toHaveLength(beforeSplit)
      expect(net.lookups(), 'at most one read of the remote session, on this press').toBeLessThanOrEqual(lookupsBefore + 1)
      await chooseBoardHost(page, where, 'Board page')
      if (where === 'remote') await expectRemoteText(page)
      else await expectPrimaryText(page)
      await closeFile(page)
    }
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Page title edited remotely') } }), 'restore original path source')
    await expect(pageLink).toBeVisible({ timeout: 20_000 })
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { edits: [
        { old: '</body>', new: `<p id="worker-notes">Worker notes: ${notesHtml(2)}</p></body>` },
      ] },
    }), 'remote path inserted')
    const inserted = frame.locator('#worker-notes a[data-walnut-ref="file"]')
    await expect(inserted).toBeVisible({ timeout: 20_000 })
    const beforeAmbiguous = net.files().length
    for (const link of [inserted, pageLink]) {
      await click(page, link)
      const choices = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
      await expect(choices).toBeVisible()
      expect(net.files(), 'a copied frame offset never selects a machine').toHaveLength(beforeAmbiguous)
      await expect(choices.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(choices).toHaveCount(0)
    }
    await click(page, inserted)
    await ok(await request.put(`/api/v1/tasks/${leader}/board/marks/source-check`, { data: { note: 'Unrelated update while choosing a source' } }), 'mark changed while choosing')
    await chooseBoardHost(page, 'remote', 'Board page')
    await expectRemoteText(page)
    await closeFile(page)
    await click(page, pageLink)
    const changingSource = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
    await expect(changingSource).toBeVisible()
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Same text, new owner') } }), 'whole page changes the source choice')
    await expect(changingSource).toHaveCount(0)
    await expect(frame.locator('#page-heading')).toHaveText('Same text, new owner', { timeout: 20_000 })
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { edits: [
        { old: '</body>', new: `<p id="worker-notes">Worker notes: ${notesHtml(2)}</p></body>` },
      ] },
    }), 'restore two sources')
    await expect(inserted).toBeVisible({ timeout: 20_000 })
    await click(page, pageLink)
    await page.setViewportSize({ width: 1024, height: 720 })
    await expect(unsent).toHaveValue('Keep these words while the Board changes the column width.')
    await chooseBoardHost(page, 'local', 'Board page')
    await expectPrimaryText(page)
    await closeFile(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { edits: [
        { old: `<p id="worker-notes">Worker notes: ${notesHtml(2)}</p>`, new: `<p id="worker-notes">Worker design: ${picture}</p>` },
      ] },
    }), 'remote path made unambiguous')
    await expect(inserted).toHaveText(picture, { timeout: 20_000 })
    await click(page, inserted)
    await expectRemotePicture(page)
    await closeFile(page)
    const remoteAfterDesign = remoteReads().length
    await click(page, pageLink)
    await expectPrimaryText(page)
    await closeFile(page)
    expect(remoteReads(), 'a distinct new path kept the original writer').toHaveLength(remoteAfterDesign)
    // A whole-document write deliberately replaces every source before the post-lifetime checks.
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Written by a person') } }), 'restore whole page')
    await expect(frame.locator('#page-heading')).toHaveText('Written by a person', { timeout: 20_000 })
    net.reset()

    const answered = await ok(await request.put(`/api/v1/tasks/${leader}/board/choices/source`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { text: `Answer notes: ${picture}` },
    }), 'remote choice answer')
    expect(answered.choice).toMatchObject({ text_by: 'task:pw-task-remote-writer', text_session_id: REMOTE_SID })
    const choice = frame.locator('walnut-choice#source')
    await expect(choice.locator('.wn-fold-row .wn-fold-by')).toHaveText('by the task "Remote writer fixture"', { timeout: 20_000 })
    const foldedPath = choice.locator('.wn-fold-words a.file-link')
    await expect(foldedPath).toHaveAttribute('data-file-path', picture)
    expect(net.lookups(), 'drawing a folded choice answer reads no session').toBe(0)
    await click(page, foldedPath)
    await expectRemotePicture(page)
    await closeFile(page)
    await expect(choice).toHaveAttribute('data-folded', '')
    const lookupsAfterFoldedPath = net.lookups()
    await click(page, choice.locator('.wn-fold-toggle'))
    const choiceLink = choice.locator('.wn-choice-words a.file-link')
    await expect(choiceLink).toBeVisible({ timeout: 20_000 })
    expect(net.lookups(), 'expanding a choice reads no additional session').toBe(lookupsAfterFoldedPath)
    await click(page, choiceLink)
    await expectRemotePicture(page)
    await closeFile(page)
    const lookupsAfterChoice = net.lookups()
    await ok(await request.put(`/api/v1/tasks/${leader}/board/choices/source`, {
      data: { option: 'yes' },
    }), 'person changes only the choice option')
    expect((await ok(await request.get(`/api/v1/tasks/${leader}/board`), 'choice after option')).choices.source)
      .toMatchObject({ text_by: 'task:pw-task-remote-writer', text_session_id: REMOTE_SID })
    await click(page, choiceLink)
    await expectRemotePicture(page)
    await closeFile(page)
    expect(net.lookups()).toBe(lookupsAfterChoice)
    // The pane draws the payload it last read: wait until it holds the person's version.
    const personsChoice = page.waitForResponse(async (r) => {
      const url = new URL(r.url())
      if (r.request().method() !== 'GET' || url.pathname !== `/api/v1/tasks/${leader}/board` || url.searchParams.has('fields')) return false
      const source = (await r.json().catch(() => null))?.choices?.source
      return !!source && !('text_by' in source)
    }, { timeout: 30_000 })
    await ok(await request.put(`/api/v1/tasks/${leader}/board/choices/source`, {
      data: { text: `Answer notes: ${picture}` },
    }), 'person takes over the same answer words')
    await personsChoice
    await settle(page)
    const humanChoice = (await ok(await request.get(`/api/v1/tasks/${leader}/board`), 'human choice')).choices.source
    expect(humanChoice).not.toHaveProperty('text_by')
    expect(humanChoice).not.toHaveProperty('text_session_id')
    const primaryImage = page.locator('.file-viewer-overlay img[src*="/api/file-raw/"]').first()
    await click(page, choiceLink)
    await expect(primaryImage).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => primaryImage.evaluate((el: HTMLImageElement, width) => el.complete && el.naturalWidth > 0 && el.naturalWidth !== width, remoteWidth)).toBe(true)
    await closeFile(page)
    // The pane draws the payload it last read: a fold pressed before it holds the summary is drawn over.
    const withSummary = page.waitForResponse(async (r) => {
      const url = new URL(r.url())
      if (r.request().method() !== 'GET' || url.pathname !== `/api/v1/tasks/${leader}/board` || url.searchParams.has('fields')) return false
      return String((await r.json().catch(() => null))?.board?.html ?? '').includes(`summary="Summary notes: ${picture}"`)
    }, { timeout: 30_000 })
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID },
      data: { edits: [{ old: 'id="source" title="Path source"', new: `id="source" title="Path source" summary="Summary notes: ${picture}"` }] },
    }), 'remote writer adds a folded summary')
    await withSummary
    await settle(page)
    await click(page, choice.locator('.wn-fold-btn'))
    await expect(choice).toHaveAttribute('data-folded', '')
    const summaryLink = choice.locator('.wn-fold-sum a.file-link')
    await expect(summaryLink).toHaveAttribute('data-file-path', picture)
    const summaryProse = 'Updated notes: '.repeat(30)
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      data: { edits: [{ old: 'Summary notes: ', new: summaryProse }] },
    }), 'a person edits only the long summary prose, not its path')
    // The pane draws the payload it last read: a click after a person's edit waits for the read that holds it.
    const boardRead = (marker: string) => page.waitForResponse(async (r) => {
      const url = new URL(r.url())
      if (r.request().method() !== 'GET' || url.pathname !== `/api/v1/tasks/${leader}/board` || url.searchParams.has('fields')) return false
      return (await r.text().catch(() => '')).includes(marker)
    }, { timeout: 30_000 })
    const summaryScroller = choice.locator('.wn-fold-sum')
    await expect(summaryScroller).toContainText(summaryProse.trim())
    await expect(choice).toHaveAttribute('data-folded', '')
    const summarySize = await summaryScroller.evaluate((el) => ({ width: el.clientWidth, content: el.scrollWidth }))
    expect(summarySize.content).toBeGreaterThan(summarySize.width)
    const summaryBox = await summaryScroller.boundingBox()
    expect(summaryBox).not.toBeNull()
    await page.mouse.move(summaryBox!.x + summaryBox!.width / 2, summaryBox!.y + summaryBox!.height / 2)
    await page.mouse.wheel(summarySize.content, 0)
    await expect.poll(() => summaryScroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
    await expect.poll(() => summaryLink.evaluate((el) => {
      const scroller = el.closest('.wn-fold-sum')!
      const r = scroller.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return hit === el || !!hit && el.contains(hit)
    })).toBe(true)
    await click(page, summaryLink)
    await chooseBoardHost(page, 'remote', 'Board summary')
    await expectRemotePicture(page)
    await closeFile(page)
    await expect(choice).toHaveAttribute('data-folded', '')
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID },
      data: { edits: [{ old: ` summary="${summaryProse}${picture}"`, new: ` summary="Encoded notes: ${picture}.bak"` }] },
    }), 'the remote writer names a longer path')
    const cutRead = boardRead(`${picture}&#10;.bak`)
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      data: { edits: [{ old: `${picture}.bak`, new: `${picture}&#10;.bak` }] },
    }), 'a person cuts the path with an encoded newline')
    await cutRead
    await expect(summaryLink).toHaveAttribute('data-file-path', picture)
    await settle(page)
    net.reset()
    await click(page, summaryLink)
    const cutChoice = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
    await expect(cutChoice).toBeVisible()
    await settle(page)
    expect(net.remote(), 'the shortened path cannot borrow the old writer before a choice').toEqual([])
    await chooseBoardHost(page, 'remote', 'Board summary')
    await expectRemotePicture(page)
    await closeFile(page)
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID },
      data: { edits: [{ old: ` summary="Encoded notes: ${picture}&#10;.bak"`, new: ` summary="Encoded notes: ${picture}&#100.bak"` }] },
    }), 'the remote writer names the unbroken entity path')
    const terminatedRead = boardRead('&#10x.bak')
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      data: { edits: [{ old: '&#100.bak', new: '&#10x.bak' }] },
    }), 'a person terminates the entity before the changed byte')
    await terminatedRead
    await expect(summaryLink).toHaveAttribute('data-file-path', picture)
    await settle(page)
    net.reset()
    await click(page, summaryLink)
    await expect(cutChoice).toBeVisible()
    await settle(page)
    expect(net.remote(), 'the early-terminated path asks before reading the old machine').toEqual([])
    await chooseBoardHost(page, 'remote', 'Board summary')
    await expectRemotePicture(page)
    await closeFile(page)
    await ok(await request.post(`/api/v1/tasks/${leader}/board/edits`, {
      data: { edits: [{ old: ` summary="Encoded notes: ${picture}&#10x.bak"`, new: '' }] },
    }), 'remove the summary before the post-lifetime checks')
    await ok(await request.put(`/api/v1/tasks/${leader}/board/choices/source`, { data: { text: '' } }), 'clear answer')
    // Start the post-lifetime check without the choice's already-read session record.
    await leaveFullscreen(page)
    await page.reload()
    pane = page.getByTestId('task-board-pane')
    if (!(await pane.isVisible())) pane = await openSessionBoard(page, panel)
    await showCustomBoard(pane)
    await expect(pageLink).toBeVisible({ timeout: 20_000 })
    net.reset()

    // ── A post by the remote session: the server keeps that session on it ──
    // The post belongs to the remote writer's task, not the local Board owner.
    const writer = (await ok(await request.get(`/api/sessions/${REMOTE_SID}`), 'writer session')).session as Record<string, unknown>
    expect(writer.host).toBe(REMOTE)
    expect(writer.taskId).toBe('pw-task-remote-writer')
    const posted = await ok(await request.post(`/api/v1/tasks/${leader}/board/threads/notes`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { text: `Notes are in ${notesRef(2)}` },
    }), 'remote post')
    const msgId = posted.message.id as string
    expect(posted.message).toMatchObject({ author: 'task:pw-task-remote-writer', sessionId: REMOTE_SID })
    const stored = await ok(await request.get(`/api/v1/tasks/${leader}/board`), 'read board')
    expect((stored.threads.notes as Array<Record<string, unknown>>).find((m) => m.id === msgId)).toMatchObject({ sessionId: REMOTE_SID })
    expect(stored.board).not.toHaveProperty('updated_session_id')

    const postLink = () => frame.locator(`walnut-thread#notes .wn-msg[data-id="${msgId}"] a.file-link[data-file-path="${doc}"]:not(#forged-path)`)
    await expect(postLink()).toBeVisible({ timeout: 20_000 })
    await settle(page)
    expect(net.lookups(), 'drawing the post read no session').toBe(0)

    // Two writers on two machines: the press reads the post's session first, and says so while it waits.
    // Closed with Escape while that read is out: the late answer opens nothing and asks nothing.
    net.gate.mode = 'hold'
    await click(page, postLink())
    const pending = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
    await expect(pending.getByRole('status')).toContainText('Finding the machine each one is on')
    await expect.poll(() => net.gate.held, { timeout: 20_000 }).toBe(1)
    await expect(pending.getByRole('button', { name: LOCAL_CHOICE })).toHaveCount(0)
    const cancel = pending.getByRole('button', { name: 'Cancel', exact: true })
    await expect(cancel, 'the pending dialog can always be left').toBeEnabled()
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(pending).toHaveCount(0)
    const late = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`)
    net.gate.release()
    expect((await late).ok()).toBe(true)
    await settle(page)
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
    await expect(pending).toHaveCount(0)
    expect(net.remote(), 'the late answer opened nothing').toEqual([])
    expect(net.lookups()).toBe(1)

    // Press again: the record is known now, so the machines are named at once, each first on its button.
    await click(page, postLink())
    await chooseBoardHost(page, 'remote', 'Reply by Remote writer fixture in notes')
    await expectRemoteText(page)
    await closeFile(page)
    expect(net.lookups()).toBe(1)

    // The same path on the page, after the post: still the page's writer, this machine.
    const remoteBefore = remoteReads().length
    await click(page, pageLink)
    await chooseBoardHost(page, 'local', 'Board page')
    await expectPrimaryText(page)
    await closeFile(page)
    expect(remoteReads()).toHaveLength(remoteBefore)

    // ── The page written by the remote session: its path opens there ──
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, {
      headers: { 'x-walnut-caller-sid': REMOTE_SID }, data: { html: boardHtml('Written by the remote session') },
    }), 'board by the remote session')
    const remotePage = await ok(await request.get(`/api/v1/tasks/${leader}/board`), 'read remote page')
    expect(remotePage.board).toMatchObject({ updated_by: 'task:pw-task-remote-writer', updated_session_id: REMOTE_SID })
    await expect(frame.locator('#page-heading')).toHaveText('Written by the remote session', { timeout: 20_000 })
    await click(page, pageLink)
    await expectRemoteText(page)
    await closeFile(page)

    // ── The same page as an older Walnut stored it: a task writer with no session saved beside it ──
    // (no spans, no updated_session_id). That task's session now may run on another machine than the one
    // that wrote the text, so the press reads no task, no session and no file, and opens nothing, even
    // though the post's copy of the path still names its own session.
    const olderTask = 'pw-task-001'
    const boardRoute = (url: URL) => url.pathname === `/api/v1/tasks/${leader}/board` && !url.searchParams.has('fields')
    const asOlder = async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const response = await route.fetch()
      const body = await response.json() as { board?: Record<string, unknown> | null }
      if (body.board) {
        body.board.updated_by = `task:${olderTask}`
        delete body.board.updated_session_id
        delete body.board.html_sources
        body.board.html = `${body.board.html}<p id="old-range"><a href="${doc}:2">Old range</a></p>`
      }
      await route.fulfill({ response, json: body })
    }
    const taskReads: string[] = []
    const onTaskRead = (r: Request) => {
      const at = new URL(r.url()).pathname
      if (r.method() === 'GET' && (at === `/api/tasks/${olderTask}` || at === `/api/v1/tasks/${olderTask}`)) taskReads.push(at)
    }
    page.on('request', onTaskRead)
    await page.route(boardRoute, asOlder)
    try {
      const olderAnswer = page.waitForResponse((r) => boardRoute(new URL(r.url())) && r.request().method() === 'GET')
      await click(page, pane.getByTestId('board-refresh'))
      await olderAnswer
      await expect(pageLink).toBeVisible({ timeout: 20_000 })
      await settle(page)
      const filesBefore = net.files().length
      const lookupsBefore = net.lookups()
      const oldRange = frame.locator('#old-range a[data-walnut-ref="file"]')
      await expect(oldRange).toBeVisible()
      await click(page, oldRange)
      await expect(page.locator('.file-viewer-overlay').getByTestId('file-viewer-source-error')).toContainText('No file was read', { timeout: 20_000 })
      await expect(page.locator('.file-viewer-line')).toHaveText(':2')
      await expect(page.getByRole('dialog', { name: "Choose the path's source", exact: true })).toHaveCount(0)
      await settle(page)
      expect(net.files(), 'an older task writer opens nothing on any machine').toHaveLength(filesBefore)
      expect(net.lookups(), 'and reads no session for it').toBe(lookupsBefore)
      expect(taskReads, 'and never reads the task to guess its machine').toEqual([])
      await closeFile(page)
    } finally {
      await page.unroute(boardRoute, asOlder)
      page.off('request', onTaskRead)
    }
    const currentAnswer = page.waitForResponse((r) => boardRoute(new URL(r.url())) && r.request().method() === 'GET')
    await click(page, pane.getByTestId('board-refresh'))
    await currentAnswer
    await click(page, pageLink)
    await expectRemoteText(page)
    await closeFile(page)

    // ── A person writes it again: the session is cleared, and the page is the owner's again ──
    const forgedRow = `<script>
      window.nonceCaptured = false;
      Object.defineProperty(Object.prototype, 'nonce', { configurable: true, set(value) {
        window.nonceCaptured = true;
        window.parent.postMessage({ t: 'wn-board:open-file', path: ${JSON.stringify(doc)}, nonce: value }, '*');
      } });
      Object.defineProperty(Object.prototype, 'get', { configurable: true, get() {
        if (Object.prototype.hasOwnProperty.call(this, 'value') && typeof this.value === 'string' && /^[0-9a-f]{32}$/.test(this.value)) {
          window.nonceCaptured = true;
          window.parent.postMessage({ t: 'wn-board:open-file', path: ${JSON.stringify(doc)}, nonce: this.value }, '*');
        }
        return undefined;
      } });
      const thread = document.createElementNS('urn:board-content', 'walnut-thread');
      thread.setAttribute('id', 'notes'); thread.setAttribute('style', 'display:block');
      const row = document.createElement('div'); row.className = 'wn-msg'; row.dataset.id = ${JSON.stringify(msgId)};
      const link = document.createElement('a'); link.id = 'forged-path'; link.className = 'file-link';
      link.href = '#'; link.dataset.filePath = ${JSON.stringify(doc)}; link.dataset.fileLine = '2';
      link.textContent = 'Copied row: ' + ${JSON.stringify(doc)};
      row.appendChild(link); thread.appendChild(row); document.body.appendChild(thread);
    </script>`
    await ok(await request.put(`/api/v1/tasks/${leader}/board`, { data: { html: boardHtml('Written by a person again').replace('</body>', `${forgedRow}</body>`) } }), 'board by a person again')
    const humanPage = await ok(await request.get(`/api/v1/tasks/${leader}/board`), 'read person page')
    expect(humanPage.board.updated_by).toBe('human')
    expect(humanPage.board).not.toHaveProperty('updated_session_id')
    await expect(frame.locator('#page-heading')).toHaveText('Written by a person again', { timeout: 20_000 })
    await settle(page)
    expect(await frame.locator('body').evaluate(() => (window as unknown as { nonceCaptured: boolean }).nonceCaptured)).toBe(false)
    await expect(page.getByRole('dialog', { name: "Choose the path's source", exact: true })).toHaveCount(0)
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
    const remoteAfter = remoteReads().length
    await click(page, pageLink)
    await chooseBoardHost(page, 'local', 'Board page')
    await expectPrimaryText(page)
    await closeFile(page)
    expect(remoteReads()).toHaveLength(remoteAfter)
    // Copying a real post's DOM attributes cannot borrow that post's machine.
    await click(page, frame.locator('#forged-path'))
    await chooseBoardHost(page, 'local', 'Board page')
    await expectPrimaryText(page)
    await closeFile(page)
    expect(remoteReads()).toHaveLength(remoteAfter)
    // The post kept its own session through both page writes.
    await click(page, postLink())
    await chooseBoardHost(page, 'remote', 'Reply by Remote writer fixture in notes')
    await expectRemoteText(page)
    await closeFile(page)
    expect(net.lookups(), 'one session read since the fresh post-lifetime page').toBe(1)
    await expect(unsent).toHaveValue('Keep these words while the Board changes the column width.')
    await page.setViewportSize({ width: 1024, height: 720 })
    await expect(unsent).toHaveValue('Keep these words while the Board changes the column width.')
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(unsent).toHaveValue('Keep these words while the Board changes the column width.')

    // ── The pane closes while the machines are read: the late answer opens nothing ──
    // A fresh page holds no session record, so the press must read the post's session. While that read is
    // held, the fixture deletes the Board, the panel closes the Board view (its task no longer leads), and
    // the pane unmounts with the pending dialog still up: nobody dismissed it and nothing was pressed again.
    await leaveFullscreen(page)
    await page.reload()
    pane = page.getByTestId('task-board-pane')
    if (!(await pane.isVisible())) pane = await openSessionBoard(page, panel)
    await showCustomBoard(pane)
    await expect(postLink()).toBeVisible({ timeout: 20_000 })
    await settle(page)
    net.reset()
    net.gate.mode = 'hold'
    await click(page, postLink())
    const closing = page.getByRole('dialog', { name: "Choose the path's source", exact: true })
    await expect(closing.getByRole('status')).toContainText('Finding the machine each one is on')
    await expect.poll(() => net.gate.held, { timeout: 20_000 }).toBe(1)
    await ok(await request.delete(`/api/v1/tasks/${leader}/board`), 'board deleted while its path source is read')
    await expect(page.getByTestId('task-board-pane')).toHaveCount(0, { timeout: 20_000 })
    await expect(closing).toHaveCount(0)
    const lateAfterClose = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`)
    net.gate.release()
    expect((await lateAfterClose).ok()).toBe(true)
    await settle(page)
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
    await expect(closing).toHaveCount(0)
    expect(net.remote(), 'the late answer after the pane closed opened nothing').toEqual([])
    expect(net.primary(), 'nor anything on this machine').toEqual([])
    expect(net.lookups()).toBe(1)
  } finally {
    for (const id of litter) {
      await request.delete(`/api/v1/tasks/${id}/board`).catch(() => {})
      await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
    }
  }
})
