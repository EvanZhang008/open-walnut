/**
 * Start a new task from a project (experiment project_first_start) in the browser: with the
 * experiment off the draft's row is today's; on, a "Project" pill leads it, a project with a
 * code source (a git checkout, a plugin provider with a list of packages) replaces the folder
 * pill with a host pill and value chips, and Start files a task whose workspace the host makes
 * from the source. "Choose a folder instead" is today's folder picker, "Set up source…" the
 * project's settings, whose "Code source" section saves a source that is there after a reload.
 *
 * Real UI, real server, the MockDaemon running the real workspace core (real `git worktree`,
 * the fake multi-repo plugin provider); only the Claude CLI is mocked. Needs the workspace
 * fixture, on its own port:
 *
 *   PW_WORKSPACE_FIXTURE=1 PW_TEST_PORT=3516 ./node_modules/.bin/playwright test tests/e2e/browser/project-first-start.spec.ts --project=chromium
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { draftComposer, draftPanel, openDraft } from './draft-helpers'
import { isolateUiPrefs, openProjectDetails, presetPanelView } from './todo-panel-helpers'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/project-first-start'

test.skip(process.env.PW_WORKSPACE_FIXTURE !== '1', 'needs PW_WORKSPACE_FIXTURE=1 on its own PW_TEST_PORT')
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
// One after another: the experiment is a server-wide setting.
test.describe.configure({ mode: 'default' })

let home = ''
const stamp = Date.now().toString(36)
const MARINA = `Marina ${stamp}`
const ACME = `Acme ${stamp}`
const LIFE = `Life ${stamp}`
const GONE = `Acme gone ${stamp}`
const APP = (): string => path.join(home, 'ws-fixture', 'app')

interface Ws { state: string; provider: string; root?: string; inputs?: Record<string, unknown>; repos?: Array<{ name?: string }> }

test.beforeAll(async ({ request }) => {
  ;({ walnutHome: home } = await discoverBrowserFixture(PORT))
  const real = fs.realpathSync(home)
  if (!real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error(`fixture home ${home} is not a temp dir`)
  fs.mkdirSync(SHOTS, { recursive: true })
  await makeProject(request, MARINA, { workspace_source: { provider: 'git-worktree', anchor: path.join(home, 'ws-fixture', 'app') } })
  await makeProject(request, ACME, {
    default_cwd: path.join(home, 'ws-fixture', 'multi'),
    workspace_source: { provider: 'fake-multirepo', inputs: { packages: ['alpha', 'beta'] } },
  })
  await makeProject(request, LIFE, {})
  await makeProject(request, GONE, { workspace_source: { provider: 'git-worktree', anchor: path.join(home, 'ws-fixture', 'app') } })
})

test.afterAll(async ({ request }) => {
  await setFlag(request, false)
})

async function makeProject(request: APIRequestContext, name: string, metadata: Record<string, unknown>): Promise<void> {
  expect((await request.post('/api/projects', { data: { name } })).ok()).toBe(true)
  if (Object.keys(metadata).length) {
    const res = await request.put(`/api/projects/${encodeURIComponent(name)}/metadata`, { data: metadata })
    expect(res.ok(), await res.text()).toBe(true)
  }
}

async function setFlag(request: APIRequestContext, on: boolean): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { experimental?: Record<string, boolean> }
  const res = await request.put('/api/config', { data: { experimental: { ...(cfg.experimental ?? {}), project_first_start: on } } })
  expect(res.ok()).toBe(true)
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function readTask(page: Page, taskId: string): Promise<{ workspace?: Ws; project?: string }> {
  const res = await page.request.get(`/api/tasks/${taskId}`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { task: { workspace?: Ws; project?: string } }).task
}

async function waitWorkspace(page: Page, taskId: string, state: string, timeout = 90_000): Promise<Ws> {
  let last: Ws | undefined
  await expect.poll(async () => { last = (await readTask(page, taskId)).workspace; return last?.state }, { timeout, message: `workspace of ${taskId} never reached ${state}` }).toBe(state)
  return last!
}

/** Type the first message and press Enter; returns the request body and the answer. */
async function start(page: Page, message: string): Promise<{ sent: Record<string, unknown>; answer: Record<string, unknown> }> {
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(message)
  await input.press('Enter')
  const res = await response
  expect(res.status(), await res.text()).toBe(200)
  return { sent: res.request().postDataJSON() as Record<string, unknown>, answer: await res.json() as Record<string, unknown> }
}

