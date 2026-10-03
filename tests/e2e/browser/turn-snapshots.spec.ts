/**
 * Per-turn snapshots and the rewind guard, end to end on the fixture server: a
 * mock-CLI session in a temp git repo writes files over several turns, the
 * fixture's MockDaemon runs the REAL snapshot and guard cores (pinned to the
 * fixture's turn-repos root), and every check reads the files back from disk.
 *
 *  1. The Turns view lists each turn with the files it changed, a turn's diff
 *     renders, a restore puts the files back, and its Undo brings them back.
 *  2. A rewind whose file restore would undo another session's edit names that
 *     session, and each of the three choices does what it says.
 *
 * Run: PW_TEST_PORT=3512 npx playwright test tests/e2e/browser/turn-snapshots.spec.ts
 *      (WebKit: PW_WEBKIT=1 … --project=webkit)
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/turn-snapshots'
const REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']

let turnRoot = ''

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

const browserErrors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    const p = new URL(response.url()).pathname
    // The Files view's AI summary and triage ask the session's CLI a side
    // question; the mock CLI cannot answer one, and those routes say so with a
    // documented 503. Not this feature's routes.
    if (response.status() === 503 && /\/changes\/(summary|triage)$/.test(p)) return
    if (response.status() >= 500) errors.push(`${response.status()} ${p}`)
  })
})
test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page)).toEqual([])
})

test.beforeAll(async () => {
  const { walnutHome } = await discoverBrowserFixture(TEST_PORT)
  turnRoot = fs.realpathSync(path.join(walnutHome, 'turn-repos'))
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(turnRoot, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.invalid\n')
})

function git(cwd: string, ...args: string[]): string {
  if (!turnRoot || !cwd.startsWith(turnRoot + path.sep)) throw new Error('refusing to run git outside the fixture turn root: ' + cwd)
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(turnRoot, 'gitconfig'), GIT_CEILING_DIRECTORIES: turnRoot }
  for (const v of REDIRECT_VARS) delete env[v]
  return execFileSync('git', args, { cwd, env, encoding: 'utf-8' })
}

/** A fresh repo under the fixture's turn root with shared.md committed. */
function makeRepo(name: string): string {
  const repo = path.join(turnRoot, `${name}-${test.info().project.name}-${Date.now().toString(36)}`)
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'shared.md'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

const read = (repo: string, rel: string): string | null => {
  try { return fs.readFileSync(path.join(repo, rel), 'utf-8') } catch { return null }
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

/** Start a session on `cwd` from a draft column; returns its id and panel. */
async function startSession(page: Page, cwd: string, prompt: string): Promise<{ sessionId: string; panel: Locator }> {
  await openDraftOnCwd(page, cwd)
  const quickStart = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(prompt)
  await input.press('Enter')
  const res = await quickStart
  expect(res.status()).toBe(200)
  const { taskId } = await res.json() as { taskId: string }
  let sessionId = ''
  await expect.poll(async () => {
    const r = await page.request.get(`/api/sessions/task/${taskId}`)
    const sessions = ((await r.json()) as { sessions: Array<{ claudeSessionId: string }> }).sessions
    sessionId = sessions[0]?.claudeSessionId ?? ''
    return sessionId
  }, { timeout: 20_000 }).not.toBe('')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return { sessionId, panel }
}

async function waitWrote(panel: Locator, rel: string, count: number): Promise<void> {
  await expect(panel.locator('.session-history').getByText(`Wrote ${rel}.`, { exact: true })).toHaveCount(count, { timeout: 30_000 })
}

async function sendTurn(panel: Locator, prompt: string): Promise<void> {
  const composer = panel.locator('.chat-input-textarea')
  await composer.fill(prompt)
  await composer.press('Enter')
}

/** Poll the API until the session has a snapshot numbered `n` (snapshots land just after the turn ends). */
async function waitSnapshot(page: Page, sessionId: string, n: number): Promise<void> {
  await expect.poll(async () => {
    const r = await page.request.get(`/api/sessions/${sessionId}/turns`)
    const body = await r.json() as { snapshots?: Array<{ n: number }> }
    return (body.snapshots ?? []).some((s) => s.n === n)
  }, { timeout: 20_000 }).toBe(true)
}

test('the Turns view lists each turn with its files, renders a turn diff, restores, and undoes', async ({ page }) => {
  test.setTimeout(150_000)
  const engine = test.info().project.name
  const repo = makeRepo('turns')
  await openHome(page)
  const { sessionId, panel } = await startSession(page, repo, 'snapshot-write-turn:shared.md:first edit')
  await waitWrote(panel, 'shared.md', 1)
  await sendTurn(panel, 'snapshot-write-turn:notes/second.md:second file')
  await waitWrote(panel, 'notes/second.md', 1)
  await waitSnapshot(page, sessionId, 2)

  await panel.getByRole('button', { name: 'Changed' }).click()
  await panel.getByRole('tab', { name: 'Turns' }).click()
  const view = panel.getByTestId('session-turns-view')
  await expect(view).toBeVisible()

  // One row per snapshot, newest first: turn 2, turn 1, and the start.
  const rows = view.locator('.turns-item')
  await expect(rows).toHaveCount(3, { timeout: 15_000 })
  await expect(rows.nth(0)).toHaveAttribute('data-turn-n', '2')
  await expect(rows.nth(0)).toContainText('Turn 2')
  await expect(rows.nth(0)).toContainText('1 file · +1 −0')
  await expect(rows.nth(1)).toContainText('Turn 1')
  await expect(rows.nth(1)).toContainText('1 file · +1 −1')
  await expect(rows.nth(2)).toContainText('Session start')

  // The newest turn is open with its file and its diff.
  await expect(rows.nth(0).locator('.turns-file')).toHaveText(/notes\/second\.md/)
  await expect(view.locator('.session-diff-main')).toContainText('second file')

  // Turn 1: shared.md, base → first edit.
  await rows.nth(1).locator('.turns-row').click()
  await expect(rows.nth(1).locator('.turns-file')).toHaveCount(1)
  await expect(rows.nth(1).locator('.turns-file')).toContainText('shared.md')
  const main = view.locator('.session-diff-main')
  await expect(main).toContainText('first edit')
  await expect(main).toContainText('base')
  await expect(main.locator('.turns-main-title')).toHaveText('Turn 1')
  await view.screenshot({ path: `${SHOTS}/${engine}-01-turns-view.png` })

  // Restore to turn 1: the confirm names the file that goes away and the undo.
  await main.getByRole('button', { name: 'Restore to this turn' }).click()
  const dialog = page.locator('.turn-restore-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Removed · 1', { timeout: 20_000 })
  await expect(dialog).toContainText('notes/second.md')
  await expect(dialog).toContainText('snapshots the current files first')
  await dialog.screenshot({ path: `${SHOTS}/${engine}-02-restore-confirm.png` })
  await dialog.getByRole('button', { name: 'Restore 1 file' }).click()
  // A restore is a backup snapshot, the checkout and the after snapshot: several
  // git runs, seconds on a loaded machine.
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  await expect(view.locator('.turns-strip-ok')).toContainText('Restored 1 file to Turn 1.')
  expect(read(repo, 'notes/second.md')).toBeNull()
  expect(read(repo, 'shared.md')).toBe('first edit\n')
  // The state after the restore is a snapshot of its own.
  await expect(rows.first()).toContainText('Restored to Turn 1', { timeout: 20_000 })

  // Undo: back to the state before the restore (turn 2's files).
  await view.locator('.turns-strip-ok').getByRole('button', { name: 'Undo' }).click()
  const undo = page.locator('.turn-restore-dialog')
  await expect(undo).toContainText('Written back · 1', { timeout: 20_000 })
  await undo.getByRole('button', { name: 'Restore 1 file' }).click()
  await expect(undo).toHaveCount(0, { timeout: 30_000 })
  expect(read(repo, 'notes/second.md')).toBe('second file\n')
  expect(read(repo, 'shared.md')).toBe('first edit\n')
  await expect(rows.first()).toContainText('Restored to Turn 2', { timeout: 20_000 })
  await view.screenshot({ path: `${SHOTS}/${engine}-03-after-undo.png` })

  // The user's own git state never moved: no commit, nothing staged.
  expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
  expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('')
  expect(git(repo, 'for-each-ref', '--format=%(refname)', `refs/walnut/turns/${sessionId}/`).split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(4)
})

/**
 * Session A writes shared.md in two turns, then session B (same repo) writes it.
 * Returns A's panel with the rewind dialog's guard step open on A's second message.
 */
async function openGuard(page: Page, name: string) {
  const repo = makeRepo(name)
  await openHome(page)
  const a = await startSession(page, repo, 'snapshot-write-turn:shared.md:A one')
  await waitWrote(a.panel, 'shared.md', 1)
  await sendTurn(a.panel, 'snapshot-write-turn:shared.md:A two')
  await waitWrote(a.panel, 'shared.md', 2)
  await waitSnapshot(page, a.sessionId, 2)
  const b = await startSession(page, repo, 'snapshot-write-turn:shared.md:B edit')
  await waitWrote(b.panel, 'shared.md', 1)
  expect(read(repo, 'shared.md')).toBe('B edit\n')
  const bTitle = ((await (await page.request.get(`/api/sessions/${b.sessionId}`)).json()) as { session: { title?: string } }).session.title ?? ''
  expect(bTitle).not.toBe('')
  return { repo, a, b, bTitle }
}

async function openRewindWithFiles(page: Page, panel: Locator): Promise<Locator> {
  const target = panel.locator('.session-msg', { hasText: 'snapshot-write-turn:shared.md:A two' }).first()
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await target.locator('.msg-rewind-btn').click()
  const dialog = page.locator('.rewind-dialog')
  await expect(dialog).toBeVisible()
  const files = dialog.locator('.rewind-dialog-option').first().locator('input[type="checkbox"]')
  await expect(files).toBeEnabled({ timeout: 15_000 })
  await files.check()
  await expect(dialog.locator('.rewind-dialog-files')).toContainText('shared.md')
  await dialog.getByRole('button', { name: 'Rewind + files' }).click()
  const guard = page.locator('.rewind-guard-dialog')
  await expect(guard).toBeVisible({ timeout: 15_000 })
  return guard
}

function rewindCommits(page: Page): Array<{ restore_files?: boolean }> {
  const seen: Array<{ restore_files?: boolean }> = []
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !/\/api\/sessions\/[^/]+\/rewind$/.test(new URL(req.url()).pathname)) return
    const body = req.postDataJSON() as { dry_run?: boolean; restore_files?: boolean }
    if (!body.dry_run) seen.push({ restore_files: body.restore_files })
  })
  return seen
}

