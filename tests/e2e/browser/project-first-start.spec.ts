/**
 * The v6 new task draft (experiment project_first_start) in the browser. With the experiment off
 * the draft is today's. On: two mode tiles (Start task, Quick chat), one row [Project] [Where]
 * whose Where is a path that starts with the host, Auto as the first row of the Where menu (a
 * fresh worktree or a plugin workspace from the project's code source, its packages right under
 * it), the folders by host, a typed path with its states, a line under the row, Quick chat in the
 * row's place. A project restores its last place (derived from the folders Walnut recorded, then
 * from what this draft did). The composer and the row under it never move. Part two (hosts, the
 * task source, narrow, isolation, refusals, the keyboard): project-first-start-where.spec.ts.
 *
 * Real UI, real server, the MockDaemon running the real workspace core (real `git worktree`,
 * the fake multi-repo plugin provider); only the Claude CLI is mocked. A remote host comes from
 * the server's host fixture, so the spec runs in the one-at-a-time host fixture project. Needs the
 * workspace fixture, on its own port:
 *
 *   PW_WORKSPACE_FIXTURE=1 PW_TEST_PORT=3516 ./node_modules/.bin/playwright test tests/e2e/browser/project-first-start.spec.ts tests/e2e/browser/project-first-start-where.spec.ts --project=chromium-host-fixture
 */
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { draftComposer, draftPanel, openDraft } from './draft-helpers'
import { resetServerHostFixture } from './host-problems-fixture-helpers'
import { APP, PLAIN, fx, minutesAgo, setupFixture } from './project-first-start-fixture'
import {
  LOCAL_NAME, expectSameGeometry, geometry, line, openHome, openWhere,
  pickProject, pickTypedPath, projectField, projectMenu, readTask, sendArrow, setFlag, shot, start, tile, v6, waitWorkspace,
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
let ACME = ''
let LIFE = ''

test.beforeAll(async ({ request }) => {
  await setupFixture(request)
  ;({ home, stamp, MARINA, ACME, LIFE } = fx)
})

test.afterAll(async ({ request }) => {
  await setFlag(request, false)
  await resetServerHostFixture(request)
})

test('experiment off: the draft is today\'s, with no tiles and no Where row', async ({ page, request }) => {
  await setFlag(request, false)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const row = panel.locator('.draft-composer-bar')
  await expect(row).toBeVisible()
  await expect(v6(panel)).toHaveCount(0)
  await expect(panel.locator('.draft-v6-tile')).toHaveCount(0)
  // The folder pill leads, as it always has, and the mode pill has no "Permissions:" prefix.
  await expect(row.locator('.session-action-chip').first()).toHaveClass(/draft-folder-pill/)
  await expect(panel.getByText('Permissions:', { exact: false })).toHaveCount(0)
  await shot(page, 'flag-off-row')
  expect(errors).toEqual([])
})

test('the tiles, the row and Quick chat: a switch never moves the composer', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await expect(v6(panel)).toBeVisible()
  // Two tabs; Start task is chosen.
  await expect(v6(panel).getByRole('tab')).toHaveCount(2)
  await expect(tile(panel, 'task')).toHaveAttribute('aria-selected', 'true')
  await expect(tile(panel, 'chat')).toHaveAttribute('aria-selected', 'false')
  await expect(tile(panel, 'chat').locator('img')).toHaveCount(1)
  // One row: Where (the host first), then Repo or package (Evan, 2026-11-23). No old pill is left.
  await expect(projectField(panel)).toContainText('Repo or package')
  expect((await whereField(panel).boundingBox())!.x).toBeLessThan((await projectField(panel).boundingBox())!.x)
  await expect(whereField(panel).getByTestId('draft-v6-host')).toHaveText(LOCAL_NAME)
  for (const gone of ['.draft-folder-pill', '.draft-project-chip', '[data-testid="draft-work-in-pill"]', '[data-testid="draft-start-host-pill"]']) {
    await expect(panel.locator(gone), gone).toHaveCount(0)
  }
  // The send arrow alone starts it: no "Start task" words beside it.
  await expect(panel.locator('.draft-v6-input')).not.toContainText('Start task')
  await expect(sendArrow(panel)).toBeVisible()
  // The model and the mode each say what they are ("Auto model", "Default mode"; approved 2026-11-23).
  await expect(panel.locator('.draft-v6-input')).not.toContainText('Permissions:')
  await expect(panel.locator('.draft-v6-input')).toContainText('Auto model')
  const base = await geometry(panel)
  // The composer's column is at most 960 px wide and centred in the draft.
  expect(base.composer.width).toBeLessThanOrEqual(961)
  await shot(page, 'v6-start-task')

  await tile(panel, 'chat').click()
  await expect(tile(panel, 'chat')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByTestId('draft-v6-quick')).toBeVisible()
  await expect(panel.locator('.draft-v6-row')).toHaveCount(0)
  await expect(panel.locator('.draft-v6-input')).not.toContainText('Ask Walnut')
  await expect(panel.getByRole('group', { name: 'Try' })).toBeVisible()
  // The lower row's Recent chats: the fixture's newest quick chats (each with its session), each
  // chip whole, in the row's fixed height.
  const chats = panel.getByTestId('draft-v6-recent-chats')
  await expect(chats).toContainText('Recent chats')
  const chatTitle = ((await chats.getByTestId('draft-v6-recent-chat').first().textContent()) ?? '').trim()
  expect(chatTitle).not.toBe('')
  const shown = chats.locator('[data-testid="draft-v6-recent-chat"]:visible')
  expect(await shown.count()).toBeGreaterThanOrEqual(1)
  expect(await shown.count()).toBeLessThanOrEqual(2)
  const lowerBox = (await panel.getByTestId('draft-v6-lower').boundingBox())!
  for (const chip of await panel.getByTestId('draft-v6-quick-lower').locator('[data-fit]:visible').all()) {
    const b = (await chip.boundingBox())!
    expect(b.x + b.width, 'a chip is shown whole').toBeLessThanOrEqual(lowerBox.x + lowerBox.width + 1)
  }
  await expect(panel.getByTestId('draft-v6-save-todo')).toHaveCount(0)
  await expectSameGeometry(panel, base, 'Quick chat')
  await shot(page, 'v6-quick-chat')

  await tile(panel, 'task').click()
  await expect(panel.locator('.draft-v6-row')).toBeVisible()
  await expectSameGeometry(panel, base, 'back to Start task')
  // Words in the composer change nothing either.
  await draftComposer(page).fill('Look at the readme')
  await expect(panel.getByTestId('draft-v6-save-todo')).toBeEnabled()
  await expectSameGeometry(panel, base, 'typing')

  // A recent chat opens in the Ask Walnut slot.
  await tile(panel, 'chat').click()
  await panel.getByTestId('draft-v6-recent-chat').first().click()
  const slot = page.getByTestId('ask-walnut-slot')
  await expect(slot).toBeVisible({ timeout: 15_000 })
  await expect(slot).toContainText(chatTitle, { timeout: 15_000 })
  await shot(page, 'v6-quick-chat-opened')
  expect(errors).toEqual([])
})

