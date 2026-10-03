/**
 * Task workspaces in the browser: the draft's "Isolated workspace" option (a
 * row of the draft's More menu; on, its body sits above the folder row), the
 * column that waits for the workspace, the session that starts inside it, and
 * the cleanup when the task completes. Real UI, real server, the MockDaemon
 * running the REAL workspace core (real `git worktree`, the real fake
 * multi-repo plugin provider); only the Claude CLI is mocked.
 *
 * Needs its own fixture: PW_WORKSPACE_FIXTURE=1 (a git repo at
 * <home>/ws-fixture/app, a plain folder at <home>/ws-fixture/multi, and the fake
 * multi-repo provider installed as a plugin). HOME of the server and its daemon
 * is the fixture's temp dir, so every worktree and workspace lands inside it.
 *
 *   PW_WORKSPACE_FIXTURE=1 PW_TEST_PORT=3515 ./node_modules/.bin/playwright test tests/e2e/browser/task-workspaces.spec.ts --project=chromium
 *   PW_WORKSPACE_FIXTURE=1 PW_TEST_PORT=3515 PW_WEBKIT=1 ./node_modules/.bin/playwright test tests/e2e/browser/task-workspaces.spec.ts --project=webkit
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, draftPanel, draftTaskMenu, openDraft, openDraftOnCwd, openDraftSettings, pickDraftFolder } from './draft-helpers'
import { selectSection } from './todo-panel-helpers'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/task-workspaces'

test.skip(process.env.PW_WORKSPACE_FIXTURE !== '1', 'needs PW_WORKSPACE_FIXTURE=1 on its own PW_TEST_PORT')
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

/** The fixture's HOME exactly as the server spells it (on macOS /var/folders, not its /private realpath). */
let home = ''
let homeReal = ''

/** Every path this spec touches or hands to git must sit inside the fixture's temp dir. */
function inHome(p: string): string {
  const abs = path.resolve(p)
  if (!home || !(abs.startsWith(home + path.sep) || abs.startsWith(homeReal + path.sep))) throw new Error(`refusing ${abs}: outside the fixture temp dir`)
  return abs
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: inHome(cwd), encoding: 'utf8',
    env: { ...process.env, HOME: home, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
  }).trim()
}

test.beforeAll(async () => {
  ;({ walnutHome: home } = await discoverBrowserFixture(PORT))
  homeReal = fs.realpathSync(home)
  const tmp = fs.realpathSync(os.tmpdir())
  if (!homeReal.startsWith(tmp + path.sep)) throw new Error(`fixture home ${home} is not inside ${tmp}`)
  fs.mkdirSync(SHOTS, { recursive: true })
})

interface Ws {
  state: string; provider: string; root?: string; cwd?: string; branch?: string; anchor: string
  repos?: Array<{ path: string; name?: string }>; kept_reason?: string; error?: string; progress?: string; branch_kept?: boolean
}
interface TaskRow { id: string; title: string; phase: string; focus_tier?: string; exec_session_id?: string; workspace?: Ws }

async function readTask(page: Page, taskId: string): Promise<TaskRow> {
  const res = await page.request.get(`/api/tasks/${taskId}`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { task: TaskRow }).task
}

async function waitWorkspace(page: Page, taskId: string, state: string, timeout = 60_000): Promise<Ws> {
  let last: Ws | undefined
  await expect.poll(async () => { last = (await readTask(page, taskId)).workspace; return last?.state }, { timeout, message: `workspace of ${taskId} never reached ${state}` }).toBe(state)
  return last!
}

