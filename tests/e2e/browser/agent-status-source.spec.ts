// A path in a task's status words opens where Walnut recorded those words were written, never
// through the task's current session (2026-11-07: a status line an older session wrote opened its
// path through the task's newer session, on another machine).
//
// Real: the fixture server, PUT /api/v1/tasks/:id/report (a session's write carries
// `x-walnut-caller-sid`, which Walnut resolves and stores as the report's writer; a person's carries
// none), the status sync, Home's status rows, the renderer, the opener and every React handler.
// Every task here runs a LOCAL session now (taskWithReply), while its report was written by
// `pw-limits-remote-session` (host `fixture-remote`): opening through the task's current session
// would show this machine's copy. Mocked at the host boundary only (page.route): the remote host's
// file answers, because the host fixture serves no file bytes, and the timing of the real session
// read (held, or failed with a 503) where a test says so. The same absolute path on this machine
// holds different bytes, so a wrong pick shows the primary's copy.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Locator, type Page, type Request, type Route } from '@playwright/test'
import {
  AGENT_TEXT_BASE as base, click, closeFile, openApp, sessionColumn, setReport, showPointer, tabTo, taskWithReply,
} from './agent-text-entry-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { LS_PANEL_DESIGN_KEY } from './status-section-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const REMOTE = 'fixture-remote'
const REMOTE_SID = 'pw-limits-remote-session'
const stamp = Date.now().toString(36)
const project = `Status source ${stamp}`
const PRIMARY_TEXT = 'Primary copy\nPrimary line two\nPrimary line three\n'
const REMOTE_TEXT = 'Remote copy\nRemote line two from fixture-remote\nRemote line three\n'
const asRemote = { 'x-walnut-caller-sid': REMOTE_SID }
// A caller header Walnut cannot resolve: the real route stores an unknown writer.
const asUnresolved = { 'x-walnut-caller-sid': `pw-status-source-nobody-${stamp}` }

type Key = 'remoteNeeds' | 'remoteWait' | 'personNeeds' | 'unknownNeeds' | 'heldNeeds'
const titles: Record<Key, string> = {
  remoteNeeds: `Remote ask ${stamp}`,
  remoteWait: `Remote wait ${stamp}`,
  personNeeds: `Person ask ${stamp}`,
  unknownNeeds: `Untracked ask ${stamp}`,
  heldNeeds: `Moving ask ${stamp}`,
}
const ids = {} as Record<Key, string>
const sids = {} as Record<Key, string>
let dir = '', doc = ''

test.describe.configure({ mode: 'default' })
test.setTimeout(180_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, video: 'on' })

async function ok(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string): Promise<any> {
  const text = await res.text()
  expect(res.ok(), `${what}: ${res.status()} ${text}`).toBe(true)
  return text ? JSON.parse(text) : null
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (new URL(base).port === '3456') throw new Error('These checks write tasks: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(Number(new URL(base).port))
  dir = path.join(fixtureRoot, 'projects', 'walnut', `agent-status-${stamp}`)
  doc = path.join(dir, 'notes.txt')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(doc, PRIMARY_TEXT)

  // The writer the reports name: a real session record on the remote host.
  const record = await ok(await request.get(`/api/sessions/${REMOTE_SID}`), 'session record')
  expect(record.session.host, 'the fixture session runs on the remote host').toBe(REMOTE)
  expect(record.session.taskId, 'the writer keeps its own task through startup migration').toBe('pw-task-remote-writer')

  for (const key of Object.keys(titles) as Key[]) {
    const t = await taskWithReply(request, titles[key], project, `Status source ${key}`)
    ids[key] = t.id
    sids[key] = t.sid
    // The task's session now is a local one, never the report's writer.
    const now = await ok(await request.get(`/api/sessions/${t.sid}`), 'task session')
    expect(t.sid).not.toBe(REMOTE_SID)
    expect(['', 'local', '__local__', undefined]).toContain(now.session.host)
  }

  const needs = (words: string) => ({ state: 'needs', ask: words })
  const fromRemote = (s: any) => s.askSessionId === REMOTE_SID && s.askBy !== 'human'
  await setReport(request, ids.remoteNeeds, needs(`Read ${doc}:2 before you pick`),
    (s) => s.state === 'needs' && String(s.ask ?? '').includes(doc) && fromRemote(s), asRemote)
  await setReport(request, ids.heldNeeds, needs(`Read ${doc}:2 before the move`),
    (s) => s.state === 'needs' && String(s.ask ?? '').includes(doc) && fromRemote(s), asRemote)
  await setReport(request, ids.remoteWait, { state: 'waiting', waiting_kind: 'outside', waiting_on: `the review of ${doc}:2` },
    // The wait carries its own writer (waitingSessionId), set only from the report's waiting_on.
    (s) => s.state === 'waiting' && String(s.waitingOn ?? '').includes(doc) && s.waitingSessionId === REMOTE_SID && s.waitingBy !== 'human', asRemote)
  // A person's write: no caller header, the primary's words.
  await setReport(request, ids.personNeeds, needs(`Read ${doc}:2 here`),
    (s) => s.state === 'needs' && String(s.ask ?? '').includes(doc) && s.askBy === 'human')
  // A session Walnut could not resolve: stored as an unknown writer, with no session.
  await setReport(request, ids.unknownNeeds, needs(`Read ${doc}:2 from nowhere`),
    (s) => s.state === 'needs' && String(s.ask ?? '').includes(doc) && s.askBy === 'unknown' && !s.askSessionId, asUnresolved)
})

