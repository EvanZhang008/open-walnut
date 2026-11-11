// A path in agent words whose writer Walnut never recorded (an older summary): the press reads no
// file anywhere and says so, and offers this machine and every known host as explicit choices.
// Only the machine the person names is asked, and only it (`sourceOnly`); nothing is read before.
//
// Real: the fixture server, a project whose AI summary names two files (the project detail pane
// draws it as text of unknown source), the renderer, the opener and the viewer.
// Mocked at the host boundary only: the remote host's status and locate answer (the fixture
// disables SSH hosts and serves no remote file bytes).
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page, type Request, type Route } from '@playwright/test'
import { AGENT_TEXT_BASE as base, click, closeFile, expectImage, expectText, expectViewerFillsPanel, openApp, showPointer } from './agent-text-entry-helpers'
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
type Touch = { api: string; host: string; path: string; sourceOnly: boolean }

function touchOf(req: Request): Touch | null {
  const url = new URL(req.url())
  if (!FILE_API.test(url.pathname)) return null
  if (/^\/api\/(?:v1\/)?file-raw\//.test(url.pathname)) {
    const segment = url.pathname.startsWith('/api/v1/') ? 4 : 3
    const [host, ...rest] = url.pathname.split('/').slice(segment)
    return { api: 'file-raw', host: decodeURIComponent(host!), path: '/' + rest.map(decodeURIComponent).join('/'), sourceOnly: false }
  }
  let body: { paths?: string[]; host?: string } = {}
  if (req.method() === 'POST') { try { body = req.postDataJSON() ?? {} } catch { /* not JSON */ } }
  const q = url.searchParams
  const target = q.get('ref') ?? q.get('path') ?? body.paths?.find((p) => p.startsWith(dir)) ?? ''
  return { api: url.pathname.replace('/api/', ''), host: q.get('host') ?? body.host ?? 'local', path: target, sourceOnly: q.get('sourceOnly') === '1' }
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

/** The press shows the error and the choices, and reads nothing on any host. */
async function expectChoices(page: Page): Promise<Locator> {
  const failure = page.getByTestId('file-viewer-source-error')
  await expect(failure).toBeVisible({ timeout: 20_000 })
  await expect(failure).toContainText('No file was read')
  const choice = page.getByTestId('file-source-choice')
  await expect(choice).toContainText('Choose a machine')
  await expect(choice.getByTestId('file-source-local')).toHaveText('Local')
  await expect(choice.locator(`[data-testid="file-source-host"][data-host="${REMOTE}"]`)).toBeVisible()
  await expect(choice.locator('select')).toHaveCount(0)
  await expect(choice.getByTestId('file-source-local')).toHaveAttribute('aria-pressed', 'false')
  await settle(page)
  expect(seen, 'nothing was looked up or read before a machine was named').toEqual([])
  return choice
}

// ── Tests ──

test('an unknown-source path reads nothing until Local is chosen; the same path then opens there at once, says whose choice it was, and one press undoes it', async ({ page }) => {
  const summary = await openSummary(page)
  await click(page, linkTo(summary, doc))
  const choice = await expectChoices(page)
  await click(page, choice.getByTestId('file-source-local'))
  await expectText(page, 'Line two from this machine')
  await expect(page.getByTestId('file-viewer-source-error')).toHaveCount(0)
  const locates = seen.filter((t) => t.api === 'files/locate')
  expect(locates.length).toBeGreaterThan(0)
  expect(locates.every((t) => t.sourceOnly && t.host === 'local'), 'Local asked this machine only').toBe(true)
  expect(seen.some((t) => t.api === 'file-content' && t.path === doc && t.host === 'local'), 'the file was read here').toBe(true)
  expect(seen.filter((t) => t.host === REMOTE), 'the remote host was never asked').toEqual([])
  await closeFile(page)

  // The same path in this tab opens on the machine the person named, and says so: Walnut guessed
  // nothing, and the person is not asked the same question on every press.
  seen = []
  const raw = summary.locator('a.file-link').filter({ hasText: 'Raw notes' });
  await expect(raw).toHaveAttribute('data-file-path', doc);
  await expect(raw).toHaveAttribute('data-file-line', '2');
  await click(page, raw);
  await expectText(page, 'Line two from this machine')
  await expect(page.locator('.file-viewer-line')).toHaveText(':2')
  await expect(page.getByTestId('file-viewer-remembered')).toContainText('the machine you chose for this path before')
  await expectViewerFillsPanel(page)
  await expect(page.getByTestId('file-viewer-source-error')).toHaveCount(0)
  expect(seen.filter((t) => t.host === REMOTE), 'the remote host was never asked').toEqual([])
  await closeFile(page)

  // One press undoes it: nothing is read, and the choice is the person's again.
  seen = []
  await click(page, raw)
  await click(page, page.getByTestId('file-viewer-choose-another'))
  seen = []
  await expectChoices(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
  // After the undo the path asks again.
  await click(page, raw)
  await expectChoices(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.file-viewer-overlay')).toHaveCount(0)
})

test('an unknown-source picture never loads by itself; Local shows this machine\'s picture', async ({ page }) => {
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
  const choice = await expectChoices(page)
  await page.screenshot({ path: '/tmp/agent-session-source/unknown-picture-choices.png' })
  await click(page, choice.getByTestId('file-source-local'))
  await expectImage(page)
  await page.screenshot({ path: '/tmp/agent-session-source/unknown-picture-opened.png' })
  await page.waitForTimeout(500)
  const image = page.locator('.file-viewer-overlay img').first()
  await expect(image).not.toHaveAttribute('src', new RegExp(REMOTE))
  expect(seen.filter((t) => t.host === REMOTE)).toEqual([])
  await closeFile(page)
})

test('a named remote host is asked alone; its miss reads nothing here and keeps the choices for another machine', async ({ page }) => {
  const remoteLocates: URL[] = []
  const answer = async (route: Route) => {
    const url = new URL(route.request().url())
    remoteLocates.push(url)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: doc, host: REMOTE, found: false, missing: true, checked: ['Big remote host'] }) })
  }
  const match = (url: URL) => url.pathname === '/api/files/locate' && url.searchParams.get('host') === REMOTE
  await page.route(match, answer)
  const summary = await openSummary(page)
  await click(page, linkTo(summary, doc))
  const choice = await expectChoices(page)
  await click(page, choice.locator(`[data-testid="file-source-host"][data-host="${REMOTE}"]`))
  await expect(page.getByTestId('file-viewer-missing')).toContainText('Couldn\'t find')
  expect(remoteLocates).toHaveLength(1)
  expect(remoteLocates[0]!.searchParams.get('sourceOnly')).toBe('1')
  expect(remoteLocates[0]!.searchParams.get('ref')).toBe(doc)
  expect(seen.filter((t) => t.host !== REMOTE), 'nothing was asked on this machine').toEqual([])
  const kept = page.getByTestId('file-source-choice')
  await expect(kept.locator(`[data-host="${REMOTE}"]`)).toHaveAttribute('aria-pressed', 'true')
  await page.unroute(match, answer)

  await click(page, kept.getByTestId('file-source-local'))
  await expectText(page, 'Line two from this machine')
  await closeFile(page)
})