test('the rewind guard names the session that changed a file; Cancel and Restore anyway', async ({ page }) => {
  test.setTimeout(180_000)
  const engine = test.info().project.name
  const commits = rewindCommits(page)
  const { repo, a, bTitle } = await openGuard(page, 'guard-a')

  const guard = await openRewindWithFiles(page, a.panel)
  await expect(guard).toContainText('A file changed after this session wrote it')
  await expect(guard.getByTestId('rewind-guard-files')).toContainText('shared.md')
  await expect(guard.getByTestId('rewind-guard-files')).toContainText(`Changed by “${bTitle}”`)
  await guard.screenshot({ path: `${SHOTS}/${engine}-04-rewind-guard.png` })

  // Cancel: nothing happens.
  await guard.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.rewind-guard-dialog')).toHaveCount(0)
  await expect(page.locator('.rewind-dialog')).toHaveCount(0)
  expect(commits).toEqual([])
  expect(read(repo, 'shared.md')).toBe('B edit\n')

  // Restore anyway: the conversation rewinds AND the file goes back to before A's second turn.
  const again = await openRewindWithFiles(page, a.panel)
  await again.getByRole('button', { name: 'Restore anyway' }).click()
  await expect(page.locator('.rewind-guard-dialog')).toHaveCount(0, { timeout: 30_000 })
  expect(commits).toEqual([{ restore_files: true }])
  await expect.poll(() => read(repo, 'shared.md'), { timeout: 15_000 }).toBe('A one\n')
})

