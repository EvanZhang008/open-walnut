/**
 * Start a new task from a project (experiment project_first_start) in the browser: with the
 * experiment off the draft's row is today's; on, ONE "Work in" pill asks where the task runs. Its
 * Projects tab picks a project with a code source (a git checkout, a plugin provider with a list
 * of packages: value chips above the row), and Start files a task whose workspace the host makes
 * from the source; its Folders tab (and "Browse or type a path…", today's folder picker) picks a
 * folder, tags it with the project whose code it is, and offers a fresh worktree instead. A row's
 * "Set up source…" opens the project's settings, whose "Code source" section saves a source that
 * is there after a reload.
 *
 * Real UI, real server, the MockDaemon running the real workspace core (real `git worktree`,
 * the fake multi-repo plugin provider); only the Claude CLI is mocked. Needs the workspace
 * fixture, on its own port:
 *
 *   PW_WORKSPACE_FIXTURE=1 PW_TEST_PORT=3516 ./node_modules/.bin/playwright test tests/e2e/browser/project-first-start.spec.ts --project=chromium
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { draftComposer, draftPanel, draftTaskMenu, openDraft, openDraftSettings } from './draft-helpers'
import { openSessionFromPlus } from './draft-surface-helpers'
import { isolateUiPrefs, listProjectHeader, openProjectDetails, presetPanelView } from './todo-panel-helpers'
import {
  PORT, SHOTS, browseTo, expectOnePill, makeProject, openHome, openPicker, picker, pickProject, pillsRow, projectRow,
  readTask, setFlag, shot, start, waitWorkspace, watchErrors, workIn,
} from './project-first-start-helpers'

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
/** A checkout of its own for the project whose source goes away, so it never shares APP's folder. */
const GONE_REPO = (): string => path.join(home, 'ws-fixture', 'gone-repo')

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
  // Made once per fixture server: a worker that restarts after a failure runs this hook again.
  if (!fs.existsSync(path.join(GONE_REPO(), '.git'))) {
    fs.mkdirSync(GONE_REPO(), { recursive: true })
    fs.writeFileSync(path.join(GONE_REPO(), 'README.md'), '# gone\n')
    for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'init']]) {
      execFileSync('git', ['-c', 'user.name=Walnut Test', '-c', 'user.email=walnut-test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: GONE_REPO() })
    }
  }
  await makeProject(request, GONE, { workspace_source: { provider: 'git-worktree', anchor: GONE_REPO() } })
})

test.afterAll(async ({ request }) => {
  await setFlag(request, false)
})

test('experiment off: the draft row is today\'s, with no Work in pill', async ({ page, request }) => {
  await setFlag(request, false)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const row = pillsRow(panel)
  await expect(row).toBeVisible()
  await expect(workIn(panel)).toHaveCount(0)
  await expect(page.getByTestId('work-in-suggest')).toHaveCount(0)
  // The folder pill leads, as it always has.
  await expect(row.locator('.session-action-chip').first()).toHaveClass(/draft-folder-pill/)
  await shot(page, 'flag-off-row', panel.locator('.draft-launch-bar'))
  expect(errors).toEqual([])
})