test('a git source: Auto is the Where menu\'s first row, Start files a task whose worktree the host makes', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  // Only folders of no project: a start of Marina in another test (either spec, any order) would restore its place.
  await withDirs(page, [{ cwd: PLAIN(), count: 2 }, { cwd: path.join(home, 'ws-fixture', 'web'), count: 1, lastUsed: minutesAgo(30) }], { only: true })
  await openHome(page)
  const panel = await openDraft(page)
  const base = await geometry(panel)
  // No project yet: Auto waits for one.
  let menu = await openWhere(page, panel)
  await expect(menu.getByTestId('draft-v6-auto-row')).toHaveAttribute('data-state', 'no-project')
  await expect(menu.getByTestId('draft-v6-auto-row')).toContainText('Pick a repo or package first: Auto follows it')
  await expectSameGeometry(panel, base, 'Where menu open')
  await page.keyboard.press('Escape')
  await expect(whereMenu(page)).toHaveCount(0)

  // The Project menu says what each project's Auto makes, and where.
  await projectField(panel).click()
  await projectMenu(page).getByTestId('draft-v6-project-search').fill(stamp)
  await expect(projectMenu(page).getByTestId(`draft-v6-project-${MARINA}`).first()).toContainText(`New worktree · ${LOCAL_NAME}`)
  await expect(projectMenu(page).getByTestId(`draft-v6-project-${ACME}`).first()).toContainText(`New Fake multi-repo workspace · ${LOCAL_NAME}`)
  await shot(page, 'v6-project-menu')
  await projectMenu(page).getByTestId(`draft-v6-project-${MARINA}`).first().click()
  await expect(projectMenu(page)).toHaveCount(0)
  await expectSameGeometry(panel, base, 'project picked')

  await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('New worktree')
  // A first start with this project: Auto on its usual host, and the line says so.
  await expect(line(panel)).toHaveAttribute('data-kind', 'last-used')
  await expect(line(panel)).toContainText(`First time with ${MARINA}:`)
  menu = await openWhere(page, panel)
  // The first row of the list (the side's own rows are machines and places).
  const first = menu.getByTestId('draft-v6-where-main').getByRole('option').first()
  await expect(first).toHaveAttribute('data-testid', 'draft-v6-auto-row')
  await expect(first).toHaveAttribute('data-state', 'ok')
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await expect(first).toContainText(`Auto · New worktree on ${LOCAL_NAME}`)
  await expect(first).toContainText('Fresh copy of the default branch, removed when merged')
  // The picker never covers the row it edits (review N6): upward over the row where the room is,
  // else under it (the five recent places under the composer take the room above at this height).
  const menuBox = (await menu.boundingBox())!
  const rowBox = (await panel.locator('.draft-v6-row').boundingBox())!
  expect(menuBox.y + menuBox.height <= rowBox.y + 1 || menuBox.y >= rowBox.y + rowBox.height - 1).toBe(true)
  await shot(page, 'v6-where-auto')
  await page.keyboard.press('Escape')

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

test('a plugin source: its packages sit under Auto, a click and + Add change what Start sends', async ({ page, request }) => {
  test.setTimeout(240_000)
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const base = await geometry(panel)
  await pickProject(page, panel, ACME)
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('New Fake multi-repo workspace · 2 packages')
  const menu = await openWhere(page, panel)
  await expect(menu.getByTestId('draft-v6-auto-row')).toContainText('2 packages · A fresh Fake multi-repo workspace, removed when merged')
  const field = menu.getByTestId('draft-source-field-packages')
  await expect(field.getByTestId('draft-source-value')).toHaveText(['alpha', 'beta'])
  await expect(field.locator('[data-value="beta"]')).toHaveAttribute('aria-pressed', 'true')

  // A click leaves one out for this start; + Add takes a typed name.
  await field.locator('[data-value="beta"]').click()
  await expect(field.locator('[data-value="beta"]')).toHaveAttribute('aria-pressed', 'false')
  await field.getByTestId('draft-source-add').click()
  await field.getByTestId('draft-source-add-input').fill('gamma')
  await field.getByTestId('draft-source-add-input').press('Enter')
  await expect(field.locator('[data-value="gamma"]')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'v6-plugin-packages')
  await page.keyboard.press('Escape')
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('2 packages')
  await expectSameGeometry(panel, base, 'packages changed')

  const { sent, answer } = await start(page, 'Wire alpha to gamma')
  expect(sent).toMatchObject({ fromProject: true, project: ACME, workspaceInputs: { packages: ['alpha', 'gamma'] } })
  expect(sent).not.toHaveProperty('host')
  expect(answer.preparing).toBe(true)
  const ws = await waitWorkspace(page, String(answer.taskId), 'ready')
  expect(ws.provider).toBe('fake-multirepo')
  expect((ws.repos ?? []).map((r) => r.name)).toEqual(['alpha', 'gamma'])
  expect(errors).toEqual([])
})

test('a folder of a project\'s code: its project is detected, and "Use fresh workspace" starts from it', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  const sub = path.join(APP(), 'pkg')
  await withDirs(page, [{ cwd: sub, count: 9 }])
  await openHome(page)
  const panel = await openDraft(page)
  const base = await geometry(panel)
  const menu = await openWhere(page, panel)
  await menu.getByTestId('draft-v6-where-search').fill('pkg')
  const row = menu.locator('[data-testid="draft-v6-folder-row"][data-name="pkg"]').filter({ hasText: 'ws-fixture/app' }).first()
  await expect(row).toContainText(MARINA)
  await shot(page, 'v6-where-search')
  await row.click()
  await expect(whereMenu(page)).toHaveCount(0)

  // The folder, its project detected, and one suggestion on the line.
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'false')
  await expect(panel.getByTestId('draft-v6-folder')).toContainText('pkg')
  await expect(panel.getByTestId('draft-v6-project-name')).toHaveText(MARINA)
  await expect(panel.getByTestId('draft-v6-detected')).toHaveText('detected')
  await expect(line(panel)).toHaveAttribute('data-kind', 'suggest')
  await expect(line(panel)).toContainText(`This folder is ${MARINA}’s code. Use a fresh workspace instead?`)
  await expectSameGeometry(panel, base, 'folder picked')
  await shot(page, 'v6-folder-suggest')
  // The Where menu marks Auto as the recommended way for this folder.
  const again = await openWhere(page, panel)
  await expect(again.getByTestId('draft-v6-auto-row')).toContainText('recommended')
  await page.keyboard.press('Escape')

  await line(panel).getByTestId('work-in-suggest-use').click()
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')
  await expect(panel.getByTestId('draft-v6-auto')).toContainText('New worktree')
  const sentReq = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Bump the package')
  await input.press('Enter')
  expect((await sentReq).postDataJSON()).toMatchObject({ fromProject: true, project: MARINA })
  expect(errors).toEqual([])
})

