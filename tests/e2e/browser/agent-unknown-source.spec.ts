// A path in agent words whose writer Walnut never recorded (an older summary): the press never asks
// the person which machine; Walnut asks every machine itself (`locate?anywhere=1`, no host) and opens
// the file where it is found, or says in one line that no machine has it. Nothing is read on mount.
//
// Real: the fixture server, a project whose AI summary names two files (the project detail pane
// draws it as text of unknown source), the renderer, the opener and the viewer.
// Mocked at the host boundary only: the remote host's status and locate answer (the fixture
// disables SSH hosts and serves no remote file bytes).
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { AGENT_TEXT_BASE as base, click, closeFile, expectImage, expectNoMachineChoice, expectText, expectViewerFillsPanel, openApp, showPointer } from './agent-text-entry-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs, openProjectDetails, presetPanelView } from './todo-panel-helpers'

const REMOTE = 'fixture-remote'
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const project = `unknownsrc${stamp}`
const TEXT = 'Unknown source notes\nLine two from this machine\nLine three\n'
const asset = (name: string) => fileURLToPath(new URL(`../../../web/public/${name}`, import.meta.url))
let dir = ''
let doc = ''
let picture = ''
let taskId = ''

test.describe.configure({ mode: 'default' })
test.setTimeout(180_000)
test.use({ baseURL: base, viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })

async function ok(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string): Promise<any> {
  const text = await res.text()
  expect(res.ok(), `${what}: ${res.status()} ${text}`).toBe(true)
  return text ? JSON.parse(text) : null
}