test('a git source from the Projects tab: one pill, Start files a task whose worktree the host makes', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await expectOnePill(panel)
  const box = await openPicker(page, panel)
  // Projects is the default tab.
  await box.getByTestId('work-in-search').fill(stamp)
  await expect(projectRow(box, MARINA).getByTestId('work-in-line')).toHaveText('Fresh git worktree on Local')
  await expect(projectRow(box, ACME).getByTestId('work-in-line')).toHaveText('Fresh Fake multi-repo workspace on Local · alpha, beta')
  await expect(projectRow(box, LIFE).getByTestId('work-in-line')).toHaveText('Works in a folder you pick')
  // A project with no source has one small "Set up source…" action, shown on its row under the pointer.
  const setup = projectRow(box, LIFE).getByTestId(`work-in-setup-${LIFE}`)
  await expect(setup).toHaveAttribute('title', 'Set up source…')
  await expect(projectRow(box, MARINA).locator('.wip-setup')).toHaveCount(0)
  await projectRow(box, LIFE).hover()
  await expect(setup).toBeVisible()
  await projectRow(box, MARINA).hover()
  await shot(page, 'picker-projects', box)
  await projectRow(box, MARINA).locator('.wip-pick').click()
  await expect(picker(page)).toHaveCount(0)

  await expect(workIn(panel)).toContainText('Work in:')
  await expect(workIn(panel)).toContainText(MARINA)
  await expect(workIn(panel)).toContainText('fresh git worktree')
  await expectOnePill(panel)
  // The current one is ticked, and its host is chosen at the bottom of the Projects tab.
  const again = await openPicker(page, panel)
  await again.getByTestId('work-in-search').fill(MARINA)
  await expect(projectRow(again, MARINA)).toHaveClass(/is-current/)
  await expect(again.getByTestId('work-in-host')).toContainText('Runs on Local')
  await again.getByTestId('work-in-host').click()
  await expect(page.getByTestId('draft-start-host-list')).toBeVisible()
  // Escape closes the nested host list only; a second one the popover.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('draft-start-host-list')).toHaveCount(0)
  await expect(picker(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
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
  await expect(workIn(panel)).toContainText('fresh Fake multi-repo workspace')
  await expectOnePill(panel)
  const field = panel.getByTestId('draft-source-field-packages')
  await expect(field.getByTestId('draft-source-value')).toHaveText(['★alpha×', '★beta×'])

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

test('a folder of a project\'s code: its project as a tag, and "Use fresh git worktree" starts from the project', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  const sub = path.join(APP(), 'pkg')
  // The fixture's recent folders, plus one inside the git checkout (only the LIST is added to).
  await page.route('**/api/sessions/working-dirs*', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs?: Array<Record<string, unknown>> }
    body.dirs = [{ cwd: sub, host: null, project: '', count: 9, lastUsed: new Date().toISOString() }, ...(body.dirs ?? [])]
    await route.fulfill({ response: res, json: body })
  })
  await openHome(page)
  const panel = await openDraft(page)
  const box = await openPicker(page, panel, 'folders')
  await box.getByTestId('work-in-search').fill('pkg')
  const row = box.locator('.wip-row[data-testid^="work-in-folder-"]').filter({ hasText: 'ws-fixture/app/pkg' }).first()
  await expect(row.getByTestId('work-in-folder-project')).toHaveText(MARINA)
  await expect(box.getByTestId('work-in-browse')).toBeVisible()
  await shot(page, 'picker-folders', box)
  await row.locator('.wip-pick').click()
  await expect(picker(page)).toHaveCount(0)

  // The folder, tagged with the project whose code it is, and one suggestion under the row.
  await expect(workIn(panel)).toContainText('pkg')
  await expect(panel.getByTestId('draft-work-in-project-tag')).toHaveText(MARINA)
  await expectOnePill(panel)
  const suggest = panel.getByTestId('work-in-suggest')
  await expect(suggest).toContainText(`This is ${MARINA}'s code. Start in a fresh git worktree instead?`)
  await expect(suggest.getByTestId('work-in-suggest-use')).toHaveText('Use fresh git worktree')
  await shot(page, 'folder-suggest', panel.locator('.session-panel-input'))

  await suggest.getByTestId('work-in-suggest-use').click()
  await expect(suggest).toHaveCount(0)
  await expect(workIn(panel)).toContainText(`${MARINA} · fresh git worktree`)
  const sentReq = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Bump the package')
  await input.press('Enter')
  expect((await sentReq).postDataJSON()).toMatchObject({ fromProject: true, project: MARINA })
  expect(errors).toEqual([])
})

test('"Keep this folder" hides the suggestion for this draft, a reload included; the folder start runs in it', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await browseTo(page, panel, APP())
  await expect(panel.getByTestId('draft-work-in-project-tag')).toHaveText(MARINA)
  const suggest = panel.getByTestId('work-in-suggest')
  await expect(suggest).toBeVisible()
  await suggest.getByTestId('work-in-suggest-keep').click()
  await expect(suggest).toHaveCount(0)
  // The words keep the draft (and its answer) across a reload.
  await draftComposer(page).fill('Read the readme')
  await page.waitForTimeout(600)
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  const back = draftPanel(page)
  await expect(back).toBeVisible()
  await expect(draftComposer(page)).toHaveValue('Read the readme')
  await expect(workIn(back)).toContainText('app')
  await expect(back.getByTestId('work-in-suggest')).toHaveCount(0)

  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).press('Enter')
  const res = await response
  const sent = res.request().postDataJSON() as Record<string, unknown>
  expect(sent).not.toHaveProperty('fromProject')
  expect(sent).not.toHaveProperty('workspace')
  expect(sent).toMatchObject({ cwd: APP(), project: MARINA })
  // Filed under the project the tag named, never a new one the server names after the folder.
  expect(sent).not.toHaveProperty('projectFromFolder')
  const taskId = String(((await res.json()) as { taskId?: string }).taskId)
  expect((await readTask(page, taskId)).project).toBe(MARINA)
  expect(errors).toEqual([])
})