const pillsRow = (panel: Locator): Locator => panel.locator('.draft-composer-bar')
const startPill = (panel: Locator): Locator => panel.getByTestId('draft-project-start-pill')
const picker = (page: Page): Locator => page.getByTestId('project-start-picker')

async function openPicker(page: Page, panel: Locator): Promise<Locator> {
  await startPill(panel).click()
  await expect(picker(page)).toBeVisible()
  return picker(page)
}

async function pickProject(page: Page, panel: Locator, name: string): Promise<void> {
  const box = await openPicker(page, panel)
  await box.getByTestId('project-start-search').fill(name)
  await box.getByTestId(`project-start-row-${name}`).locator('.psp-pick').click()
  await expect(picker(page)).toHaveCount(0)
}

async function shot(page: Page, name: string, target: Locator, pad = 12): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5_000 }).catch(() => {})
  const box = await target.boundingBox()
  const vp = page.viewportSize()!
  const file = path.join(SHOTS, `${name}.png`)
  if (!box) { await page.screenshot({ path: file }); return }
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(vp.width - x, box.width + pad * 2), height: Math.min(vp.height - y, box.height + pad * 2) } })
}

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

test('experiment off: the draft row is today\'s, with no Project pill', async ({ page, request }) => {
  await setFlag(request, false)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const row = pillsRow(panel)
  await expect(row).toBeVisible()
  await expect(startPill(panel)).toHaveCount(0)
  await expect(panel.getByTestId('draft-start-host-pill')).toHaveCount(0)
  // The folder pill leads, as it always has.
  await expect(row.locator('.session-action-chip').first()).toHaveClass(/draft-folder-pill/)
  await shot(page, 'flag-off-row', panel.locator('.draft-launch-bar'))
  expect(errors).toEqual([])
})

test('a git source: no folder pill, Start files a task whose worktree the host makes', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  // The Project pill leads the row.
  await expect(pillsRow(panel).locator('.session-action-chip').first()).toHaveAttribute('data-testid', 'draft-project-start-pill')
  const box = await openPicker(page, panel)
  await box.getByTestId('project-start-search').fill(stamp)
  const marina = box.getByTestId(`project-start-row-${MARINA}`)
  await expect(marina.getByTestId('project-start-source-line')).toHaveText('Git worktree of app')
  await expect(box.getByTestId(`project-start-row-${ACME}`).getByTestId('project-start-source-line')).toHaveText('Fake multi-repo: alpha, beta')
  // A project with no source sits below, with its way to set one up.
  await expect(box.getByTestId(`project-start-row-${LIFE}`).getByTestId('project-start-setup')).toBeVisible()
  await shot(page, 'picker', box)
  await marina.locator('.psp-pick').click()
  await expect(picker(page)).toHaveCount(0)

  await expect(startPill(panel)).toContainText(`Project: ${MARINA}`)
  await expect(panel.locator('.draft-folder-pill')).toHaveCount(0)
  await expect(panel.getByTestId('draft-workspace-auto')).toHaveCount(0)
  await expect(panel.getByTestId('draft-workspace-row')).toHaveCount(0)
  await expect(panel.getByTestId('draft-start-host-pill')).toContainText('Host: Local')
  await expect(panel.getByTestId('draft-project-source-chip')).toContainText('New git worktree')
  await shot(page, 'git-source-row', panel.locator('.session-panel-input'))

  const { sent, answer } = await start(page, 'Tidy the readme')
  expect(sent).toMatchObject({ fromProject: true, project: MARINA, workspaceInputs: {} })
  // No host picked for this start: the server uses the project's own.
  expect(sent).not.toHaveProperty('host')
  expect(answer.preparing).toBe(true)
  const taskId = String(answer.taskId)
  const ws = await waitWorkspace(page, taskId, 'ready')
  expect(ws.provider).toBe('git-worktree')
  expect(ws.root).toContain(path.join(home, '.open-walnut-worktrees', 'app'))
  expect((await readTask(page, taskId)).project).toBe(MARINA)
  expect(errors).toEqual([])
})

