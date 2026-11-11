/**
 * A path in a kanban card's summary or waiting on opens where Walnut recorded those words were
 * written, never through the card task's current session (2026-11-07: both handed AgentText the
 * task's session, so words an older session wrote on another machine opened this machine's file).
 *
 * Real: the fixture server and the kanban team (board-kanban-fixture.ts), PUT
 * /api/v1/tasks/:leader/board/cards/:task (a session's write carries `x-walnut-caller-sid`, which the
 * route resolves and stores beside the words; a person's carries none; an unresolved header stores
 * no session), the card, the opened card (narrow), the renderer, the opener and the viewer. Every
 * card task runs a LOCAL session now, while the words were written by `pw-limits-remote-session`
 * (host `fixture-remote`). Mocked at the host boundary only (page.route): the remote host's file
 * answers and its entry in the host list (the fixture disables SSH hosts and serves no remote bytes).
 * The same absolute path on this machine holds different bytes, so a wrong pick shows the primary's.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, leaveFullscreen } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, pickCardsView, pollUntil, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'
import { keepCornerToBoard } from './board-kanban-corner'
import { click, closeFile, openSessionBoard, setReport } from './agent-text-entry-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const REMOTE = 'fixture-remote'
const REMOTE_SID = 'pw-limits-remote-session'
const stamp = Date.now().toString(36)
const PRIMARY_TEXT = 'Primary copy\nPrimary line two\nPrimary line three\n'
const REMOTE_TEXT = 'Remote copy\nRemote line two from fixture-remote\nRemote line three\n'
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam
let dir = '', doc = ''
// One card per writer: the remote session's summary and waiting on, a person's summary, an unresolved writer's summary,
// and two status lines set through the task's own report route (the remote session's ask, an unresolved writer's ask).
let remoteCard = '', waitCard = '', personCard = '', unknownCard = '', askCard = '', unknownAskCard = ''

test.use({ baseURL: API, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

const cardsPath = (id: string) => `/api/v1/tasks/${team.leader}/board/cards/${id}`
type CardView = { summary?: string; summary_by?: string; summary_session_id?: string; waiting_on?: string; waiting_on_session_id?: string }
const storedCard = async (id: string): Promise<CardView> =>
  ((await call<{ cards?: Record<string, CardView> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?fields=kanban`)).cards ?? {})[id] ?? {}

test.beforeAll(async ({ request }, info) => {
  test.setTimeout(600_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine: info.project.name, litter })
  // This spec's own short temp dir, so `CR <path>:2` fits a waiting on (80 characters) on every OS.
  // macOS's os.tmpdir() (/var/folders/.../T) is itself long: use /tmp there.
  dir = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'ks-'))
  doc = path.join(dir, 'n.txt')
  expect(`CR ${doc}:2`.length, `the waiting on fits its 80 characters: ${doc}`).toBeLessThanOrEqual(80)
  await fs.writeFile(doc, PRIMARY_TEXT)
  const record = await call<{ session: { host?: string; taskId?: string } }>(api, 'GET', `/api/sessions/${REMOTE_SID}`)
  expect(record.session.host, 'the writer runs on the remote host').toBe(REMOTE)
  expect(record.session.taskId, 'the writer keeps its own task, outside this team').toBe('pw-task-remote-writer')
  ;[remoteCard, waitCard, personCard, unknownCard, askCard, unknownAskCard] = team.idle
  for (const id of [remoteCard, waitCard, personCard, unknownCard, askCard, unknownAskCard]) {
    const sid = team.sessions[id]
    expect(sid, 'each card task runs a session of its own').toBeTruthy()
    const now = await call<{ session: { host?: string } }>(api, 'GET', `/api/sessions/${sid}`)
    expect(sid).not.toBe(REMOTE_SID)
    expect(['', 'local', '__local__', undefined]).toContain(now.session.host)
  }
  const asRemote = { 'x-walnut-caller-sid': REMOTE_SID }
  await call(api, 'PUT', cardsPath(remoteCard), { summary: `Read ${doc}:2 first` }, asRemote)
  await call(api, 'PUT', cardsPath(waitCard), { lane: 'waiting-cr', waiting_on: `CR ${doc}:2` }, asRemote)
  await call(api, 'PUT', cardsPath(personCard), { summary: `Mine: ${doc}:2` })
  // A body naming a session is never read; a header Walnut cannot resolve stores none.
  await call(api, 'PUT', cardsPath(unknownCard), { summary: `Nobody: ${doc}:2`, summary_session_id: REMOTE_SID },
    { 'x-walnut-caller-sid': `pw-kanban-nobody-${stamp}` })
  // The status lines: the real report route and status sync, no stand-in for the status.
  await setReport(request, askCard, { state: 'needs', ask: `${doc}:2 first` },
    (us) => us.state === 'needs' && String(us.ask ?? '').includes(doc) && us.askSessionId === REMOTE_SID && us.askBy !== 'human', asRemote)
  await setReport(request, unknownAskCard, { state: 'needs', ask: `${doc}:2 nobody` },
    (us) => us.state === 'needs' && String(us.ask ?? '').includes(doc) && !us.askSessionId, { 'x-walnut-caller-sid': `pw-kanban-nobody-${stamp}` })
  await pollUntil('the writers stored', async () => Promise.all([remoteCard, waitCard, personCard, unknownCard].map(storedCard)),
    ([r, w, p, u]) => r.summary_session_id === REMOTE_SID && w.waiting_on_session_id === REMOTE_SID
      && p.summary_by === 'human' && !p.summary_session_id && u.summary_by === 'agent' && !u.summary_session_id)
})

test.beforeEach(async ({ context }) => { await pickCardsView(context, team.leader); await keepCornerToBoard(context) })

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

// ── The remote host's answers and what the page asked ──

const FILE_API = /^\/api\/(?:file-content$|file-raw\/|local-image$|files\/(?:locate|list|list-many|exists)$)/
const LOCAL = new Set(['', 'local', '__local__'])
type Touch = { api: string; host: string; path: string; method: string }

function touchOf(req: Request): Touch | null {
  const url = new URL(req.url())
  if (!FILE_API.test(url.pathname)) return null
  if (url.pathname.startsWith('/api/file-raw/')) {
    const [, , , host, ...rest] = url.pathname.split('/')
    return { api: 'file-raw', host: decodeURIComponent(host!), path: '/' + rest.map(decodeURIComponent).join('/'), method: req.method() }
  }
  let body: { paths?: string[]; host?: string } = {}
  if (req.method() === 'POST') { try { body = req.postDataJSON() ?? {} } catch { /* not JSON */ } }
  const q = url.searchParams
  const target = q.get('ref') ?? q.get('path') ?? body.paths?.find((p) => p === doc || p === dir) ?? ''
  return { api: url.pathname.replace('/api/', ''), host: q.get('host') ?? body.host ?? 'local', path: target, method: req.method() }
}