test('isolated workspaces on by default: a folder start under the Work in pill still makes its workspace, and says so', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true, { isolated_workspace_by_default: true })
  try {
    const errors = watchErrors(page)
    await openHome(page)
    const panel = await openDraft(page)
    await browseTo(page, panel, APP())
    // The pill says what the auto chip said: this start isolates the folder.
    await expect(panel.getByTestId('draft-work-in-isolated')).toHaveText('· isolated copy', { timeout: 30_000 })
    await expect(workIn(panel)).toHaveAttribute('aria-label', `Work in: app (${MARINA}) · isolated copy`)
    await expectOnePill(panel)
    // "Keep this folder" answers the suggestion only: the folder start still isolates.
    await panel.getByTestId('work-in-suggest-keep').click()
    await expect(panel.getByTestId('work-in-suggest')).toHaveCount(0)
    await expect(panel.getByTestId('draft-work-in-isolated')).toBeVisible()
    // More keeps the switch, so the person can turn it off.
    const menu = await openDraftSettings(panel)
    await expect(menu.getByTestId('draft-menu-workspace')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(draftTaskMenu(page)).toHaveCount(0)
    await shot(page, 'folder-start-isolated', panel.locator('.session-panel-input'))

    const { sent, answer } = await start(page, 'Isolated folder start')
    expect(sent).not.toHaveProperty('fromProject')
    expect(sent).toMatchObject({ cwd: APP(), workspace: { provider: 'git-worktree' } })
    expect(answer.preparing).toBe(true)
    const ws = await waitWorkspace(page, String(answer.taskId), 'ready')
    expect(ws.provider).toBe('git-worktree')
    expect(errors).toEqual([])
  } finally {
    await setFlag(request, true, { isolated_workspace_by_default: false })
  }
})

test('a draft from a project\'s "+" on its code source: a folder pick leaves the source, Start runs in that folder', async ({ page, request }) => {
  test.setTimeout(180_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  const folder = path.join(home, 'ws-fixture', `plain-${stamp}`)
  fs.mkdirSync(folder, { recursive: true })
  // A task, so the project has a header on the board whose menu opens a draft in it.
  expect((await request.post('/api/tasks', { data: { title: `Marina chore ${stamp}`, project: MARINA, source: 'local', pinned: false } })).ok()).toBe(true)
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  await openHome(page)
  const header = listProjectHeader(page, MARINA)
  await expect(header).toBeVisible({ timeout: 25_000 })
  await openSessionFromPlus(page, header)
  const panel = draftPanel(page)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  // The "+" seed starts from the project's source.
  await expect(workIn(panel)).toContainText(`${MARINA} · fresh git worktree`)

  await browseTo(page, panel, folder)
  await expect(workIn(panel)).not.toContainText('fresh')
  await expect(panel.getByTestId('draft-work-in-project-tag')).toHaveText(MARINA)
  await shot(page, 'seed-then-folder', panel.locator('.session-panel-input'))

  const { sent } = await start(page, 'Work in the plain folder')
  expect(sent).not.toHaveProperty('fromProject')
  expect(sent).toMatchObject({ cwd: folder, project: MARINA })
  expect(errors).toEqual([])
})

test('a project without a source after one with a source: back on the draft\'s own folder, a folder start', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const folderName = workIn(panel).locator('.draft-pill-name')
  const before = ((await folderName.textContent()) ?? '').trim()
  await pickProject(page, panel, MARINA)
  await expect(workIn(panel)).toContainText('fresh git worktree')

  await pickProject(page, panel, LIFE)
  await expect(workIn(panel)).not.toContainText('fresh')
  await expect(panel.getByTestId('draft-work-in-project-tag')).toHaveText(LIFE)
  // The folder the draft stood on, not Marina's checkout.
  await expect(folderName).toHaveText(before)
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
  await expect(workIn(panel)).toContainText('fresh git worktree')
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
  await expect(workIn(back)).toContainText(GONE)
  await expect(back.getByTestId('draft-project-start-error')).toContainText('has no code source')
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await shot(page, 'refused-start-restored', back.locator('.session-panel-input'))
  expect(errors).toEqual([])
})

test('the Code source section, opened from a row\'s "Set up source…", saves a source shown after a reload', async ({ page, request }) => {
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
  await box.getByTestId('work-in-search').fill(LIFE)
  await projectRow(box, LIFE).hover()
  await projectRow(box, LIFE).getByTestId(`work-in-setup-${LIFE}`).click()

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
  // And the draft's Projects tab now lists it with its source, and no setup action.
  const draft = await openDraft(page)
  const again = await openPicker(page, draft)
  await again.getByTestId('work-in-search').fill(LIFE)
  await expect(projectRow(again, LIFE).getByTestId('work-in-line')).toHaveText('Fresh git worktree on Local')
  await expect(projectRow(again, LIFE).locator('.wip-setup')).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