test('a plugin source: value chips, × and + Add change what Start sends', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await pickProject(page, panel, ACME)
  const field = panel.getByTestId('draft-source-field-packages')
  await expect(field.getByTestId('draft-source-value')).toHaveText(['★alpha×', '★beta×'])
  await expect(panel.getByTestId('draft-project-source-chip')).toContainText('New Fake multi-repo workspace')

  // × drops one for this start; + Add takes a typed name.
  await field.locator('[data-value="beta"]').getByTestId('draft-source-remove').click()
  await expect(field.getByTestId('draft-source-value')).toHaveText(['★alpha×'])
  await field.getByTestId('draft-source-add').click()
  const add = page.getByTestId('draft-source-add-flyout')
  await expect(add).toBeVisible()
  // The dropped favourite is offered back.
  await expect(add.getByTestId('draft-source-suggestion')).toHaveText(['beta'])
  await add.getByTestId('draft-source-add-input').fill('gamma')
  await expect(add.getByTestId('draft-source-free')).toHaveText('Add “gamma”')
  await shot(page, 'plugin-add', add)
  await add.getByTestId('draft-source-free').click()
  await expect(field.getByTestId('draft-source-value')).toHaveText(['★alpha×', 'gamma×'])
  await page.keyboard.press('Escape')
  await expect(add).toHaveCount(0)
  await shot(page, 'plugin-source-row', panel.locator('.session-panel-input'))

  const { sent, answer } = await start(page, 'Wire alpha to gamma')
  expect(sent).toMatchObject({ fromProject: true, project: ACME, workspaceInputs: { packages: ['alpha', 'gamma'] } })
  expect(sent).not.toHaveProperty('host')
  expect(answer.preparing).toBe(true)
  const ws = await waitWorkspace(page, String(answer.taskId), 'ready')
  expect(ws.provider).toBe('fake-multirepo')
  expect((ws.repos ?? []).map((r) => r.name)).toEqual(['alpha', 'gamma'])
  expect(errors).toEqual([])
})

test('"Choose a folder instead" opens the folder picker and leaves project-first for this draft', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const box = await openPicker(page, panel)
  await box.getByTestId('project-start-choose-folder').click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.session-path-selector')).toHaveCount(0)
  // Today's row: the folder pill leads, no Project pill.
  await expect(startPill(panel)).toHaveCount(0)
  await expect(pillsRow(panel).locator('.session-action-chip').first()).toHaveClass(/draft-folder-pill/)
  expect(errors).toEqual([])
})

test('a project without a source after one with a source: back on the draft\'s own folder, a folder start', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const folderPill = panel.locator('.draft-folder-pill')
  await expect(folderPill).toBeVisible()
  const ownFolder = ((await folderPill.textContent()) ?? '').trim()
  await pickProject(page, panel, MARINA)
  await expect(folderPill).toHaveCount(0)
  await expect(panel.getByTestId('draft-project-source-chip')).toContainText('New git worktree')

  await pickProject(page, panel, LIFE)
  await expect(startPill(panel)).toContainText(`Project: ${LIFE}`)
  await expect(panel.getByTestId('draft-project-source-chip')).toHaveCount(0)
  await expect(panel.getByTestId('draft-start-host-pill')).toHaveCount(0)
  // The folder the draft stood on, not Marina's checkout.
  await expect(folderPill).toHaveText(ownFolder)
  await shot(page, 'source-then-no-source', panel.locator('.session-panel-input'))

  const sentReq = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Plan the week')
  await input.press('Enter')
  const sent = (await sentReq).postDataJSON() as Record<string, unknown>
  expect(sent).not.toHaveProperty('fromProject')
  expect(sent.project).toBe(LIFE)
  expect(sent.cwd).not.toBe(APP())
  expect(errors).toEqual([])
})

