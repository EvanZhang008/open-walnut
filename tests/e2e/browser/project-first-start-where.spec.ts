/**
 * The v6 new task draft (experiment project_first_start) in the browser, part two: a host change
 * and what it blocks, the task source in More, a narrow draft, isolated workspaces by default (and
 * a project's Auto that must not carry a folder's isolation), a draft from a project's "+", a start
 * the server refuses, the Code source section, and the row by keyboard. Part one, and how to run
 * both: project-first-start.spec.ts. The fixture data both share: project-first-start-fixture.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { draftComposer, draftPanel, draftTaskMenu, openDraft } from './draft-helpers'
import { openSessionFromPlus } from './draft-surface-helpers'
import { fixtureFile, HEALTHY, loadFixture, resetServerHostFixture } from './host-problems-fixture-helpers'
import { isolateUiPrefs, listProjectHeader, openProjectDetails, presetPanelView } from './todo-panel-helpers'
import { APP, DEVBOX, LIFE_REPO, PLAIN, SERVICE, SYNCED, fx, setupFixture } from './project-first-start-fixture'
import {
  LOCAL_NAME, countStarts, expectSameGeometry, geometry, line, openHome, openMore, openWhere, pickHost,
  makeProject, pickProject, pickTypedPath, projectField, projectMenu, sendLabel, setFlag, shot, start, v6, waitWorkspace,
  watchErrors, whereField, whereMenu, withDirs,
} from './project-first-start-helpers'

test.skip(process.env.PW_WORKSPACE_FIXTURE !== '1', 'needs PW_WORKSPACE_FIXTURE=1 on its own PW_TEST_PORT')
// The user's window (1200 x 794), light theme: the screenshots are reviewed at this size.
test.use({ viewport: { width: 1200, height: 794 }, deviceScaleFactor: 1, colorScheme: 'light' })
// One after another: the experiment is a server-wide setting.
test.describe.configure({ mode: 'default' })

let home = ''
let stamp = ''
let MARINA = ''
let LIFE = ''
let GONE = ''
let NOTES = ''

test.beforeAll(async ({ request }) => {
  await setupFixture(request)
  ;({ home, stamp, MARINA, LIFE, GONE, NOTES } = fx)
})

test.afterAll(async ({ request }) => {
  await setFlag(request, false)
  await resetServerHostFixture(request)
})

test('a host change: Auto that cannot run there says why and blocks Start; a folder of another host says so', async ({ page, request }) => {
  await setFlag(request, true)
  await loadFixture(request, fixtureFile({ [DEVBOX.key]: { label: DEVBOX.label, hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY } }))
  try {
    const errors = watchErrors(page)
    // Only this folder: Marina's earlier starts in this run would restore a place of their own.
    await withDirs(page, [{ cwd: APP(), count: 5 }], { only: true })
    await openHome(page)
    const panel = await openDraft(page)
    const base = await geometry(panel)
    await pickProject(page, panel, MARINA)
    await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')

    await pickHost(page, panel, DEVBOX.key)
    await expect(whereField(panel).getByTestId('draft-v6-host')).toContainText(DEVBOX.label)
    await expect(panel.getByTestId('draft-v6-auto')).toContainText(`No worktree on ${DEVBOX.label}`)
    await expect(line(panel)).toHaveAttribute('data-kind', 'cannot')
    await expect(line(panel)).toContainText(`${DEVBOX.label} has no ${MARINA} checkout.`)
    await expectSameGeometry(panel, base, 'host changed')
    await shot(page, 'v6-host-cannot')
    // The Where menu's Auto row is greyed with its one way out.
    const menu = await openWhere(page, panel)
    await expect(menu.getByTestId('draft-v6-auto-row')).toHaveAttribute('data-state', 'cannot')
    await expect(menu.getByTestId('draft-v6-auto-way-out')).toHaveText(`Run on ${LOCAL_NAME}`)
    // The reason is read whole (review: it was cut): its box holds all of its text.
    const reason = menu.getByTestId('draft-v6-auto-row').locator('.draft-v6-wm-line.is-reason')
    await expect(reason).toContainText(`${DEVBOX.label} has no ${MARINA} checkout.`)
    expect(await reason.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    // The picker browses the draft's host first (its machine leads the field).
    await expect(menu.getByTestId('draft-v6-where-host')).toContainText(DEVBOX.label)
    await shot(page, 'v6-where-cannot')
    await page.keyboard.press('Escape')

    // Start says why next to the button and sends nothing; the words stay.
    const starts = countStarts(page)
    await draftComposer(page).fill('Run it on the dev box')
    await draftComposer(page).press('Enter')
    await expect(panel.getByTestId('draft-v6-start-why')).toContainText(`${DEVBOX.label} has no ${MARINA} checkout.`)
    await shot(page, 'v6-start-blocked')
    await expect(draftComposer(page)).toHaveValue('Run it on the dev box')
    expect(starts.n).toBe(0)
    // The send arrow reads off while Start is held (grey, aria-disabled); a click on it still explains.
    const send = panel.locator('.wn-input-send')
    await expect(send).toHaveAttribute('aria-disabled', 'true')
    await send.click({ force: true })
    await expect(panel.getByTestId('draft-v6-start-why')).toBeVisible()
    expect(starts.n).toBe(0)

    // The line's way out: back on the project's own host.
    await line(panel).getByTestId('draft-v6-line-run').click()
    await expect(whereField(panel).getByTestId('draft-v6-host')).toContainText(LOCAL_NAME)
    await expect(panel.getByTestId('draft-v6-auto')).toContainText('New worktree')
    await expect(send).not.toHaveAttribute('aria-disabled', 'true')

    // A folder known on this computer only, moved to the dev box: marked, and Start is blocked.
    await pickTypedPath(page, panel, APP())
    await pickHost(page, panel, DEVBOX.key)
    await expect(whereField(panel)).toHaveAttribute('data-auto', 'false')
    await expect(panel.getByTestId('draft-v6-not-on')).toHaveText(`not on ${DEVBOX.label}`)
    await expect(line(panel)).toHaveAttribute('data-kind', 'off-host')
    await expect(line(panel)).toContainText(`This folder is on ${LOCAL_NAME}, not on ${DEVBOX.label}.`)
    await shot(page, 'v6-host-off')
    await draftComposer(page).press('Enter')
    await expect(panel.getByTestId('draft-v6-start-why')).toContainText('not on')
    expect(starts.n).toBe(0)
    await line(panel).getByTestId('draft-v6-line-run').click()
    await expect(whereField(panel).getByTestId('draft-v6-host')).toContainText(LOCAL_NAME)
    await expect(line(panel)).not.toHaveAttribute('data-kind', 'off-host')
    await expectSameGeometry(panel, base, 'host back')
    expect(errors).toEqual([])
  } finally {
    await resetServerHostFixture(request)
  }
})

test('the task source is in More for a project that syncs, with a tag while the service is chosen', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const base = await geometry(panel)
  // A project that does not sync: no Task source at all.
  await pickProject(page, panel, LIFE)
  let menu = await openMore(panel)
  await expect(menu.getByTestId('draft-task-source')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)

  await pickProject(page, panel, SYNCED)
  menu = await openMore(panel)
  const row = menu.getByTestId('draft-task-source')
  await expect(row).toBeVisible()
  await expect(row.getByTestId('draft-task-source-walnut')).toHaveText('Walnut')
  await expect(row.getByTestId('draft-task-source-service')).toHaveText(SERVICE)
  await row.getByTestId('draft-task-source-service').click()
  await expect(row.getByTestId('draft-task-source-service')).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'v6-more-task-source')
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  const tag = panel.getByTestId('draft-task-source-tag')
  await expect(tag).toHaveText(`Task source: ${SERVICE}`)
  await expectSameGeometry(panel, base, 'task source tag shown')
  // The tag opens More, where Walnut takes it back.
  await tag.click()
  await draftTaskMenu(page).getByTestId('draft-task-source-walnut').click()
  await page.keyboard.press('Escape')
  await expect(tag).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a narrow draft: the host and the folder name only, the whole field opens Where, the menu reads whole', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  // Narrow the window until the draft is under 760 px wide (the sidebar and panels take the rest).
  for (let w = 1200; w >= 800 && !(await v6(panel).evaluate((el) => el.classList.contains('is-narrow'))); w -= 100) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(150)
  }
  await expect(v6(panel)).toHaveClass(/is-narrow/)
  await pickTypedPath(page, panel, path.join(APP(), 'pkg'))
  // Only the folder's name after the host, and the whole field opens Where (the spec's narrow
  // rule): the host part is no button of its own, and the menu has no host row (review round 1).
  await expect(panel.getByTestId('draft-v6-folder')).toHaveText('pkg')
  await expect(whereField(panel).getByTestId('draft-v6-host')).not.toHaveAttribute('aria-haspopup', 'dialog')
  await pickProject(page, panel, MARINA)
  // A tap on the host part (a real pointer: the field's own button takes it, not the part).
  const hostBox = (await whereField(panel).getByTestId('draft-v6-host').boundingBox())!
  await page.mouse.click(hostBox.x + hostBox.width / 2, hostBox.y + hostBox.height / 2)
  const menu = whereMenu(page)
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('draft-v6-host-menu')).toHaveCount(0)
  await expect(menu.getByTestId('draft-v6-wm-host')).toHaveCount(0)
  // The footer reads whole (it wraps), its count in the right number.
  const foot = menu.locator('.draft-v6-wm-foot')
  expect(await foot.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await expect(foot).not.toContainText(/\b1 folders\b/)
  const box = (await menu.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  expect(box.width).toBeGreaterThanOrEqual(Math.min(420, panelBox.width - 24) - 1)
  // Auto's title is read whole (it wraps, standard.md "Text that does not fit"), clear of the check.
  const auto = menu.getByTestId('draft-v6-auto-row')
  const title = auto.locator('.draft-v6-wm-title')
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true)
  const titleBox = (await title.boundingBox())!
  const right = (await auto.locator('.draft-v6-wm-right').boundingBox())!
  expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(right.x + 1)
  await shot(page, 'v6-narrow')
  await page.keyboard.press('Escape')
  // One recent place at most in a narrow row.
  expect(await panel.getByTestId('draft-v6-recent-chip').count()).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})

test('isolated workspaces on by default: a folder start still makes its workspace, and More keeps the switch', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true, { isolated_workspace_by_default: true })
  try {
    const errors = watchErrors(page)
    await openHome(page)
    const panel = await openDraft(page)
    const base = await geometry(panel)
    // The fixture's other git repository: a folder an earlier test started in remembers that start's choice.
    const repo = path.join(home, 'ws-fixture', 'web')
    await pickTypedPath(page, panel, repo)
    // The lower row says this folder start isolates (the host answers which provider first).
    await expect(panel.getByTestId('draft-workspace-auto')).toContainText('Git worktree', { timeout: 30_000 })
    await expectSameGeometry(panel, base, 'isolated by default')
    await shot(page, 'v6-folder-isolated')
    const menu = await openMore(panel)
    await expect(menu.getByTestId('draft-menu-workspace')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(draftTaskMenu(page)).toHaveCount(0)

    const { sent, answer } = await start(page, 'Isolated folder start')
    expect(sent).not.toHaveProperty('fromProject')
    expect(sent).toMatchObject({ cwd: repo, workspace: { provider: 'git-worktree' } })
    expect(answer.preparing).toBe(true)
    const ws = await waitWorkspace(page, String(answer.taskId), 'ready')
    expect(ws.provider).toBe('git-worktree')

    // Review round 1 (H1): the same folder's isolation, then a project with no code source (its
    // Auto is the home folder). The choice the row no longer shows must not ride the Start: no
    // worktree of the home folder.
    const next = await openDraft(page)
    await pickTypedPath(page, next, repo)
    await expect(next.getByTestId('draft-workspace-auto')).toContainText('Git worktree', { timeout: 30_000 })
    await pickProject(page, next, NOTES)
    await expect(whereField(next)).toHaveAttribute('data-auto', 'true')
    await expect(next.getByTestId('draft-v6-auto')).toContainText('Home folder')
    // The host answers for the home folder: nothing to isolate, so the chip goes.
    await expect(next.getByTestId('draft-workspace-auto')).toHaveCount(0, { timeout: 30_000 })
    const again = await start(page, 'Notes start in the home folder')
    expect(again.sent).toMatchObject({ project: NOTES })
    expect(again.sent).not.toHaveProperty('fromProject')
    expect((again.sent.workspace as { provider?: string } | undefined)?.provider).toBeUndefined()
    expect(String(again.sent.cwd)).not.toBe(repo)
    expect(errors).toEqual([])
  } finally {
    await setFlag(request, true, { isolated_workspace_by_default: false })
  }
})

test('a draft from a project\'s "+": Auto from its source; a folder pick leaves it, Start runs in that folder', async ({ page, request }) => {
  test.setTimeout(180_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
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
  await expect(panel.getByTestId('draft-v6-project-name')).toHaveText(MARINA)
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('New worktree')

  await pickTypedPath(page, panel, PLAIN())
  await expect(panel.getByTestId('draft-v6-project-name')).toHaveText(MARINA)
  await shot(page, 'v6-seed-then-folder')
  const { sent } = await start(page, 'Work in the plain folder')
  expect(sent).not.toHaveProperty('fromProject')
  expect(sent).toMatchObject({ cwd: PLAIN(), project: MARINA })
  expect(errors).toEqual([])
})

test('a start from a project the server refuses for good brings the draft back with its words', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await pickProject(page, panel, GONE)
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('New worktree')
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

  // The same draft is back with its text and project, the server's words on the line; no Retry.
  const back = draftPanel(page)
  await expect(back).toBeVisible()
  await expect(draftComposer(page)).toHaveValue('Refused start')
  await expect(back.getByTestId('draft-v6-project-name')).toHaveText(GONE)
  await expect(back.getByTestId('draft-project-start-error')).toHaveText('No code source: set one in the project\'s settings.')
  // As every state line: an icon, the words and a way out (review round 1).
  await expect(line(back).locator('.where-icon').first()).toBeVisible()
  await expect(line(back).getByTestId('draft-v6-line-pick')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
  await shot(page, 'v6-refused-start')
  expect(errors).toEqual([])
})

test('a folder that is gone is said before Start, and a start into one is refused with the draft back', async ({ page, request }) => {
  test.setTimeout(180_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  // 2026-11-23: a project whose own folder had been deleted; the task was made, its session never
  // started, and the draft said nothing.
  const own = path.join(home, `gone-own-${stamp}`)
  const proj = `Folderless ${stamp}`
  await makeProject(request, proj, { default_cwd: own })
  await openHome(page)
  const panel = await openDraft(page)
  await pickProject(page, panel, proj)
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('is gone')
  await expect(line(panel)).toHaveAttribute('data-kind', 'gone')
  await expect(line(panel).getByTestId('draft-v6-folder-gone')).toHaveText(`This folder is gone on ${LOCAL_NAME}.`)
  await shot(page, 'v6-folder-gone')
  const starts = countStarts(page)
  await draftComposer(page).fill('Start in a gone folder')
  await draftComposer(page).press('Enter')
  await expect(panel.getByTestId('draft-v6-start-why')).toContainText('is gone')
  expect(starts.n).toBe(0)
  await expect(draftComposer(page)).toHaveValue('Start in a gone folder')
  // Its way out opens the folder menu.
  await line(panel).getByTestId('draft-v6-line-pick').click()
  await expect(whereMenu(page)).toBeVisible()
  // The menu's Auto row says the same, never "Works in" a folder that is not there (review of the video).
  await expect(whereMenu(page).getByTestId('draft-v6-auto-row')).toContainText(`This folder is gone on ${LOCAL_NAME}`)
  await page.keyboard.press('Escape')

  // A folder there when picked and gone by Start (deleted meanwhile): the server refuses it before
  // anything is made, and the same draft comes back with its words.
  const late = path.join(home, `gone-late-${stamp}`)
  fs.mkdirSync(late, { recursive: true })
  await pickTypedPath(page, panel, late)
  await expect(line(panel)).not.toHaveAttribute('data-kind', 'gone')
  fs.rmSync(late, { recursive: true, force: true })
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).press('Enter')
  const res = await response
  expect(res.status()).toBe(400)
  const body = await res.json() as { code?: string; taskId?: string }
  expect(body.code).toBe('cwd_missing')
  expect(body.taskId).toBeUndefined()
  const back = draftPanel(page)
  await expect(draftComposer(page)).toHaveValue('Start in a gone folder')
  await expect(back.getByTestId('draft-project-start-error')).toContainText('is gone. Pick another folder.')
  await shot(page, 'v6-folder-gone-refused')
  // Another folder clears the refusal.
  await pickTypedPath(page, back, PLAIN())
  await expect(back.getByTestId('draft-project-start-error')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('tasks like the one being typed show over the composer; a click or Shift+Enter opens one, nothing starts', async ({ page, request }) => {
  test.setTimeout(120_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  // The user, 11-24: "I want this to be abel to serach also, user teh same search of the walniut,
  // also I can click and jump to the task, maybe be shift enter".
  const title = `Rotate the signing keys ${stamp}`
  const made = await request.post('/api/tasks', { data: { title, project: LIFE, source: 'local' } })
  expect(made.ok()).toBe(true)
  const madeBody = await made.json() as { task?: { id: string }; id?: string }
  const taskId = madeBody.task?.id ?? madeBody.id ?? ''
  expect(taskId).not.toBe('')
  await openHome(page)
  const panel = await openDraft(page)
  const starts = countStarts(page)
  await draftComposer(page).fill(`rotate the signing keys ${stamp}`)
  const matches = panel.getByTestId('draft-v6-task-matches')
  await expect(matches).toBeVisible({ timeout: 15_000 })
  const row = matches.locator(`[data-task-id="${taskId}"]`)
  await expect(row).toContainText(title)
  await shot(page, 'v6-task-matches')
  // Shift+Enter opens the first match: its row is selected in the task list, no start is sent.
  await draftComposer(page).press('Shift+Enter')
  await expect(matches.locator('[data-task-id]').first()).toHaveAttribute('data-task-id', taskId)
  const selected = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`).and(page.locator('.task-focused, .todo-pinned-card-active'))
  await expect(selected).toHaveCount(1, { timeout: 20_000 })
  expect(starts.n).toBe(0)
  await expect(draftComposer(page)).toHaveValue(`rotate the signing keys ${stamp}`)
  // With a second line, Shift+Enter is a new line again (the hint goes); a click still opens the task.
  await draftComposer(page).fill(`rotate the signing keys ${stamp}\nand the backup ones`)
  await expect(row).toBeVisible()
  await expect(matches.getByText('opens the first')).toHaveCount(0)
  await row.click()
  await expect(selected).toHaveCount(1)
  // × hides the list until the first line changes.
  await matches.getByRole('button', { name: 'Hide tasks like this' }).click()
  await expect(matches).toHaveCount(0)
  expect(starts.n).toBe(0)
  expect(errors).toEqual([])
})

test('the Code source section saves a source shown after a reload, and the Project menu then names it', async ({ page, request }) => {
  test.setTimeout(180_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  // A task, so the project has a header on the board to open its details from.
  expect((await request.post('/api/tasks', { data: { title: `Life chore ${stamp}`, project: LIFE, source: 'local', pinned: false } })).ok()).toBe(true)
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  await openHome(page)
  const section = (await openProjectDetails(page, LIFE)).getByTestId('project-code-source')
  await expect(section).toBeVisible({ timeout: 15_000 })
  await expect(section.getByTestId('project-code-source-folder')).toHaveAttribute('aria-checked', 'true')
  await section.getByTestId('project-code-source-git-worktree').click()
  // No Working Dir and no folder yet: Save waits and says a folder is needed.
  await expect(section.getByTestId('project-code-source-needs-folder')).toBeVisible()
  await expect(section.getByTestId('project-code-source-save')).toBeDisabled()
  await section.getByTestId('project-code-source-anchor').fill(LIFE_REPO())
  await expect(section.getByTestId('project-code-source-needs-folder')).toHaveCount(0)
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/metadata'))
  await section.getByTestId('project-code-source-save').click()
  expect((await saved).status()).toBe(200)
  await expect(section.getByTestId('project-code-source-save')).toHaveCount(0)
  await shot(page, 'settings-code-source')

  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  const after = await openProjectDetails(page, LIFE)
  await expect(after.getByTestId('project-code-source-git-worktree')).toHaveAttribute('aria-checked', 'true')
  await expect(after.getByTestId('project-code-source-anchor')).toHaveValue(LIFE_REPO())
  // The draft's Project menu now says its Auto makes a worktree.
  const draft = await openDraft(page)
  await projectField(draft).click()
  await projectMenu(page).getByTestId('draft-v6-project-search').fill(LIFE)
  await expect(projectMenu(page).getByTestId(`draft-v6-project-${LIFE}`).first()).toContainText(`New worktree · ${LOCAL_NAME}`)
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('the row by keyboard, and the send label: Tab reaches Where, Enter opens it; nothing to send, nothing starts', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await pickProject(page, panel, MARINA)
  // Review round 1 (H3): an empty composer leaves the "Start task" label off, as the send arrow.
  const starts = countStarts(page)
  await draftComposer(page).fill('')
  await expect(sendLabel(panel)).toBeDisabled()
  await sendLabel(panel).click({ force: true })
  await draftComposer(page).fill('Something to do')
  await expect(sendLabel(panel)).toBeEnabled()
  await draftComposer(page).fill('   ')
  await expect(sendLabel(panel)).toBeDisabled()
  expect(starts.n).toBe(0)

  // Review round 1 (M6): the Where field is a real button, next after Project in the tab order.
  // The Project field is one too: Enter opens its menu.
  await projectField(panel).getByTestId('draft-v6-project-open').focus()
  await page.keyboard.press('Enter')
  await expect(projectMenu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(projectMenu(page)).toHaveCount(0)
  await projectField(panel).getByTestId('draft-v6-project-open').focus()
  await page.keyboard.press('Tab')
  await expect(whereField(panel).getByTestId('draft-v6-where-open')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(whereMenu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(whereMenu(page)).toHaveCount(0)
  // Then the host part, its own button.
  await whereField(panel).getByTestId('draft-v6-where-open').focus()
  await page.keyboard.press('Tab')
  await expect(whereField(panel).getByTestId('draft-v6-host')).toBeFocused()
  expect(errors).toEqual([])
})