function listing(p: string) {
  const entries = (d: string) => (path.dirname(doc) === d ? [{ name: path.basename(doc), type: 'file', size: Buffer.byteLength(REMOTE_TEXT) }] : [])
  if (p === doc) return { path: path.dirname(p), entries: entries(path.dirname(p)), selectedFile: path.basename(p) }
  return { path: p, entries: entries(p) }
}

async function remoteHost(route: Route): Promise<void> {
  const t = touchOf(route.request())
  if (!t || t.host !== REMOTE) return route.fallback()
  const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  const p = t.path
  switch (t.api) {
    case 'files/locate':
      return json(p === doc ? { path: p, host: REMOTE, hostName: 'Big remote host', found: true } : { path: p, host: REMOTE, found: false, missing: true, checked: ['Big remote host'] })
    case 'files/list': return json(listing(p))
    case 'files/list-many': return json({ listings: ((route.request().postDataJSON()?.paths ?? []) as string[]).map(listing), truncated: false, timedOut: false })
    case 'files/exists': return json({ exists: Object.fromEntries(((route.request().postDataJSON()?.paths ?? []) as string[]).map((x) => [x, x === doc])) })
    case 'file-content':
      if (p !== doc) return json({ content: null, size: 0, truncated: false, binary: false, error: 'File not found', extension: path.extname(p).slice(1) })
      return json({ content: REMOTE_TEXT, size: Buffer.byteLength(REMOTE_TEXT), truncated: false, binary: false, extension: 'txt', contentHash: createHash('sha256').update(REMOTE_TEXT).digest('hex') })
    default: return route.fallback()
  }
}