test('a start from a project the server refuses for good brings the draft back with its words', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await pickProject(page, panel, GONE)
  await expect(panel.getByTestId('draft-project-source-chip')).toContainText('New git worktree')
  // The source goes away behind the draft's back (another tab, an agent).
  const cleared = await request.put(`/api/projects/${encodeURIComponent(GONE)}/metadata`, { data: { workspace_source: null } })
  expect(cleared.ok(), await cleared.text()).toBe(true)

  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Refused start')
  await input.press('Enter')
  const res = await response
  // Still a start from the project, never a run in the old source's folder.
  expect(res.request().postDataJSON()).toMatchObject({ fromProject: true, project: GONE })
  expect(res.status()).toBe(400)
  expect(((await res.json()) as { code?: string }).code).toBe('no-project-source')

  // The same draft is back with its text and project, saying the server's words; no Retry.
  const back = draftPanel(page)
  await expect(back).toBeVisible()
  await expect(draftComposer(page)).toHaveValue('Refused start')
  await expect(startPill(back)).toContainText(`Project: ${GONE}`)
  await expect(back.getByTestId('draft-project-start-error')).toContainText('has no code source')
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await shot(page, 'refused-start-restored', back.locator('.session-panel-input'))
  expect(errors).toEqual([])
})

test('the Code source section saves a source, shown after a reload', async ({ page, request }) => {
  test.setTimeout(180_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  // A task, so the project has a header on the board to open its details from after the reload.
  expect((await request.post('/api/tasks', { data: { title: `Life chore ${stamp}`, project: LIFE, source: 'local', pinned: false } })).ok()).toBe(true)
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  await openHome(page)
  const panel = await openDraft(page)
  const box = await openPicker(page, panel)
  await box.getByTestId('project-start-search').fill(LIFE)
  await box.getByTestId(`project-start-row-${LIFE}`).getByTestId('project-start-setup').click()

  const pane = page.locator('.project-detail-pane')
  const section = pane.getByTestId('project-code-source')
  await expect(section).toBeVisible({ timeout: 15_000 })
  await expect(section.getByTestId('project-code-source-folder')).toHaveAttribute('aria-checked', 'true')
  await section.getByTestId('project-code-source-git-worktree').click()
  // No Working Dir and no folder yet: Save waits and says a folder is needed.
  await expect(section.getByTestId('project-code-source-needs-folder')).toBeVisible()
  await expect(section.getByTestId('project-code-source-save')).toBeDisabled()
  await section.getByTestId('project-code-source-anchor').fill(path.join(home, 'ws-fixture', 'app'))
  await expect(section.getByTestId('project-code-source-needs-folder')).toHaveCount(0)
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/metadata'))
  await section.getByTestId('project-code-source-save').click()
  expect((await saved).status()).toBe(200)
  await expect(section.getByTestId('project-code-source-save')).toHaveCount(0)
  await shot(page, 'settings-code-source', section)

  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  const after = await openProjectDetails(page, LIFE)
  await expect(after.getByTestId('project-code-source-git-worktree')).toHaveAttribute('aria-checked', 'true')
  await expect(after.getByTestId('project-code-source-anchor')).toHaveValue(path.join(home, 'ws-fixture', 'app'))
  // And the draft's picker now lists it with its source.
  const draft = await openDraft(page)
  const again = await openPicker(page, draft)
  await again.getByTestId('project-start-search').fill(LIFE)
  await expect(again.getByTestId(`project-start-row-${LIFE}`).getByTestId('project-start-source-line')).toHaveText('Git worktree of app')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