test('a typed path: its levels, its folders in columns, the project it finds, and a folder that is not there', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const menu = await openWhere(page, panel)
  const search = menu.getByTestId('draft-v6-where-search')
  // Not there: the button says so and stays off; Enter picks nothing.
  await search.fill(path.join(home, 'ws-fixture', `nothere-${stamp}`))
  const use = menu.getByTestId('draft-v6-use-path')
  await expect(use).toHaveAttribute('data-state', 'missing', { timeout: 20_000 })
  await expect(use).toHaveText('No such folder')
  await expect(use).toBeDisabled()
  await shot(page, 'v6-path-missing')
  await search.press('Enter')
  await expect(whereMenu(page)).toBeVisible()
  // A real one: its parent's folders in the last column, its project said before the pick.
  await search.fill(`${path.join(home, 'ws-fixture')}/`)
  await expect(menu.locator(`[data-testid="draft-v6-column-folder"][data-path$="/ws-fixture/app"]`)).toBeVisible({ timeout: 20_000 })
  await search.fill(APP())
  await expect(use).toHaveAttribute('data-state', 'valid', { timeout: 20_000 })
  await expect(menu.getByTestId('draft-v6-where-project')).toHaveText(MARINA)
  // The levels row is the level being listed (the parent), each level a button.
  await expect(menu.getByTestId('draft-v6-typed-crumbs')).toContainText('ws-fixture')
  await shot(page, 'v6-path-valid')
  await search.press('Enter')
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(panel.getByTestId('draft-v6-folder')).toContainText('app')
  await expect(panel.getByTestId('draft-v6-detected')).toBeVisible()
  // "~" browses the home of the machine in the field.
  const homeMenu = await openWhere(page, panel)
  await homeMenu.getByTestId('draft-v6-where-search').fill('~')
  await expect(homeMenu.getByTestId('draft-v6-where-columns')).toContainText(`Home on ${LOCAL_NAME}`)
  await shot(page, 'v6-path-home')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('"Keep" hides the suggestion for this draft, a reload included; the folder start runs in it', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  await pickTypedPath(page, panel, APP())
  await expect(panel.getByTestId('draft-v6-project-name')).toHaveText(MARINA)
  await expect(line(panel)).toHaveAttribute('data-kind', 'suggest')
  await line(panel).getByTestId('work-in-suggest-keep').click()
  await expect(line(panel)).toHaveAttribute('data-kind', 'none')
  // The words keep the draft (and its answer) across a reload.
  await draftComposer(page).fill('Read the readme')
  await page.waitForTimeout(600)
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  const back = draftPanel(page)
  await expect(back).toBeVisible()
  await expect(draftComposer(page)).toHaveValue('Read the readme')
  await expect(back.getByTestId('draft-v6-folder')).toContainText('app')
  await expect(line(back)).not.toHaveAttribute('data-kind', 'suggest')
  await shot(page, 'v6-keep-after-reload')

  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).press('Enter')
  const res = await response
  const sent = res.request().postDataJSON() as Record<string, unknown>
  expect(sent).not.toHaveProperty('fromProject')
  expect(sent).not.toHaveProperty('workspace')
  expect(sent).toMatchObject({ cwd: APP(), project: MARINA })
  // Filed under the detected project, never a new one the server names after the folder.
  expect(sent).not.toHaveProperty('projectFromFolder')
  const taskId = String(((await res.json()) as { taskId?: string }).taskId)
  expect((await readTask(page, taskId)).project).toBe(MARINA)
  expect(errors).toEqual([])
})