let seen: Request[] = []
let errors: string[] = []
const touches = () => seen.map(touchOf).filter((t): t is Touch => !!t && (t.path === doc || t.path === dir))
const primaryReads = () => touches().filter((t) => LOCAL.has(t.host)).map((t) => `${t.method} ${t.api} ${t.path}`)
const remoteReads = () => touches().filter((t) => t.host === REMOTE).map((t) => `${t.method} ${t.api} ${t.path}`)
const sessionReads = (sid: string) => seen.filter((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/sessions/${sid}`).length

test.beforeEach(async ({ page }) => {
  seen = []
  errors = []
  page.on('request', (r) => seen.push(r))
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route((url) => FILE_API.test(url.pathname), remoteHost)
  // The fixture disables SSH hosts: a read-only host-status stand-in offers the remote machine to choose.
  await page.route('**/api/hosts/status', async (route) => {
    const reply = await route.fetch()
    const body = await reply.json()
    await route.fulfill({ response: reply, json: { ...body, hosts: [...(body.hosts ?? []), { host: REMOTE, label: 'Big remote host', connected: false, phase: 'off', at: Date.now() }] } })
  })
})

test.afterEach(() => { expect(errors, 'no page error').toEqual([]) })

// ── Steps ──

/** Real navigation by link click (never page.goto), then the leader's Board, Cards view. */
async function openBoard(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: team.project })
  await leaveFullscreen(page)
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  await leaveFullscreen(page)
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const pane = await openSessionBoard(page, panel)
  await pane.getByTestId('board-view-cards').click()
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const linkIn = (scope: Locator) => scope.locator(`a.file-link[data-file-path="${doc}"]`).first()

async function expectRemoteText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Remote line two from fixture-remote', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Primary')
}

async function expectPrimaryText(page: Page): Promise<void> {
  const viewer = page.locator('.file-viewer-overlay')
  await expect(viewer.locator('.cm-content')).toContainText('Primary line two', { timeout: 30_000 })
  await expect(viewer.locator('.cm-content')).not.toContainText('Remote')
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 800)))))
}

// ── Tests ──

test('a card summary a remote session wrote opens on that host, never through the task\'s local session; the card stays folded', async ({ page }) => {
  const pane = await openBoard(page)
  const summary = card(pane, remoteCard).getByTestId('kanban-card-summary')
  await summary.scrollIntoViewIfNeeded()
  const link = linkIn(summary)
  await expect(link).toBeVisible({ timeout: 30_000 })
  await click(page, link)
  await expectRemoteText(page)
  await closeFile(page)
  // The link took the click: the summary around it did not unfold.
  await expect(summary).not.toHaveAttribute('data-expanded', 'true')
  expect(sessionReads(REMOTE_SID), 'the writer\'s record was read once, on the click').toBe(1)
  expect(sessionReads(team.sessions[remoteCard]!), 'the task\'s current session was never asked').toBe(0)
  expect(primaryReads(), 'nothing was read on this machine').toEqual([])
})

test('a waiting on a remote session wrote opens on that host', async ({ page }) => {
  const pane = await openBoard(page)
  const waiting = card(pane, waitCard).getByTestId('kanban-card-waiting')
  await waiting.scrollIntoViewIfNeeded()
  await click(page, linkIn(waiting))
  await expectRemoteText(page)
  await closeFile(page)
  expect(sessionReads(team.sessions[waitCard]!)).toBe(0)
  expect(primaryReads()).toEqual([])
})

test('the opened card (narrow) opens its summary\'s path on the writer\'s host; a person\'s words open here with no session read', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 })
  const pane = await openBoard(page)
  await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
  for (const [id, remote] of [[remoteCard, true], [personCard, false]] as const) {
    seen = []
    const c = card(pane, id)
    await c.scrollIntoViewIfNeeded()
    await c.getByTestId('kanban-card-title').click()
    const detail = pane.getByTestId('kanban-card-detail')
    await expect(detail).toBeVisible()
    await click(page, linkIn(detail.getByTestId('kanban-detail-summary')))
    if (remote) {
      await expectRemoteText(page)
      expect(primaryReads()).toEqual([])
    } else {
      await expectPrimaryText(page)
      expect(sessionReads(REMOTE_SID), 'a person\'s words read no session').toBe(0)
      expect(remoteReads(), 'the remote host was never asked').toEqual([])
    }
    // Opening this detail also mounts its current session; its record reads are not file-source lookups.
    await expect(detail.getByTestId('kanban-detail-session')).toHaveAttribute('data-session-id', team.sessions[id]!)
    await closeFile(page)
    await pane.getByTestId('kanban-detail-back').click()
    await expect(detail).toHaveCount(0)
  }
})

test('a status ask a remote session wrote opens on that host, never through the task\'s local session', async ({ page }) => {
  const pane = await openBoard(page)
  const status = card(pane, askCard).getByTestId('kanban-card-status')
  await status.scrollIntoViewIfNeeded()
  await expect(status).toHaveAttribute('data-tone', 'red')
  await click(page, linkIn(status))
  await expectRemoteText(page)
  await closeFile(page)
  expect(sessionReads(REMOTE_SID)).toBe(1)
  expect(sessionReads(team.sessions[askCard]!), 'the task\'s current session was never asked').toBe(0)
  expect(primaryReads()).toEqual([])
})

for (const [slot, which] of [['summary', () => unknownCard], ['status ask', () => unknownAskCard]] as const) test(`a ${slot} whose writer was not recorded reads nothing and offers the machines; Local opens this machine's file`, async ({ page }) => {
  const id = which()
  const pane = await openBoard(page)
  const words = card(pane, id).getByTestId(slot === 'summary' ? 'kanban-card-summary' : 'kanban-card-status')
  await words.scrollIntoViewIfNeeded()
  await click(page, linkIn(words))
  const failure = page.getByTestId('file-viewer-source-error')
  await expect(failure).toBeVisible({ timeout: 20_000 })
  await expect(failure).toContainText('No file was read')
  const choice = page.getByTestId('file-source-choice')
  await expect(choice).toContainText('Choose a machine')
  await expect(choice.locator(`[data-testid="file-source-host"][data-host="${REMOTE}"]`)).toBeVisible()
  await settle(page)
  expect(touches(), 'nothing was looked up or read before a machine was named').toEqual([])
  expect(sessionReads(team.sessions[id]!), 'the task\'s current session is no stand-in').toBe(0)
  expect(sessionReads(REMOTE_SID), 'the session the body named is not the writer').toBe(0)
  await click(page, choice.getByTestId('file-source-local'))
  await expectPrimaryText(page)
  expect(remoteReads()).toEqual([])
  await closeFile(page)
})