test('the rewind guard: Rewind conversation only leaves the files alone', async ({ page }) => {
  test.setTimeout(180_000)
  const commits = rewindCommits(page)
  const { repo, a } = await openGuard(page, 'guard-b')
  const guard = await openRewindWithFiles(page, a.panel)
  await guard.getByRole('button', { name: 'Rewind conversation only' }).click()
  await expect(page.locator('.rewind-guard-dialog')).toHaveCount(0, { timeout: 30_000 })
  expect(commits).toEqual([{ restore_files: false }])
  await page.waitForTimeout(1500)
  expect(read(repo, 'shared.md')).toBe('B edit\n')
})

test('no conflict: the rewind dialog behaves as before (no guard step)', async ({ page }) => {
  test.setTimeout(150_000)
  const commits = rewindCommits(page)
  const repo = makeRepo('guard-none')
  await openHome(page)
  const a = await startSession(page, repo, 'snapshot-write-turn:shared.md:A one')
  await waitWrote(a.panel, 'shared.md', 1)
  await sendTurn(a.panel, 'snapshot-write-turn:shared.md:A two')
  await waitWrote(a.panel, 'shared.md', 2)
  await waitSnapshot(page, a.sessionId, 2)
  const target = a.panel.locator('.session-msg', { hasText: 'snapshot-write-turn:shared.md:A two' }).first()
  await target.scrollIntoViewIfNeeded()
  await target.hover()
  await target.locator('.msg-rewind-btn').click()
  const dialog = page.locator('.rewind-dialog')
  const files = dialog.locator('.rewind-dialog-option').first().locator('input[type="checkbox"]')
  await expect(files).toBeEnabled({ timeout: 15_000 })
  await files.check()
  await dialog.getByRole('button', { name: 'Rewind + files' }).click()
  await expect(page.locator('.rewind-dialog')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.rewind-guard-dialog')).toHaveCount(0)
  expect(commits).toEqual([{ restore_files: true }])
  await expect.poll(() => read(repo, 'shared.md'), { timeout: 15_000 }).toBe('A one\n')
})