test.beforeAll(async ({ request }) => {
  if (new URL(base).port === '3456') throw new Error('These checks write a project: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(Number(new URL(base).port))
  await fs.mkdir('/tmp/agent-session-source', { recursive: true })
  dir = path.join(fixtureRoot, 'projects', 'walnut', `unknown-source-${stamp}`)
  doc = path.join(dir, 'notes.txt')
  picture = path.join(dir, 'design.png')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(doc, TEXT)
  await fs.copyFile(asset('icon-192.png'), picture)
  const created = await ok(await request.post('/api/tasks', { data: { title: `Unknown source member ${stamp}`, project, source: 'local', pinned: false } }), 'task')
  taskId = created.task.id
  // An AI summary carries no record of its writer: the detail pane draws it as unknown source.
  await ok(await request.put(`/api/projects/${encodeURIComponent(project)}/metadata`, { data: { summary: `Notes ${doc}\n\n<a href="${doc}:2">Raw notes</a>\n\nDesign ${picture}\n\n${imageMarkup(picture)}` } }), 'summary')
  const record = await ok(await request.get('/api/sessions/pw-limits-remote-session'), 'remote fixture session')
  expect(record.session.host).toBe(REMOTE)
})

test.afterAll(async ({ request }) => {
  if (taskId) await request.delete(`/api/tasks/${taskId}?force=true`).catch(() => {})
  await request.delete(`/api/projects/${encodeURIComponent(project)}`).catch(() => {})
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

// ── What the page asked for the seeded files ──

const FILE_API = /^\/api\/(?:file-content$|(?:v1\/)?file-raw\/|local-image$|file-history(?:\/|$)|(?:v1\/)?files\/(?:locate|list|list-many|exists)$)/
type Touch = { api: string; host: string; path: string; sourceOnly: boolean; anywhere: boolean; hostAsked: boolean; taskId: string | null }

function touchOf(req: Request): Touch | null {
  const url = new URL(req.url())
  if (!FILE_API.test(url.pathname)) return null
  if (/^\/api\/(?:v1\/)?file-raw\//.test(url.pathname)) {
    const segment = url.pathname.startsWith('/api/v1/') ? 4 : 3
    const [host, ...rest] = url.pathname.split('/').slice(segment)
    return { api: 'file-raw', host: decodeURIComponent(host!), path: '/' + rest.map(decodeURIComponent).join('/'), sourceOnly: false, anywhere: false, hostAsked: true, taskId: null }
  }
  let body: { paths?: string[]; host?: string } = {}
  if (req.method() === 'POST') { try { body = req.postDataJSON() ?? {} } catch { /* not JSON */ } }
  const q = url.searchParams
  const target = q.get('ref') ?? q.get('path') ?? body.paths?.find((p) => p.startsWith(dir)) ?? ''
  return { api: url.pathname.replace('/api/', ''), host: q.get('host') ?? body.host ?? 'local', path: target, sourceOnly: q.get('sourceOnly') === '1', anywhere: q.get('anywhere') === '1', hostAsked: q.has('host') || !!body.host, taskId: q.get('taskId') }
}

let seen: Touch[] = []
let errors: string[] = []

test.beforeEach(async ({ page }) => {
  seen = []
  errors = []
  // The fixture disables SSH hosts, so a read-only host-status stand-in offers this known machine.
  await page.route('**/api/hosts/status', async (route) => {
    const reply = await route.fetch()
    const body = await reply.json()
    await route.fulfill({ response: reply, json: { ...body, hosts: [...(body.hosts ?? []), { host: REMOTE, label: 'Big remote host', connected: false, phase: 'off', at: Date.now() }] } })
  })
  await showPointer(page)
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  page.on('request', (r) => { const t = touchOf(r); if (t && t.path.startsWith(dir)) seen.push(t) })
  page.on('pageerror', (e) => errors.push(e.message))
})

test.afterEach(() => {
  expect(errors, 'no page error').toEqual([])
})

async function openSummary(page: Page): Promise<Locator> {
  await openApp(page)
  const pane = await openProjectDetails(page, project)
  const summary = pane.locator('.detail-memory-text[data-agent-text]')
  await expect(summary).toContainText('Notes', { timeout: 20_000 })
  return summary
}

const linkTo = (scope: Locator, p: string) => scope.locator(`a.file-link[data-file-path="${p}"]`).first()

function imageMarkup(src: string): string {
  return [
    `<img src="${src}" alt="Raw design">`,
    `<svg><image href="${src}" alt="SVG design"/></svg>`,
    `<svg><filter><feImage href="${src}" alt="Filter design"/></filter></svg>`,
    `<picture><source srcset="${src}"><img src="${src}" alt="Responsive design"></picture>`,
    `<video poster="${src}"></video>`,
    `<input type="image" src="${src}">`,
    `<table background="${src}"><tr><td>Background</td></tr></table>`,
    `<div style="background-image:url('${src}')">CSS background</div>`,
    `<img src="http://127.0.0.1:3457/api/local-image?path=${encodeURIComponent(src)}&amp;host=local" alt="Alias design">`,
    `<svg><use href="/api/file-history/version?path=${encodeURIComponent(src)}&amp;host=local&amp;id=fixture"/></svg>`,
    `<video src="/api/v1/file-raw/local${src}"></video>`,
    `<div style="background-image:url('/api/files/list?path=${encodeURIComponent(src)}&amp;host=local')">File list</div>`,
  ].join('\n\n')
}

/** Two frames and a pause: long enough for any lookup a press would start. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 800)))))
}

/** The locates of this press: every one asks every machine (anywhere), none names a host or one machine alone. */
function expectAskedAnywhere(): Touch[] {
  const locates = seen.filter((t) => t.api === 'files/locate')
  expect(locates.length).toBeGreaterThan(0)
  expect(locates.every((t) => t.anywhere && !t.hostAsked && !t.sourceOnly), 'every machine was asked, none named').toBe(true)
  return locates
}

// ── Tests ──

test('an unknown-source path opens at once where Walnut finds it, without asking which machine, and every press does the same', async ({ page }) => {
  const summary = await openSummary(page)
  await settle(page)
  expect(seen, 'drawing the summary read no file').toEqual([])
  await click(page, linkTo(summary, doc))
  await expectText(page, 'Line two from this machine')
  await expectNoMachineChoice(page)
  expectAskedAnywhere()
  expect(seen.some((t) => t.api === 'file-content' && t.path === doc && t.host === 'local'), 'the file was read here').toBe(true)
  expect(seen.filter((t) => t.host === REMOTE), 'the remote host was never asked').toEqual([])
  await closeFile(page)

  // The same path again, with a line: nothing is remembered and nothing is asked of the person.
  seen = []
  const raw = summary.locator('a.file-link').filter({ hasText: 'Raw notes' });
  await expect(raw).toHaveAttribute('data-file-path', doc);
  await expect(raw).toHaveAttribute('data-file-line', '2');
  await click(page, raw);
  await expectText(page, 'Line two from this machine')
  await expect(page.locator('.file-viewer-line')).toHaveText(':2')
  await expectViewerFillsPanel(page)
  await expectNoMachineChoice(page)
  expectAskedAnywhere()
  await closeFile(page)
})

test('an unknown-source picture never loads by itself; a press shows the picture from the machine that has it', async ({ page }) => {
  const summary = await openSummary(page)
  await expect(summary.locator('img'), 'unknown source draws the picture as a link').toHaveCount(0)
  const raw = summary.locator(`a.file-link[data-file-path="${picture}"]`).filter({ hasText: 'Raw design' })
  await expect(raw, 'the raw HTML image also stays a file link').toBeVisible()
  for (const label of ['SVG design', 'Filter design', 'Responsive design', 'Alias design']) {
    await expect(summary.locator(`a.file-link[data-file-path="${picture}"]`).filter({ hasText: label }), label).toHaveCount(1)
  }
  await expect(summary.locator('image, feImage, [src], [srcset], [poster], [background], [style]'), 'no image-loading attribute remains').toHaveCount(0)
  await settle(page)
  expect(seen, 'drawing the summary read no file').toEqual([])
  await click(page, raw)
  await expectImage(page)
  await expectNoMachineChoice(page)
  expectAskedAnywhere()
  await page.screenshot({ path: '/tmp/agent-session-source/unknown-picture-opened.png' })
  await page.waitForTimeout(500)
  const image = page.locator('.file-viewer-overlay img').first()
  await expect(image).not.toHaveAttribute('src', new RegExp(REMOTE))
  expect(seen.filter((t) => t.host === REMOTE)).toEqual([])
  await closeFile(page)
})

test('a path no machine has says so in one line, offers no machine to pick, and the next press asks again', async ({ page }) => {
  const asked: URL[] = []
  const answer = async (route: Route) => {
    const url = new URL(route.request().url())
    asked.push(url)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: doc, found: false, missing: true, checked: ['This machine', 'Big remote host'] }) })
  }
  const match = (url: URL) => url.pathname === '/api/files/locate' && url.searchParams.get('anywhere') === '1'
  await page.route(match, answer)
  const summary = await openSummary(page)
  await click(page, linkTo(summary, doc))
  const missing = page.getByTestId('file-viewer-missing')
  await expect(missing).toBeVisible({ timeout: 20_000 })
  await expect(missing).toHaveText(`Couldn't find ${doc} on This machine or Big remote host.`)
  await expectNoMachineChoice(page)
  expect(asked).toHaveLength(1)
  expect(asked[0]!.searchParams.get('ref')).toBe(doc)
  expect(asked[0]!.searchParams.has('host'), 'no machine named').toBe(false)
  expect(asked[0]!.searchParams.has('sourceOnly'), 'not one machine alone').toBe(false)
  await settle(page)
  expect(seen.filter((t) => t.api !== 'files/locate'), 'nothing was read on any machine').toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  await page.unroute(match, answer)

  // A press after the file shows up asks again and opens it: a miss is never remembered.
  await click(page, linkTo(summary, doc))
  await expectText(page, 'Line two from this machine')
  await expectNoMachineChoice(page)
  await closeFile(page)
})