test.afterAll(async ({ request }) => {
  for (const sid of Object.values(sids)) if (sid) await request.post(`/api/sessions/${sid}/terminate`).catch(() => {})
  for (const id of Object.values(ids)) if (id) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
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

const FILE_API = /^\/api\/(?:file-content$|file-raw\/|local-image$|files\/(?:locate|list|list-many|exists)$)/
const LOCAL = new Set(['', 'local', '__local__'])

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
  const target = q.get('ref') ?? q.get('path') ?? body.paths?.find((p) => p === doc || p === dir) ?? ''
  return { api: api.replace('/api/', ''), host: q.get('host') ?? body.host ?? 'local', path: target, method: req.method() }
}

const ours = (t: Touch) => t.path === doc || t.path === dir

function listing(p: string) {
  const entries = (d: string) => (path.dirname(doc) === d ? [{ name: path.basename(doc), type: 'file', size: Buffer.byteLength(REMOTE_TEXT) }] : [])
  if (p === doc) return { path: path.dirname(p), entries: entries(path.dirname(p)), selectedFile: path.basename(p) }
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
    case 'files/locate':
      return json(p === doc ? { path: p, host: REMOTE, hostName: 'Big remote host', found: true } : { path: p, host: REMOTE, found: false, missing: true, checked: ['Big remote host'] })
    case 'files/list': return json(listing(p))
    case 'files/list-many': {
      const paths = (route.request().postDataJSON()?.paths ?? []) as string[]
      return json({ listings: paths.map(listing), truncated: false, timedOut: false })
    }
    case 'files/exists': {
      const paths = (route.request().postDataJSON()?.paths ?? []) as string[]
      return json({ exists: Object.fromEntries(paths.map((x) => [x, x === doc])) })
    }
    case 'file-content':
      if (p !== doc) return json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: path.extname(p).slice(1) })
      return json({ content: REMOTE_TEXT, size: Buffer.byteLength(REMOTE_TEXT), truncated: false, binary: false, extension: 'txt', contentHash: createHash('sha256').update(REMOTE_TEXT).digest('hex') })
    default: return route.fallback()
  }
}

