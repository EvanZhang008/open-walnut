/**
 * Project scripts in the browser (src/core/workspaces/scripts.ts): a repository
 * with a walnut.json, a new task in an isolated workspace whose setup script
 * runs before the first session starts (the draft says so, the waiting column
 * shows it, the workspace flyout keeps its output), the session's Scripts chip
 * running a script in its terminal, and the project's own scripts edited in
 * the dialog. Real UI, real server, the MockDaemon running the REAL workspace
 * core (real git worktree, real shell); only the Claude CLI is mocked.
 *
 * Needs the workspace fixture: PW_WORKSPACE_FIXTURE=1 (it adds <home>/ws-fixture/web).
 *
 *   PW_WORKSPACE_FIXTURE=1 PW_TEST_PORT=3521 PW_WEBKIT=1 ./node_modules/.bin/playwright test tests/e2e/browser/workspace-scripts.spec.ts --project=webkit
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, draftMoreButton, draftPanel, draftTaskMenu, openDraft, openDraftSettings, pickDraftFolder } from './draft-helpers'
import { openKebabGroup } from './kebab-group-helpers'
import { selectSection } from './todo-panel-helpers'
import { PHONE } from './phone-helpers'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/workspace-scripts'

test.skip(process.env.PW_WORKSPACE_FIXTURE !== '1', 'needs PW_WORKSPACE_FIXTURE=1 on its own PW_TEST_PORT')
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
// One after the other: both change the project's scripts and the allowed files.
test.describe.configure({ mode: 'serial' })

let home = ''
/** The session test 1 started in its workspace (the phone test opens it). */
let firstSessionId = ''

test.beforeAll(async () => {
  ;({ walnutHome: home } = await discoverBrowserFixture(PORT))
  fs.mkdirSync(SHOTS, { recursive: true })
})

// A retry (or a second run on the same server) starts as the first did: the file not
// allowed yet, the project without scripts of its own.
test.beforeEach(async ({ request }) => {
  fs.rmSync(path.join(home, 'workspaces', 'scripts-trust.json'), { force: true })
  await request.put(`http://localhost:${PORT}/api/workspaces/scripts/project/web`, { data: { scripts: [] } }).catch(() => null)
})

interface Run { name: string; command: string; state: string; output?: string; wait?: boolean; source: string }
interface Ws { state: string; root?: string; cwd?: string; setup?: Run; teardown?: Run }
interface TaskRow { id: string; project?: string; workspace?: Ws }

async function readTask(page: Page, taskId: string): Promise<TaskRow> {
  const res = await page.request.get(`/api/tasks/${taskId}`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { task: TaskRow }).task
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function shot(page: Page, name: string, target: Locator, pad = 12): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5_000 }).catch(() => {})
  const box = await target.boundingBox()
  const vp = page.viewportSize()!
  const file = path.join(SHOTS, `${test.info().project.name}-${name}.png`)
  if (!box) { await page.screenshot({ path: file }); return }
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(vp.width - x, box.width + pad * 2), height: Math.min(vp.height - y, box.height + pad * 2) } })
}

function watchErrors(page: Page): { errors: string[]; failed: string[] } {
  const errors: string[] = []
  const failed: string[] = []
  // WebKit reports a ResizeObserver loop when the terminal fits itself (as terminal-end-unconfirmed.spec.ts notes): not an app error.
  page.on('pageerror', (e) => { if (!/^ResizeObserver loop completed with undelivered notifications\.$/.test(e.message)) errors.push(e.message) })
  page.on('response', (r) => { if (r.status() >= 400 && /\/api\/(workspaces|sessions|tasks|projects)/.test(r.url())) failed.push(`${r.status()} ${r.url()}`) })
  return { errors, failed }
}

/** The terminal view open on a panel: its header chip is a toggle, so press it only when the view is not on (a reload restores it a moment later). */
async function openTerminalView(panel: Locator): Promise<void> {
  const chip = panel.locator('[data-header-id="terminal"]').first()
  if (!(await chip.evaluate((el) => el.classList.contains('session-action-chip-active')))) await chip.click()
  await expect(chip).toHaveClass(/session-action-chip-active/)
  await expect(panel.locator('.session-terminal-panel')).toBeVisible({ timeout: 30_000 })
}

/** The terminal's visible text (xterm's DOM rows). */
async function terminalText(panel: Locator): Promise<string> {
  return (await panel.locator('.xterm-rows').textContent().catch(() => '')) ?? ''
}