test('a project restores its last place: a folder or Auto from the recorded folders, then what this draft did', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  await withDirs(page, [
    // Life's folder, used 5 minutes ago; a Marina worktree (Auto), used 12 minutes ago.
    { cwd: PLAIN(), project: LIFE, count: 2, lastUsed: minutesAgo(5) },
    { cwd: path.join(home, '.open-walnut-worktrees', `app-${stamp}`), project: MARINA, count: 4, lastUsed: minutesAgo(12) },
  ], { only: true })
  await openHome(page)
  const panel = await openDraft(page)
  const base = await geometry(panel)

  await pickProject(page, panel, LIFE)
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'false')
  await expect(panel.getByTestId('draft-v6-folder')).toContainText(path.basename(PLAIN()))
  await expect(panel.getByTestId('draft-v6-last-used')).toContainText(`Last used for ${LIFE}:`)
  await expect(panel.getByTestId('draft-v6-last-used')).toContainText(new RegExp(`${path.basename(PLAIN())} on ${LOCAL_NAME}, \\d+ min ago`))
  await expect(line(panel).getByTestId('draft-v6-back-to-auto')).toBeVisible()
  await shot(page, 'v6-memory-folder')

  await pickProject(page, panel, MARINA)
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')
  // Auto either way: the seeded worktree (12 min ago), or the workspace an earlier test's Marina
  // start made in this run (derivedPlace counts a task's workspace from the moment it is made).
  await expect(panel.getByTestId('draft-v6-last-used')).toContainText(new RegExp(`Last used for ${MARINA}: Auto on ${LOCAL_NAME}, (\\d+ min ago|just now)`))
  await shot(page, 'v6-memory-auto')
  await expectSameGeometry(panel, base, 'project restored its place')

  // This draft's own choice wins next time: Marina in a folder, away and back.
  await pickTypedPath(page, panel, APP())
  await pickProject(page, panel, LIFE)
  await pickProject(page, panel, MARINA)
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'false')
  await expect(panel.getByTestId('draft-v6-folder')).toContainText('app')
  // A restored folder never asks "use a fresh workspace instead?", even one of the project's code.
  await expect(line(panel)).toHaveAttribute('data-kind', 'last-used')
  // Back to Auto from the line.
  await line(panel).getByTestId('draft-v6-back-to-auto').click()
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'true')
  await expectSameGeometry(panel, base, 'back to Auto')
  expect(errors).toEqual([])
})