interface Net {
  gate: Gate
  /** GETs of the remote session's record since the page opened. */
  lookups(): number
  /** Reads of the seeded file on this machine (each would show the primary's bytes). */
  primary(): string[]
  /** Every file request for the seeded path, either host. */
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
    lookups: () => seen.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`).length,
    primary: () => touches().filter((t) => LOCAL.has(t.host)).map(line),
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
  expect(net.errors, 'no page error').toEqual([])
})

// ── Steps ──

/** Home in Flat (the status sections), with each row's status sentence shown. */
async function homeWithStatusLines(page: Page): Promise<Locator> {
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, 'status')
    localStorage.setItem('open-walnut-view:tasks.statusLines', 'true')
  }, [LS_PANEL_DESIGN_KEY])
  await openApp(page)
  const all = page.locator('.todo-section-tabs [role="tab"]', { hasText: 'All' }).first()
  if (await all.isVisible() && (await all.getAttribute('aria-selected')) !== 'true') {
    await click(page, all)
    await expect(all).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
  }
  return page.locator('.todo-panel').first()
}

/** The mouse wheel over the list that scrolls `target`, until the topmost element at its middle is it. */
async function wheelTo(page: Page, target: Locator, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    const at = await target.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const view = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      let box = view
      for (let a = el.parentElement; a; a = a.parentElement) {
        const oy = getComputedStyle(a).overflowY
        if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight) {
          const s = a.getBoundingClientRect()
          box = { top: Math.max(s.top, 0), bottom: Math.min(s.bottom, view.bottom), left: Math.max(s.left, 0), right: Math.min(s.right, view.right) }
          break
        }
      }
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const inBox = y >= box.top && y <= box.bottom && x >= box.left && x <= box.right
      const hit = inBox ? el.ownerDocument.elementFromPoint(x, y) : null
      const mid = (box.top + box.bottom) / 2
      return { shown: !!hit && (hit === el || el.contains(hit)), dy: y > box.bottom ? 240 : y < box.top ? -240 : y > mid ? 80 : -80, wx: (box.left + box.right) / 2, wy: mid }
    })
    if (at.shown) return
    await page.mouse.move(at.wx, at.wy)
    await page.mouse.wheel(0, at.dy)
    await page.waitForTimeout(120)
  }
  throw new Error('the wheel never brought the target into sight')
}

/** One task's card in a status section: the section opened, then "Show more" until it is drawn. */
async function sectionCard(page: Page, panel: Locator, key: 'needs' | 'waiting', id: string): Promise<Locator> {
  const toggle = panel.getByTestId(`status-section-${key}`).first().locator('button[aria-expanded]')
  await expect(toggle).toHaveCount(1, { timeout: 20_000 })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await wheelTo(page, toggle)
    await click(page, toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
  const card = panel.getByTestId(`status-section-${key}-rows`).first().locator(`[data-task-id="${id}"]`)
  const more = panel.getByTestId(`status-section-${key}-more`).first()
  for (let i = 0; i < 40 && (await card.count()) === 0 && (await more.count()) > 0; i++) {
    if (await more.isEnabled()) {
      await wheelTo(page, more)
      await click(page, more)
    }
    await card.waitFor({ state: 'attached', timeout: 1_500 }).catch(() => undefined)
  }
  await expect(card).toHaveCount(1, { timeout: 20_000 })
  await wheelTo(page, card)
  await expect(card).toBeVisible()
  return card
}

const needsLink = (card: Locator) => card.getByTestId('status-card-needs-line').locator(`.needs-line-text a.file-link[data-file-path="${doc}"]`).first()
const waitLink = (card: Locator) => card.getByTestId('status-card-reason').locator(`a.file-link[data-file-path="${doc}"]`).first()

async function expectRemoteText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Remote line two from fixture-remote', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Primary')
  await expect(viewer.locator('.file-viewer-host')).toContainText('SSH:')
}

async function expectPrimaryText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Primary line two', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Remote')
}

/** The row did nothing of its own: no conversation column opened, still Home. */
async function rowUntouched(page: Page, key: Key): Promise<void> {
  await page.waitForTimeout(400)
  await expect(sessionColumn(page, sids[key])).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')
}

/** Two frames and a pause: long enough for a late answer to open a viewer if it were going to. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 800)))))
}

// ── Tests ──

test('a Needs you ask a remote session wrote opens on that host on the first press and by Enter, never through the task\'s local session', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.remoteNeeds)
  const link = needsLink(card)
  await expect(link).toBeVisible()
  expect(net.lookups(), 'drawing the row reads no session').toBe(0)

  await click(page, link)
  await expectRemoteText(page)
  await closeFile(page)
  await rowUntouched(page, 'remoteNeeds')
  expect(net.lookups()).toBe(1)

  // The keyboard reaches the same link and opens the same machine, with the record the press read.
  await tabTo(page, page.locator('.todo-search-input'), link)
  await page.keyboard.press('Enter')
  await expectRemoteText(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)

  // Closed and opened again: still the writer's host.
  await click(page, link)
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.lookups(), 'later presses use the record the first one read').toBe(1)
  expect(net.primary(), 'nothing was read on this machine').toEqual([])
  expect(net.remote().some((f) => f.includes(`file-content host=${REMOTE} ${doc}`))).toBe(true)
})

test('a Waiting row a remote session wrote opens its path on that host', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'waiting', ids.remoteWait)
  const link = waitLink(card)
  await expect(link).toBeVisible()
  await click(page, link)
  await expectRemoteText(page)
  await closeFile(page)
  await rowUntouched(page, 'remoteWait')
  expect(net.lookups()).toBe(1)
  expect(net.primary()).toEqual([])
})

test('a person\'s ask opens on the primary with no session read, though the task runs elsewhere now', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.personNeeds)
  await click(page, needsLink(card))
  await expectPrimaryText(page)
  await closeFile(page)
  await rowUntouched(page, 'personNeeds')
  expect(net.lookups()).toBe(0)
  expect(net.remote(), 'nothing was asked of the remote host').toEqual([])
})

test('an ask whose writer Walnut did not record opens nothing on any host and says the source was not recorded', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.unknownNeeds)
  const link = needsLink(card)
  for (const press of ['pointer', 'Enter'] as const) {
    if (press === 'pointer') await click(page, link)
    else {
      await tabTo(page, page.locator('.todo-search-input'), link)
      await page.keyboard.press('Enter')
    }
    const failure = page.getByTestId('file-viewer-source-error')
    await expect(failure).toBeVisible({ timeout: 20_000 })
    await expect(failure).toContainText('did not record which session wrote')
    await expect(failure).toContainText('No file was read')
    await expect(failure).not.toContainText(/unavailable|retry|try again/i)
    await expect(failure).toHaveAttribute('role', 'status')
    await expect(page.getByTestId('file-viewer-source-retry')).toHaveCount(0)
    await settle(page)
    await page.keyboard.press('Escape')
    await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  }
  await rowUntouched(page, 'unknownNeeds')
  expect(net.lookups(), 'no session was read, the task\'s own included').toBe(0)
  expect(net.files(), 'nothing was looked up or read on either host').toEqual([])
})

test('a session read that fails reads no file and offers a retry; after closing, the next press opens the writer\'s host', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.remoteNeeds)
  net.gate.mode = 'down'
  await click(page, needsLink(card))
  const failure = page.getByTestId('file-viewer-source-error')
  await expect(failure).toBeVisible({ timeout: 20_000 })
  await expect(failure).toContainText("Couldn't open the path")
  await expect(failure).toContainText('No file was read')
  await expect(failure).toContainText('try again')
  await expect(failure).toHaveAttribute('role', 'alert')
  await expect(page.getByTestId('file-viewer-source-retry')).toBeVisible()
  await settle(page)
  expect(net.lookups()).toBe(1)
  expect(net.files(), 'nothing was looked up or read on either host').toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)

  net.gate.mode = 'pass'
  await click(page, needsLink(card))
  await expectRemoteText(page)
  await closeFile(page)
  expect(net.lookups()).toBe(2)
  expect(net.primary()).toEqual([])
})

test('Try again after a failed session read opens the writer\'s host with no second press on the link', async ({ page }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.remoteNeeds)
  net.gate.mode = 'down'
  await click(page, needsLink(card))
  await expect(page.getByTestId('file-viewer-source-error')).toBeVisible({ timeout: 20_000 })
  expect(net.files(), 'nothing was read before the retry').toEqual([])
  net.gate.mode = 'pass'
  await click(page, page.getByTestId('file-viewer-source-retry'))
  await expectRemoteText(page)
  expect(net.lookups()).toBe(2)
  expect(net.primary()).toEqual([])
  await closeFile(page)
})

test('a session read still out when a person rewrites the ask opens nothing late; the new words open on the primary', async ({ page, request }) => {
  const panel = await homeWithStatusLines(page)
  const card = await sectionCard(page, panel, 'needs', ids.heldNeeds)
  net.gate.mode = 'hold'
  await click(page, needsLink(card))
  await expect.poll(() => net.gate.held, { timeout: 20_000 }).toBe(1)

  // A person rewrites the ask through the real route while the read is out: its writer is now theirs.
  await setReport(request, ids.heldNeeds, { state: 'needs', ask: `Read ${doc}:3 instead` },
    (s) => s.state === 'needs' && String(s.ask ?? '').includes('instead') && s.askBy === 'human')
  await expect(card.getByTestId('status-card-needs-line')).toContainText('instead', { timeout: 30_000 })

  const late = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${REMOTE_SID}`)
  net.gate.release()
  expect((await late).ok()).toBe(true)
  await settle(page)
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  expect(net.files(), 'the late answer opened nothing').toEqual([])

  await click(page, needsLink(card))
  await expectPrimaryText(page)
  await closeFile(page)
  expect(net.lookups(), 'the person\'s words read no session').toBe(1)
  expect(net.remote(), 'the remote host was never read').toEqual([])
})