async function sessionsOf(page: Page, taskId: string): Promise<Array<{ claudeSessionId: string; cwd?: string }>> {
  const res = await page.request.get(`/api/sessions/task/${taskId}`)
  return ((await res.json()) as { sessions: Array<{ claudeSessionId: string; cwd?: string }> }).sessions
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

/**
 * Turn the option on the way a user does: the draft's More menu → "Isolated
 * workspace". The menu closes and the body (provider pills + fields) appears
 * above the folder row; waits for the host's answer.
 */
async function enableWorkspace(page: Page): Promise<Locator> {
  const panel = draftPanel(page)
  const row = panel.getByTestId('draft-workspace-row')
  // Off, the option adds nothing to the bar (a folder pick must not grow it).
  await expect(row).toHaveCount(0)
  const menu = await openDraftSettings(panel)
  const item = menu.getByTestId('draft-menu-workspace')
  await expect(item).toBeEnabled()
  await expect(item).toHaveAttribute('aria-pressed', 'false')
  await item.click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(row).toBeVisible()
  await expect(row.getByTestId('draft-workspace-on')).toContainText('Isolated workspace ✓')
  await expect(row.getByTestId('draft-workspace-loading')).toHaveCount(0, { timeout: 30_000 })
  return row
}

/** Type the first message and press Enter; returns the task the launch filed. */
async function launch(page: Page, message: string): Promise<{ taskId: string; body: Record<string, unknown> }> {
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(message)
  await input.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const body = await res.json() as Record<string, unknown>
  return { taskId: String(body.taskId), body }
}

async function taskCard(page: Page, taskId: string): Promise<Locator> {
  const task = await readTask(page, taskId)
  await selectSection(page, task.focus_tier === 'focus' ? 'Focus' : 'Satellite')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible()
  return card
}

/** The session panel's kebab → Workspace row → its flyout. */
async function openPanelWorkspaceFlyout(page: Page, panel: Locator): Promise<Locator> {
  await panel.locator('.session-panel-header .task-kebab-btn').first().click()
  await page.locator('.task-kebab-menu').getByTestId('workspace-menu-row').click()
  const flyout = page.getByTestId('workspace-flyout')
  await expect(flyout).toBeVisible()
  return flyout
}

/** Screenshot of a region, padded, clipped to the viewport (<= 1280 wide). */
async function shot(page: Page, name: string, target: Locator, pad = 16): Promise<void> {
  // A dialog fades in: capture it once its entry animation is over, not half-transparent.
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
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('response', (r) => { if (r.status() >= 400 && /\/api\/(workspaces|sessions|tasks)/.test(r.url())) failed.push(`${r.status()} ${r.url()}`) })
  return { errors, failed }
}

test('git worktree: each task gets its own, the session runs in it, a clean one goes on completion and a dirty one is kept', async ({ page }) => {
  test.setTimeout(240_000)
  const audit = watchErrors(page)
  const proj = test.info().project.name
  const repo = inHome(path.join(home, 'ws-fixture', 'app'))
  const worktrees = path.join(home, '.open-walnut-worktrees', 'app')
  await openHome(page)

  // ── Task 1: the repo root ──
  // No folder yet: More offers the option, disabled, and says why.
  const draft = await openDraft(page)
  const noFolderMenu = await openDraftSettings(draft)
  const noFolderItem = noFolderMenu.getByTestId('draft-menu-workspace')
  await expect(noFolderItem).toBeDisabled()
  await expect(noFolderItem).toContainText('Isolated workspace')
  await expect(noFolderItem.getByTestId('draft-menu-workspace-hint')).toHaveText('Pick a folder first')
  await shot(page, 'draft-more-no-folder', noFolderMenu, 8)
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await pickDraftFolder(page, draft, repo)
  await expect(draft.getByTestId('draft-workspace-row')).toHaveCount(0)
  const offMenu = await openDraftSettings(draft)
  await expect(offMenu.getByTestId('draft-menu-workspace-hint')).toHaveCount(0)
  await shot(page, 'draft-more-row', offMenu, 8)
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  // On, then off through the body's pill, then on again through More.
  const firstOn = await enableWorkspace(page)
  await firstOn.getByTestId('draft-workspace-off').click()
  await expect(draft.getByTestId('draft-workspace-row')).toHaveCount(0)
  const row = await enableWorkspace(page)
  await expect(row.getByTestId('draft-workspace-provider-git-worktree')).toHaveAttribute('aria-checked', 'true')
  await expect(row.getByTestId('draft-workspace-input-baseRef')).toBeVisible()
  await shot(page, 'draft-option', draftPanel(page).locator('.session-panel-input'), 8)
  const onMenu = await openDraftSettings(draft)
  await expect(onMenu.getByTestId('draft-menu-workspace')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'draft-more-on', onMenu, 8)
  await page.keyboard.press('Escape')
  await expect(draftTaskMenu(page)).toHaveCount(0)
  const one = await launch(page, `Read the readme ${proj}`)
  expect(one.body.preparing).toBe(true)
  expect(one.body.sessionId).toBeFalsy()
  const ws1 = await waitWorkspace(page, one.taskId, 'ready')
  expect(path.dirname(ws1.root!)).toBe(worktrees)
  expect(ws1.cwd).toBe(ws1.root)
  expect(ws1.branch).toBe(`walnut/${path.basename(ws1.root!)}`)
  expect(git(ws1.root!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(ws1.branch)

  // The waiting column turns into the session, and the session runs in the worktree.
  await expect.poll(async () => (await sessionsOf(page, one.taskId)).length, { timeout: 30_000 }).toBe(1)
  const [s1] = await sessionsOf(page, one.taskId)
  expect(s1.cwd).toBe(ws1.cwd)
  const panel1 = page.locator(`${REAL_PANEL}[data-session-id="${s1.claudeSessionId}"]`)
  await expect(panel1).toBeVisible({ timeout: 30_000 })
  await expect(panel1.getByText(`Read the readme ${proj}`, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="workspace-preparing-panel"]')).toHaveCount(0)

  const card1 = await taskCard(page, one.taskId)
  await expect(card1.getByTestId('workspace-pill')).toContainText('Worktree')
  const flyout1 = await openPanelWorkspaceFlyout(page, panel1)
  await expect(flyout1).toContainText(ws1.root!)
  await expect(flyout1).toContainText(ws1.branch!)
  await expect(flyout1.getByTestId('workspace-flyout-state')).toHaveText('Ready')
  await shot(page, 'flyout-ready', flyout1)
  await page.keyboard.press('Escape')
  await expect(flyout1).toHaveCount(0)

  // ── Task 2: a subfolder of the same repo; its agent writes a file ──
  await openDraftOnCwd(page, path.join(repo, 'pkg'))
  await enableWorkspace(page)
  const editTurn = `file-edit-turn:${JSON.stringify({ edits: [{ file: 'notes.txt', write: `draft notes ${proj}\n` }] })}`
  const two = await launch(page, editTurn)
  const ws2 = await waitWorkspace(page, two.taskId, 'ready')
  expect(ws2.root).not.toBe(ws1.root)
  expect(path.dirname(ws2.root!)).toBe(worktrees)
  expect(ws2.cwd).toBe(path.join(ws2.root!, 'pkg'))
  await expect.poll(async () => (await sessionsOf(page, two.taskId))[0]?.cwd, { timeout: 30_000 }).toBe(ws2.cwd)
  const [s2] = await sessionsOf(page, two.taskId)
  const panel2 = page.locator(`${REAL_PANEL}[data-session-id="${s2.claudeSessionId}"]`)
  await expect(panel2).toBeVisible({ timeout: 30_000 })
  // The agent's write landed in ITS worktree, never in the source repo.
  await expect.poll(() => fs.existsSync(path.join(ws2.cwd!, 'notes.txt')), { timeout: 30_000 }).toBe(true)
  expect(fs.existsSync(path.join(repo, 'pkg', 'notes.txt'))).toBe(false)
  expect(fs.existsSync(path.join(ws1.root!, 'pkg', 'notes.txt'))).toBe(false)

  // ── Complete task 1 (clean, nothing new on its branch): the worktree and branch go ──
  // An ignored file (in no commit) does not hold an automatic cleanup back.
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
  fs.appendFileSync(inHome(path.join(repo, '.git', 'info', 'exclude')), 'local.env\n')
  fs.writeFileSync(inHome(path.join(ws1.root!, 'local.env')), 'TOKEN=test\n')
  const card1b = await taskCard(page, one.taskId)
  await card1b.getByRole('button', { name: 'Mark complete', exact: true }).click()
  const gone = await waitWorkspace(page, one.taskId, 'removed')
  expect(gone.branch_kept).toBeFalsy()
  expect(fs.existsSync(ws1.root!)).toBe(false)
  expect(git(repo, 'branch', '--list', ws1.branch!)).toBe('')

  // ── Complete task 2 (uncommitted notes.txt): kept, and the task says why ──
  const card2 = await taskCard(page, two.taskId)
  await card2.getByRole('button', { name: 'Mark complete', exact: true }).click()
  const kept = await waitWorkspace(page, two.taskId, 'kept')
  expect(kept.kept_reason).toMatch(/uncommitted|not committed|changes/i)
  expect(fs.existsSync(path.join(ws2.cwd!, 'notes.txt'))).toBe(true)
  // A done card leaves the board after its fade; the session column stays, and its
  // task kebab says what happened to the workspace and why.
  await panel2.locator('.session-panel-header .task-kebab-btn').first().click()
  await expect(page.locator('.task-kebab-menu').getByTestId('workspace-menu-row')).toContainText('Kept')
  await page.locator('.task-kebab-menu').getByTestId('workspace-menu-row').click()
  const flyout2 = page.getByTestId('workspace-flyout')
  await expect(flyout2.getByTestId('workspace-kept-reason')).toContainText(kept.kept_reason!)
  await expect(flyout2.getByTestId('workspace-remove')).toBeVisible()
  await shot(page, 'flyout-kept', flyout2)
  await page.screenshot({ path: path.join(SHOTS, `${proj}-board-after-completion.png`) })

  // Remove from the kebab: the host refuses while the file is uncommitted, and says so.
  await flyout2.getByTestId('workspace-remove').click()
  const refusal = page.getByRole('dialog', { name: 'Walnut will not remove this workspace' })
  await expect(refusal).toBeVisible({ timeout: 30_000 })
  await expect(refusal).toContainText(/uncommitted|not committed|changes/i)
  await shot(page, 'remove-refused', refusal.locator('.app-modal'))
  await refusal.getByRole('button').last().click()
  expect(fs.existsSync(path.join(ws2.cwd!, 'notes.txt'))).toBe(true)

  expect(audit.errors).toEqual([])
  expect(audit.failed).toEqual([])
})

test('a plugin provider: a multi-repo workspace shows its progress, fails with Retry, then runs the session and is removed on request', async ({ page }) => {
  test.setTimeout(240_000)
  const audit = watchErrors(page)
  const proj = test.info().project.name
  const folder = inHome(path.join(home, 'ws-fixture', 'multi'))
  const alpha = `alpha-${proj}`
  const beta = `beta-${proj}`
  const failKnob = inHome(path.join(home, `fake-provider-fail-${beta}`))
  const delayKnob = inHome(path.join(home, `fake-provider-delay-${alpha}`))
  // Long enough for the server's 1.5s job poll to see the line even on a loaded machine.
  fs.writeFileSync(delayKnob, '6')
  fs.writeFileSync(failKnob, `could not reach the package server for ${beta}`)
  try {
    await openHome(page)
    await openDraftOnCwd(page, folder)
    const row = await enableWorkspace(page)
    // Not a git repository, and no marker: git-worktree is not offered, the plugin can be picked by hand.
    await expect(row.getByTestId('draft-workspace-provider-git-worktree')).toHaveCount(0)
    const pill = row.getByTestId('draft-workspace-provider-fake-multirepo')
    await expect(pill).toHaveAttribute('aria-checked', 'false')
    await pill.click()
    await expect(pill).toHaveAttribute('aria-checked', 'true')
    // Required field empty: Start waits and says why.
    await draftComposer(page).fill('Wire the two packages together')
    await draftComposer(page).press('Enter')
    await expect(row.getByTestId('draft-workspace-start-error')).toHaveText('Packages is required for Fake multi-repo')
    await row.getByTestId('draft-workspace-input-packages').fill(`${alpha} ${beta}`)
    await expect(row.getByTestId('draft-workspace-start-error')).toHaveCount(0)
    await shot(page, 'draft-plugin', row, 24)
    const { taskId, body } = await launch(page, 'Wire the two packages together')
    expect(body.preparing).toBe(true)

    // The waiting column shows the provider's own progress line.
    const waiting = page.locator(`[data-testid="workspace-preparing-panel"][data-task-id="${taskId}"]`)
    await expect(waiting).toBeVisible({ timeout: 15_000 })
    await expect(waiting.getByTestId('workspace-preparing-progress')).toHaveText(`Cloning ${alpha}`, { timeout: 20_000 })
    await shot(page, 'preparing-progress', waiting, 8)

    // It fails: the provider's error and Retry, and no session.
    await expect(waiting.getByTestId('workspace-preparing-error')).toContainText(`could not reach the package server for ${beta}`, { timeout: 30_000 })
    const failed = await readTask(page, taskId)
    expect(failed.workspace?.state).toBe('failed')
    expect(await sessionsOf(page, taskId)).toHaveLength(0)
    expect(fs.existsSync(path.join(home, 'fake-workspaces'))
      ? fs.readdirSync(path.join(home, 'fake-workspaces')).filter((n) => n.includes(taskId.toLowerCase()))
      : []).toEqual([])
    await shot(page, 'preparing-failed', waiting, 8)

    // The cause goes away; Retry makes it and the session starts there.
    fs.rmSync(failKnob)
    fs.rmSync(delayKnob)
    await waiting.getByTestId('workspace-preparing-retry').click()
    const ws = await waitWorkspace(page, taskId, 'ready')
    expect(ws.root).toBe(path.join(home, 'fake-workspaces', path.basename(ws.root!)))
    expect((ws.repos ?? []).map((r) => r.name)).toEqual([alpha, beta])
    expect(git(path.join(ws.root!, 'src', alpha), 'status', '--porcelain')).toBe('')
    await expect.poll(async () => (await sessionsOf(page, taskId)).length, { timeout: 30_000 }).toBe(1)
    const [s] = await sessionsOf(page, taskId)
    expect(s.cwd).toBe(ws.root)
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${s.claudeSessionId}"]`)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expect(waiting).toHaveCount(0)
    // Its first turn is over (a session mid-turn holds a manual removal back).
    await expect(panel.getByText('Hello! I processed your message: Wire the two packages together').first()).toBeVisible({ timeout: 30_000 })
    // (The mock CLI may exit after its turn, so the badge reads Idle or Stopped.)
    await expect(panel.locator('.session-panel-badge').filter({ hasText: /^(Idle|Stopped)$/ })).toHaveCount(1, { timeout: 30_000 })

    // An ignored build folder in one package: the confirm says it goes too.
    const alphaRepo = inHome(path.join(ws.root!, 'src', alpha))
    fs.appendFileSync(path.join(alphaRepo, '.git', 'info', 'exclude'), 'build/\n')
    fs.mkdirSync(path.join(alphaRepo, 'build'), { recursive: true })
    fs.writeFileSync(path.join(alphaRepo, 'build', 'out.txt'), 'built\n')

    // The flyout names the provider and both repositories; Remove names what goes.
    const flyout = await openPanelWorkspaceFlyout(page, panel)
    await expect(flyout).toContainText('Fake multi-repo')
    await expect(flyout.locator('.workspace-repo')).toHaveText([alpha, beta])
    await shot(page, 'flyout-plugin', flyout)
    await flyout.getByTestId('workspace-remove').click()
    const dialog = page.getByRole('dialog', { name: /Remove the workspace of/ })
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await expect(dialog.getByTestId('workspace-remove-plan')).toContainText(ws.root!)
    await expect(dialog.getByTestId('workspace-remove-plan')).toContainText('2 repositories')
    await expect(dialog.getByTestId('workspace-remove-plan')).toContainText(`Also deletes 1 entry git ignores, which no commit holds: ${alpha}/build/.`)
    await shot(page, 'remove-confirm', dialog.locator('.app-modal'))
    await dialog.getByRole('button', { name: 'Remove workspace' }).click()
    await waitWorkspace(page, taskId, 'removed')
    expect(fs.existsSync(ws.root!)).toBe(false)
  } finally {
    fs.rmSync(failKnob, { force: true })
    fs.rmSync(delayKnob, { force: true })
  }
  expect(audit.errors).toEqual([])
  expect(audit.failed).toEqual([])
})