// First: it leaves the repository's walnut.json not allowed, as the next test expects to find it.
test("a repository setup nobody allowed holds a person's start until they choose; the task reads Needs you", async ({ page }) => {
  test.setTimeout(180_000)
  const audit = watchErrors(page)
  const repo = path.join(home, 'ws-fixture', 'web')
  await openHome(page)
  const draft = await openDraft(page)
  // The folder typed into the picker and not confirmed: the press on More closes the picker,
  // which takes the folder and adds the Project chip, moving More under the pointer. The
  // menu still opens on that first press (a real mouse click at More's place).
  await draft.getByRole('button', { name: 'Choose folder and host' }).click()
  await page.getByPlaceholder('Type a folder path, or pick one below').fill(repo)
  await page.getByText(`${repo}/`, { exact: true }).click()
  await page.waitForTimeout(300)
  const moreBox = (await draftMoreButton(draft).boundingBox())!
  await page.mouse.click(moreBox.x + moreBox.width / 2, moreBox.y + moreBox.height / 2)
  const menu = draftTaskMenu(page)
  await expect(menu).toBeVisible({ timeout: 10_000 })
  await expect(draft.getByRole('button', { name: /^Folder and host: / })).toBeVisible()
  await menu.getByTestId('draft-menu-workspace').click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draft.getByTestId('draft-workspace-row').getByTestId('draft-workspace-provider-git-worktree')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
  // Started without allowing it (or before the draft finished checking the folder).
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Look at the app before setup')
  await input.press('Enter')
  const taskId = String(((await (await response).json()) as { taskId: string }).taskId)
  const preparing = page.locator(`[data-testid="workspace-preparing-panel"][data-task-id="${taskId}"]`)
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText("Its setup comes from walnut.json, which you have not allowed yet", { timeout: 60_000 })
  await expect(preparing.getByTestId('workspace-preparing-allow-setup')).toHaveText('Allow and run setup')
  await expect(preparing.getByTestId('script-run-setup')).toContainText('Install')
  await shot(page, 'held-needs-ok', preparing, 4)
  expect(((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions).toHaveLength(0)
  // Its status asks the person, in its own words.
  await expect.poll(async () => ((await readTask(page, taskId)) as TaskRow & { user_status?: { state?: string; ask?: string } }).user_status?.state, { timeout: 30_000 }).toBe('needs')
  expect(((await readTask(page, taskId)) as TaskRow & { user_status?: { ask?: string } }).user_status?.ask).toMatch(/which you have not allowed: allow it, or start the session without it/)

  await preparing.getByTestId('workspace-preparing-start-anyway').click()
  await expect.poll(async () => ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions.length, { timeout: 30_000 }).toBe(1)
  expect((await readTask(page, taskId)).workspace?.setup).toMatchObject({ state: 'skipped', untrusted: true, proceed: true })
  await expect(preparing).toHaveCount(0, { timeout: 30_000 })
  expect(audit.errors).toEqual([])
  expect(audit.failed).toEqual([])
})

test('setup runs in a new workspace before its first session; a script runs in the terminal in one click; the project list is edited', async ({ page }) => {
  test.setTimeout(240_000)
  const audit = watchErrors(page)
  const repo = path.join(home, 'ws-fixture', 'web')
  await openHome(page)

  // ── The draft says which setup the new workspace will run ──
  const draft = await openDraft(page)
  await pickDraftFolder(page, draft, repo)
  const menu = await openDraftSettings(draft)
  await menu.getByTestId('draft-menu-workspace').click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  const row = draft.getByTestId('draft-workspace-row')
  await expect(row.getByTestId('draft-workspace-provider-git-worktree')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
  const notice = row.getByTestId('draft-workspace-setup')
  // The repository's walnut.json is new to this Walnut: its setup runs by itself only once allowed.
  await expect(notice).toContainText('runs only once you allow it', { timeout: 30_000 })
  await expect(notice).toHaveAttribute('data-needs-ok', '')
  await expect(notice).toContainText('echo "Resolving 3 packages"')
  await shot(page, 'draft-setup-needs-ok', draftPanel(page).locator('.session-panel-input'), 8)
  await notice.getByTestId('draft-workspace-allow').click()
  await expect(notice).toContainText('Then runs setup', { timeout: 30_000 })
  await expect(notice).not.toHaveAttribute('data-needs-ok', '')
  await shot(page, 'draft-setup-notice', draftPanel(page).locator('.session-panel-input'), 8)

  // ── Start: the column waits while setup runs, then becomes the session ──
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Check the web app builds')
  await input.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const taskId = String(((await res.json()) as { taskId: string }).taskId)
  const preparing = page.locator(`[data-testid="workspace-preparing-panel"][data-task-id="${taskId}"]`)
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText('Workspace ready. Running its setup script…', { timeout: 60_000 })
  await expect(preparing.getByTestId('script-run-setup')).toContainText('Install')
  await expect(preparing.getByTestId('script-run-setup-status')).toContainText('Running…')
  await shot(page, 'preparing-setup', preparing.getByTestId('script-run-setup').locator('..'), 16)
  // No session yet: the first one waits for setup.
  expect(((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions).toHaveLength(0)

  await expect.poll(async () => (await readTask(page, taskId)).workspace?.setup?.state, { timeout: 60_000 }).toBe('done')
  const ws = (await readTask(page, taskId)).workspace!
  expect(ws.setup).toMatchObject({ name: 'Install', source: 'walnut.json', state: 'done' })
  expect(ws.setup!.output).toContain('Installed 3 packages')
  expect(fs.readFileSync(path.join(ws.root!, 'deps', 'installed.txt'), 'utf8').trim()).toBe('ok')
  await expect.poll(async () => ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions.length, { timeout: 30_000 }).toBe(1)
  const sessions = ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: Array<{ claudeSessionId: string; cwd?: string }> }).sessions
  expect(sessions[0].cwd).toBe(ws.cwd)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessions[0].claudeSessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })

  // ── The workspace flyout keeps the setup run and its output ──
  await panel.locator('.session-panel-header .task-kebab-btn').first().click()
  await openKebabGroup(page.locator('.task-kebab-menu'), 'kebab-group-move')
  await page.locator('.task-kebab-menu').getByTestId('workspace-menu-row').click()
  const flyout = page.getByTestId('workspace-flyout')
  await expect(flyout.getByTestId('script-run-setup-status')).toContainText('Done in')
  await flyout.getByTestId('script-run-setup').locator('summary').click()
  await expect(flyout.getByTestId('script-run-setup-output')).toContainText('Installed 3 packages')
  await expect(flyout.getByTestId('workspace-rerun-setup')).toBeVisible()
  await shot(page, 'flyout-setup', flyout)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)

  // ── Scripts chip: the file's scripts; Test runs in the terminal ──
  const chip = panel.getByTestId('session-scripts-chip')
  await expect(chip).toBeVisible()
  await chip.click()
  const scriptsMenu = page.getByTestId('session-scripts-menu')
  await expect(scriptsMenu).toBeVisible()
  await expect(scriptsMenu).toContainText('From walnut.json')
  await expect(scriptsMenu.locator('[data-testid="session-script-item"]')).toHaveCount(3)
  await expect(scriptsMenu.locator('[data-testid="session-script-item"][data-name="Install"]')).toContainText('Setup')
  await shot(page, 'scripts-menu', scriptsMenu, 8)
  await scriptsMenu.locator('[data-testid="session-script-item"][data-name="Test"]').click()
  await expect(scriptsMenu).toHaveCount(0)
  await expect(panel.locator('.session-terminal-panel')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => terminalText(panel), { timeout: 30_000 }).toContain('3 passed')
  expect(await terminalText(panel)).toContain(`Running tests in ${path.basename(ws.root!)}`)
  // The terminal shows the script's own command, not the line Walnut typed around it.
  expect(await terminalText(panel)).not.toContain("trap 'exit 130'")
  expect(await terminalText(panel)).not.toContain('walnut-run')
  expect(await terminalText(panel)).toContain('[Test exited with 0]')
  await shot(page, 'terminal-ran-test', panel.locator('.session-terminal-panel'), 4)

  // A second run from the menu while the terminal is open types into the same shell.
  await chip.click()
  await page.getByTestId('session-scripts-menu').locator('[data-testid="session-script-item"][data-name="Lint"]').click()
  await expect.poll(() => terminalText(panel), { timeout: 30_000 }).toContain('No problems')
  await expect(panel.locator('.session-terminal-panel')).toBeVisible()

  // The menu keeps how each run ended, and how the setup went.
  await chip.click()
  const results = page.getByTestId('session-scripts-menu')
  await expect(results.locator('[data-testid="session-script-item"][data-name="Test"]').getByTestId('session-script-result')).toHaveText('Passed', { timeout: 15_000 })
  await expect(results.locator('[data-testid="session-script-item"][data-name="Lint"]').getByTestId('session-script-result')).toHaveText('Passed')
  await expect(results.getByTestId('session-scripts-setup')).toContainText('Setup Install: Done in')
  await shot(page, 'scripts-menu-results', results, 8)
  // The setup ran beside the session, not in its terminal: its line opens its output.
  await results.getByTestId('session-scripts-setup').click()
  const output = page.getByTestId('script-output-dialog')
  await expect(output.getByTestId('script-run-setup-output')).toContainText('Installed 3 packages')
  await shot(page, 'setup-output-dialog', output, 4)
  await page.keyboard.press('Escape')
  await expect(output).toHaveCount(0)

  // ── A reload: the replayed scrollback shows commands, not the typed lines; results stay ──
  await page.reload()
  const reloaded = page.locator(`${REAL_PANEL}[data-session-id="${sessions[0].claudeSessionId}"]`)
  await expect(reloaded).toBeVisible({ timeout: 30_000 })
  await openTerminalView(reloaded)
  await expect.poll(() => terminalText(reloaded), { timeout: 30_000 }).toContain('[Test exited with 0]')
  const replayed = await terminalText(reloaded)
  expect(replayed).toContain('3 passed')
  expect(replayed).not.toContain("trap 'exit 130'")
  expect(replayed).not.toContain('walnut-run')
  await shot(page, 'terminal-after-reload', reloaded.locator('.session-terminal-panel'), 4)
  await reloaded.getByTestId('session-scripts-chip').click()
  await expect(page.getByTestId('session-scripts-menu').locator('[data-testid="session-script-item"][data-name="Test"]').getByTestId('session-script-result')).toHaveText('Passed')
  await page.keyboard.press('Escape')

  // ── Edit scripts: add a project script; it leads the menu next time ──
  await chip.click()
  await page.getByTestId('session-scripts-menu').getByText('Edit scripts…').click()
  const dialog = page.getByTestId('project-scripts-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('project-scripts-file')).toContainText('walnut.json')
  await expect(dialog.getByTestId('project-scripts-file-allowed')).toContainText('without asking')
  await expect(dialog.locator('[data-testid="project-file-script-row"]')).toHaveCount(3)
  await dialog.getByTestId('project-script-add').click()
  // Save waits for a name and a command, and its tooltip says which is missing.
  await expect(dialog.getByTestId('project-script-save')).toBeDisabled()
  await expect(dialog.getByTestId('project-script-save-hint')).toHaveText('Add a name and a command to save it.')
  await dialog.getByTestId('project-script-name').fill('Dev server')
  await expect(dialog.getByTestId('project-script-save-hint')).toHaveText('Add a command to save it.')
  await expect(dialog.getByTestId('project-script-save')).toHaveCSS('cursor', 'not-allowed')
  await dialog.getByTestId('project-script-command').fill('echo "dev server on :5173"')
  await shot(page, 'editor-form', dialog, 4)
  await dialog.getByTestId('project-script-save').click()
  await expect(dialog.locator('[data-testid="project-script-row"][data-name="Dev server"]')).toBeVisible()
  // A second one with the same name is refused, with its reason.
  await dialog.getByTestId('project-script-add').click()
  await dialog.getByTestId('project-script-name').fill('dev server')
  await dialog.getByTestId('project-script-command').fill('true')
  // Said once, beside the name, and Save waits for another name.
  await expect(dialog.getByTestId('project-script-name-clash')).toBeVisible()
  await expect(dialog.getByTestId('project-script-save')).toBeDisabled()
  await expect(dialog.getByTestId('project-scripts-error')).toHaveCount(0)
  // The name of one in walnut.json: allowed, said before saving, and the button says it replaces it.
  await dialog.getByTestId('project-script-name').fill('lint')
  await expect(dialog.getByTestId('project-script-name-twin')).toContainText('Saving this one replaces it')
  await expect(dialog.getByTestId('project-script-save')).toHaveText('Add and replace')
  // A twin of the file's is allowed: Save works again.
  await expect(dialog.getByTestId('project-script-save')).toBeEnabled()
  await expect(dialog.getByTestId('project-script-save-hint')).toHaveCount(0)
  await shot(page, 'editor-twin', dialog, 4)
  // Escape cancels the edit first (asking, since it holds typed text), then closes.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(dialog.getByTestId('project-script-form')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await shot(page, 'editor-list', dialog, 4)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const project = (await readTask(page, taskId)).project!
  const meta = await (await page.request.get(`/api/projects/${encodeURIComponent(project)}/metadata`)).json() as { metadata: { scripts?: Array<{ name: string; command: string }> } }
  expect(meta.metadata.scripts).toEqual([{ id: 'dev-server', name: 'Dev server', command: 'echo "dev server on :5173"' }])

  await chip.click()
  const again = page.getByTestId('session-scripts-menu')
  await expect(again.locator('[data-testid="session-script-item"]').first()).toHaveAttribute('data-name', 'Dev server')
  await again.locator('[data-testid="session-script-item"][data-name="Dev server"]').click()
  await expect.poll(() => terminalText(panel), { timeout: 30_000 }).toContain('dev server on :5173')

  // ── A script asked for while another still runs: stop that one first, never type behind it ──
  const withServe = await page.request.put(`/api/workspaces/scripts/project/${encodeURIComponent(project)}`, {
    data: { scripts: [...(meta.metadata.scripts ?? []),
      { name: 'Serve', command: 'echo "ser""ving on :8080"; sleep 120' },
      { name: 'Brief', command: 'echo "brief ""start"; sleep 4; echo "brief ""end"' },
    ] },
  })
  expect(withServe.ok()).toBe(true)
  // The question is asked, but the running one ends by itself first: the question goes and the next one runs.
  await chip.click()
  await page.getByTestId('session-scripts-menu').locator('[data-testid="session-script-item"][data-name="Brief"]').click()
  await expect.poll(() => terminalText(panel), { timeout: 30_000 }).toContain('brief start')
  await chip.click()
  await page.getByTestId('session-scripts-menu').locator('[data-testid="session-script-item"][data-name="Lint"]').click()
  const ask = page.getByTestId('script-stop-first')
  await expect(ask).toContainText('Brief is still running')
  await expect(ask).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(async () => (await terminalText(panel)).split('[Lint exited with 0]').length, { timeout: 30_000 }).toBe(3)
  expect(await terminalText(panel)).toContain('[Brief exited with 0]')
  expect(await terminalText(panel)).not.toContain('^C')
  await chip.click()
  await page.getByTestId('session-scripts-menu').locator('[data-testid="session-script-item"][data-name="Serve"]').click()
  await expect.poll(() => terminalText(panel), { timeout: 30_000 }).toContain('serving on :8080')
  // The chip says a script of its menu still runs in the terminal.
  await expect(chip.getByTestId('session-scripts-dot')).toHaveAttribute('data-run', 'Serve')
  // The menu offers to stop it.
  await chip.click()
  await expect(page.getByTestId('session-scripts-menu').getByTestId('session-script-stop')).toHaveText('Stop Serve')
  await page.keyboard.press('Escape')
  await chip.click()
  await page.getByTestId('session-scripts-menu').locator('[data-testid="session-script-item"][data-name="Lint"]').click()
  const stop = page.getByRole('button', { name: 'Stop and run Lint' })
  await expect(stop).toBeVisible()
  await expect(page.getByText('Serve is still running')).toBeVisible()
  await shot(page, 'stop-to-run', page.getByTestId('script-stop-first'), 4)
  await stop.click()
  await expect.poll(() => terminalText(panel), { timeout: 30_000 }).toContain('[Serve exited with 130]')
  await expect.poll(async () => (await terminalText(panel)).split('[Lint exited with 0]').length, { timeout: 30_000 }).toBe(4)
  expect(await terminalText(panel)).not.toContain('walnut-run')
  await chip.click()
  const after = page.getByTestId('session-scripts-menu')
  await expect(after.locator('[data-testid="session-script-item"][data-name="Serve"]').getByTestId('session-script-result')).toHaveText('Stopped', { timeout: 15_000 })
  await expect(after.locator('[data-testid="session-script-item"][data-name="Lint"]').getByTestId('session-script-result')).toHaveText('Passed', { timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(chip.getByTestId('session-scripts-dot')).toHaveCount(0)

  firstSessionId = sessions[0].claudeSessionId

  expect(audit.errors).toEqual([])
  expect(audit.failed).toEqual([])
})

test("a failed setup holds the person's session until they choose; the Scripts chip and the Workspace row say it failed", async ({ page, request }) => {
  test.setTimeout(180_000)
  const audit = watchErrors(page)
  const repo = path.join(home, 'ws-fixture', 'web')
  // The project's own setup (it needs no OK), and it fails.
  await request.post(`http://localhost:${PORT}/api/projects`, { data: { name: 'web' } }).catch(() => null)
  const put = await request.put(`http://localhost:${PORT}/api/workspaces/scripts/project/web`, {
    data: { scripts: [
      { name: 'Broken setup', command: 'echo "checking the lockfile"; sleep 10; echo "lockfile is missing" >&2; exit 2', setup: true },
      { name: 'Stop services', command: 'echo "stopping services"; sleep 8; echo stopped', teardown: true },
    ] },
  })
  expect(put.ok()).toBe(true)
  await openHome(page)

  const draft = await openDraft(page)
  await pickDraftFolder(page, draft, repo)
  const menu = await openDraftSettings(draft)
  await menu.getByTestId('draft-menu-workspace').click()
  const notice = draft.getByTestId('draft-workspace-row').getByTestId('draft-workspace-setup')
  await expect(notice).toContainText('Then runs setup Broken setup', { timeout: 30_000 })

  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill('Try the broken setup')
  await input.press('Enter')
  const taskId = String(((await (await response).json()) as { taskId: string }).taskId)
  const preparing = page.locator(`[data-testid="workspace-preparing-panel"][data-task-id="${taskId}"]`)
  // A reload while it runs brings the waiting column back, never an empty session panel.
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText('Workspace ready. Running its setup script…', { timeout: 60_000 })
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText(/Running its setup script|Its setup script failed/, { timeout: 30_000 })
  await expect(page.getByText('Untitled session')).toHaveCount(0)
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText('Its setup script failed, so the session has not started', { timeout: 60_000 })
  await expect(page.getByText('Untitled session')).toHaveCount(0)
  await expect(preparing.getByTestId('script-run-setup-status')).toContainText('Failed: exited with code 2')
  await expect(preparing.getByTestId('script-run-setup-output')).toContainText('lockfile is missing')
  await expect(preparing.getByTestId('workspace-preparing-edit-scripts')).toBeVisible()
  await shot(page, 'setup-failed-held', preparing.locator('.pending-session-body'), 8)
  // Still no session: it waits for the choice.
  await page.waitForTimeout(1500)
  expect(((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions).toHaveLength(0)

  // The project's setup is fixed meanwhile: the card still shows what ran, and says what a run again runs.
  const fixed = await request.put(`http://localhost:${PORT}/api/workspaces/scripts/project/web`, {
    data: { scripts: [
      { name: 'Broken setup', command: 'echo "lockfile restored"', setup: true },
      { name: 'Stop services', command: 'echo "stopping services"; sleep 8; echo stopped', teardown: true },
    ] },
  })
  expect(fixed.ok()).toBe(true)
  // A reload keeps the waiting column, with the person's words and the choice.
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText('Its setup script failed, so the session has not started', { timeout: 30_000 })
  await expect(preparing.locator('.pending-session-prompt-text')).toHaveText('Try the broken setup')
  await expect(preparing.getByTestId('workspace-preparing-start-anyway')).toBeVisible()
  await expect(preparing.getByTestId('workspace-preparing-setup-changed')).toContainText('echo "lockfile restored"')
  await expect(preparing.getByTestId('script-run-setup')).toContainText('exit 2')

  // Closed, the task row still says so (and reads Needs you); a click on it, or its ▶, brings the waiting column back.
  await preparing.locator('.session-panel-close').click()
  await expect(preparing).toHaveCount(0)
  await expect.poll(async () => ((await readTask(page, taskId)) as TaskRow & { user_status?: { state?: string } }).user_status?.state, { timeout: 30_000 }).toBe('needs')
  const row = (await readTask(page, taskId)) as TaskRow & { focus_tier?: string; user_status?: { ask?: string } }
  expect(row.user_status?.ask).toBe('Its setup Broken setup failed (exited with code 2): run it again, or start the session anyway.')
  await selectSection(page, row.focus_tier === 'focus' ? 'Focus' : 'Satellite')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
  await expect(card.getByTestId('workspace-pill')).toHaveText(/Setup failed/)
  await expect(card.getByTestId('workspace-pill')).toHaveAttribute('data-tone', 'error')
  await shot(page, 'row-setup-failed', card, 6)
  await card.locator('.todo-pinned-title').click()
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText('Its setup script failed, so the session has not started', { timeout: 15_000 })
  await preparing.locator('.session-panel-close').click()
  await expect(preparing).toHaveCount(0)
  await card.hover()
  await card.getByRole('button', { name: 'Start a session for this task' }).click()
  await expect(preparing.getByTestId('workspace-preparing-label')).toHaveText('Its setup script failed, so the session has not started', { timeout: 15_000 })

  await preparing.getByTestId('workspace-preparing-start-anyway').click()
  await expect.poll(async () => ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions.length, { timeout: 30_000 }).toBe(1)
  const sid = ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: Array<{ claudeSessionId: string }> }).sessions[0].claudeSessionId
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })

  // The session never hides it: a red dot on Scripts, the result at the top of its menu.
  await expect(panel.getByTestId('session-scripts-dot')).toHaveAttribute('data-tone', 'error')
  await panel.getByTestId('session-scripts-chip').click()
  const scriptsMenu = page.getByTestId('session-scripts-menu')
  await expect(scriptsMenu.getByTestId('session-scripts-setup')).toContainText('Setup Broken setup: Failed: exited with code 2')
  await shot(page, 'scripts-menu-failed', scriptsMenu, 8)
  await page.keyboard.press('Escape')
  // The Workspace row reads it too.
  await panel.locator('.session-panel-header .task-kebab-btn').first().click()
  await openKebabGroup(page.locator('.task-kebab-menu'), 'kebab-group-move')
  await expect(page.locator('.task-kebab-menu').getByTestId('workspace-menu-row')).toContainText('Setup failed')
  await page.keyboard.press('Escape')

  // ── Complete it: the cleanup script runs, and the session says so while it does ──
  expect((await page.request.post(`/api/tasks/${taskId}/complete`, { data: {} })).ok()).toBe(true)
  // At once, before the cleanup check starts (the task's sessions stop first).
  await expect(page.getByText('Cleaning up the workspace', { exact: true }).first()).toBeVisible({ timeout: 5_000 })
  await expect.poll(async () => (await readTask(page, taskId)).workspace?.teardown?.state, { timeout: 30_000 }).toBe('running')
  // Said outside the session too, beside "Task completed".
  await expect(page.getByText('Running cleanup Stop services', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByTestId('session-scripts-dot')).toHaveAttribute('data-tone', 'busy', { timeout: 15_000 })
  await panel.getByTestId('session-scripts-chip').click()
  await expect(scriptsMenu.getByTestId('session-scripts-setup')).toContainText('Cleanup Stop services: Running…')
  // A completed task's workspace is being cleaned up: no setup to run again.
  await expect(scriptsMenu.getByText('Run setup again', { exact: true })).toHaveCount(0)
  await shot(page, 'scripts-menu-cleanup', scriptsMenu, 8)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await readTask(page, taskId)).workspace?.teardown?.state, { timeout: 60_000 }).toBe('done')
  await expect(panel.getByTestId('session-scripts-dot')).toHaveCount(0, { timeout: 15_000 })
  // Then how it ended: removed, or kept and why.
  await expect.poll(async () => (await readTask(page, taskId)).workspace?.state, { timeout: 60_000 }).toMatch(/^(removed|kept)$/)
  const ended = (await readTask(page, taskId)).workspace!
  const endToast = page.getByText(ended.state === 'removed' ? 'Workspace removed' : 'Workspace kept', { exact: true }).first()
  await expect(endToast).toBeVisible({ timeout: 30_000 })
  // The menu keeps how the cleanup ended.
  await panel.getByTestId('session-scripts-chip').click()
  await expect(scriptsMenu.getByTestId('session-scripts-setup')).toHaveAttribute('data-role', 'cleanup')
  await expect(scriptsMenu.getByTestId('session-scripts-setup')).toContainText('Cleanup Stop services: Done in')
  // A removed workspace has no folder for its scripts: the menu says so and runs none,
  // and the editor reads walnut.json from the folder the workspace was made from.
  if (ended.state === 'removed') {
    await expect(scriptsMenu.getByTestId('session-scripts-gone')).toContainText('Its workspace was removed')
    await expect(scriptsMenu.locator('[data-testid="session-script-item"]').first().locator('xpath=ancestor::*[@role="menuitem"][1]')).toBeDisabled()
    await shot(page, 'scripts-menu-removed', scriptsMenu, 8)
    await scriptsMenu.getByText('Edit scripts…').click()
    const after = page.getByTestId('project-scripts-dialog')
    await expect(after.locator('[data-testid="project-file-script-row"]')).toHaveCount(3)
    await expect(after.getByText(/Could not read the repository/)).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  // Its terminal says the folder it runs in is gone.
  if (ended.state === 'removed') {
    await expect(page.getByTestId('project-scripts-dialog')).toHaveCount(0)
    await openTerminalView(panel)
    await expect(panel.getByTestId('terminal-folder-gone')).toBeVisible({ timeout: 30_000 })
    // It still opens (in home, the folder being gone): a shell prompt, no spawn error.
    await expect(panel.getByTestId('session-terminal-starting')).toHaveCount(0, { timeout: 30_000 })
    await expect(panel.locator('.session-terminal-inline-error')).toHaveCount(0)
    await shot(page, 'terminal-folder-gone', panel.locator('.session-terminal-panel'), 4)
    await panel.locator('[data-header-id="terminal"]').first().click()
  }
  // Each notice replaced the one before: no "Running cleanup" left beside the outcome.
  await expect(page.getByText('Running cleanup Stop services', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Cleaning up the workspace', { exact: true })).toHaveCount(0)
  await shot(page, 'cleanup-toast', endToast.locator('..').locator('..'), 8)

  expect(audit.errors).toEqual([])
  expect(audit.failed).toEqual([])
})

test('a reload while setup holds the first session keeps its column, beside a session the URL names, and it becomes the session', async ({ page }) => {
  test.setTimeout(240_000)
  const audit = watchErrors(page)
  const repo = path.join(home, 'ws-fixture', 'web')
  const slow = await page.request.put(`http://localhost:${PORT}/api/workspaces/scripts/project/web`, {
    data: { scripts: [{ name: 'Slow setup', command: 'echo "slow setup started"; sleep 25; echo "slow setup done"', setup: true }] },
  })
  expect(slow.ok()).toBe(true)
  // Another session column is open, so the page's URL names it (and never the waiting column).
  const other = firstSessionId
  test.skip(!other, 'needs the session the second test started')
  await page.goto(`http://localhost:${PORT}/?s1=${other}`)
  await expect(page.locator(`${REAL_PANEL}[data-session-id="${other}"]`)).toBeVisible({ timeout: 90_000 })
  const draft = await openDraft(page)
  await pickDraftFolder(page, draft, repo)
  const menu = await openDraftSettings(draft)
  await menu.getByTestId('draft-menu-workspace').click()
  await expect(draft.getByTestId('draft-workspace-row').getByTestId('draft-workspace-setup')).toContainText('Slow setup', { timeout: 30_000 })
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).fill('Wait for the slow setup')
  await draftComposer(page).press('Enter')
  const taskId = String(((await (await response).json()) as { taskId: string }).taskId)
  const preparing = page.locator(`[data-testid="workspace-preparing-panel"][data-task-id="${taskId}"]`)
  await expect(preparing.getByTestId('script-run-setup-status')).toContainText('Running…', { timeout: 60_000 })
  expect(new URL(page.url()).searchParams.get('s1') ?? '').not.toContain('pending')

  await page.reload()
  await expect(preparing.getByTestId('script-run-setup')).toContainText('Slow setup', { timeout: 60_000 })
  await expect(page.locator(`${REAL_PANEL}[data-session-id="${other}"]`)).toBeVisible()
  // Still waiting: no session column of its own yet.
  if ((await readTask(page, taskId)).workspace?.setup?.state === 'running') {
    await expect(preparing.getByTestId('script-run-setup-status')).toContainText('Running…')
    await shot(page, 'preparing-after-reload', preparing, 4)
  }
  await expect.poll(async () => (await readTask(page, taskId)).workspace?.setup?.state, { timeout: 90_000 }).toBe('done')
  await expect.poll(async () => ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: unknown[] }).sessions.length, { timeout: 30_000 }).toBe(1)
  const sid = ((await (await page.request.get(`/api/sessions/task/${taskId}`)).json()) as { sessions: Array<{ claudeSessionId: string }> }).sessions[0].claudeSessionId
  // The column turned into the session in place.
  await expect(page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(preparing).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator(`${REAL_PANEL}[data-session-id="${other}"]`)).toBeVisible()
  expect(audit.errors).toEqual([])
  expect(audit.failed).toEqual([])
})

// Last: a phone page of the same browser changes what the next desktop page restores.
test("a phone draws no session header: its top bar's menu has a Scripts row", async ({ browser }) => {
  test.skip(!firstSessionId, 'needs the session the first test started')
  const phoneCtx = await browser.newContext({ ...PHONE, baseURL: `http://localhost:${PORT}` })
  try {
    const phone = await phoneCtx.newPage()
    await phone.goto(`/?s1=${firstSessionId}`)
    const phoneMore = phone.locator('.phone-topbar').getByRole('button', { name: 'More actions' })
    await expect(phoneMore).toBeVisible({ timeout: 60_000 })
    await phoneMore.click()
    await phone.getByTestId('phone-row-scripts').click()
    const phoneMenu = phone.getByTestId('session-scripts-menu')
    await expect(phoneMenu.locator('[data-testid="session-script-item"][data-name="Test"]')).toBeVisible({ timeout: 15_000 })
    await shot(phone, 'phone-scripts-menu', phoneMenu, 8)
  } finally {
    await phoneCtx.close()
  }
})