test('a machine that did not answer is named beside the miss, Try again asks every machine once more, and the file opens when it is found', async ({ page }) => {
  const asked: URL[] = []
  const silent = async (route: Route) => {
    asked.push(new URL(route.request().url()))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: doc, found: false, missing: true, checked: ['This machine'], unreachable: ['Big remote host'] }) })
  }
  const match = (url: URL) => url.pathname === '/api/files/locate' && url.searchParams.get('anywhere') === '1'
  await page.route(match, silent)
  const summary = await openSummary(page)
  await click(page, linkTo(summary, doc))
  const missing = page.getByTestId('file-viewer-missing')
  await expect(missing).toHaveText(`Couldn't find ${doc} on This machine. Big remote host did not answer, so the file may be there.`, { timeout: 20_000 })
  await expectNoMachineChoice(page)
  const again = page.getByTestId('file-viewer-try-again')
  await expect(again).toBeVisible()
  expect(asked).toHaveLength(1)
  // The host answers now: Try again asks every machine once more, still naming none, and opens the file.
  await page.unroute(match, silent)
  await click(page, again)
  await expectText(page, 'Line two from this machine')
  await expect(page.getByTestId('file-viewer-try-again')).toHaveCount(0)
  await expectNoMachineChoice(page)
  const locates = expectAskedAnywhere()
  expect(locates.length).toBeGreaterThan(0)
  await closeFile(page)
})
