/**
 * The Changed tab's commit view, end to end on its own fixture
 * (session-commit.config.ts): two mock-CLI sessions edit the SAME file through a
 * real local daemon; session A's commit view preselects only A's hunk; the
 * commit leaves B's hunk uncommitted; a push lands on the bare remote; the PR
 * action stays hidden without gh; in B's view a failing pre-commit hook shows its
 * output and commits nothing, and the retry commits B's hunk.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { draftComposer, draftCwdPill, openDraft, REAL_PANEL } from './draft-helpers'

interface Fixture { port: number; root: string; project: string; remote: string }
let fx: Fixture
const port = Number(process.env.PW_TEST_PORT ?? 3514)
const shots = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-commit'
const problems = new WeakMap<Page, string[]>()

function git(cwd: string, args: string[]): string {
  if (!path.resolve(cwd).startsWith(fx.root + path.sep)) throw new Error('git outside the fixture root: ' + cwd)
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: fx.root, GIT_CONFIG_GLOBAL: path.join(fx.root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' })
}

// The main config also matches this file; it runs only under session-commit.config.ts.
test.skip(!process.env.SESSION_COMMIT_MANIFEST, 'Requires the session-commit.config.ts fixture')
test.describe.configure({ mode: 'serial' })

test.beforeAll(() => {
  fx = JSON.parse(fs.readFileSync(process.env.SESSION_COMMIT_MANIFEST!, 'utf8')) as Fixture
  expect(fx.root).toContain('walnut-session-commit-ui-')
  expect(fx.port).toBe(port)
  fs.mkdirSync(shots, { recursive: true })
})

test.beforeEach(({ page }) => {
  const found: string[] = []
  problems.set(page, found)
  page.on('pageerror', (e) => found.push('pageerror: ' + e.message))
  page.on('response', (r) => {
    const p = new URL(r.url()).pathname
    // The Changed tab's AI strips answer 503 here by design: this fixture runs no
    // background AI (WALNUT_DISABLE_BACKGROUND_AI), and they are not under test.
    if (/\/changes\/(triage|summary)$/.test(p)) return
    if (r.status() >= 500) found.push(`${r.status()} ${p}`)
  })
})

test.afterEach(({ page }) => {
  expect(problems.get(page)).toEqual([])
})

async function openWalnut(page: Page) {
  await page.setContent(`<a href="http://localhost:${port}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 60_000 })
}

/** Start a session in the project through the draft column; resolves its sid once its turn is over. */
async function startEditingSession(page: Page, edits: Array<{ file: string; old: string; new: string }>, text: string): Promise<{ sid: string; taskId: string }> {
  const draft = await openDraft(page)
  await draftCwdPill(draft).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible()
  await picker.locator('.sps-search-input').fill(fx.project)
  await picker.locator('.sps-search-input').press('Shift+Enter')
  await expect(picker).toBeHidden()
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).fill('file-edit-turn:' + JSON.stringify({ edits, text }))
  await draftComposer(page).press('Enter')
  const response = await started
  expect(response.ok()).toBe(true)
  const { taskId } = await response.json() as { taskId: string }
  let sid = ''
  await expect.poll(async () => {
    const rows = (await (await page.request.get(`/api/sessions/task/${taskId}`)).json()).sessions as Array<{ claudeSessionId: string }>
    sid = rows[0]?.claudeSessionId ?? ''
    return sid
  }, { timeout: 30_000 }).not.toBe('')
  await expect.poll(async () => (await (await page.request.get(`/api/sessions/${sid}`)).json()).session?.process_status, { timeout: 60_000 }).toBe('idle')
  return { sid, taskId }
}

async function openCommitView(page: Page, { sid, taskId }: { sid: string; taskId: string }): Promise<Locator> {
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  // A newer column may have taken this session's place: reopen it from its task row.
  if (!(await panel.isVisible())) await page.locator(`.todo-panel-item[data-task-id="${taskId}"] .todo-item-title`).click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await panel.getByRole('button', { name: 'Changed' }).click()
  const commit = panel.locator('[data-testid="session-commit-btn"]')
  await expect(commit).toBeEnabled({ timeout: 30_000 })
  await commit.click()
  const dialog = page.locator('[data-testid="session-commit-dialog"]')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-testid="scd-repo"]')).toBeVisible({ timeout: 90_000 })
  return dialog
}

async function shot(target: Locator, name: string) {
  await target.screenshot({ path: path.join(shots, name) })
}

test('commit only this session\'s hunk, push it, and commit the other session\'s hunk past a failing hook', async ({ page, browserName }) => {
  const file = `shared-${browserName}.txt`
  const abs = path.join(fx.project, file)
  const head = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('')
  fs.writeFileSync(abs, head)
  git(fx.project, ['add', file])
  git(fx.project, ['commit', '-q', '-m', `Add ${file}`])
  git(fx.project, ['push', '-q', 'origin', 'main'])
  const baseHead = git(fx.project, ['rev-parse', 'HEAD']).trim()

  await openWalnut(page)
  const a = await startEditingSession(page, [{ file, old: 'line 5\n', new: 'line five (A)\n' }], 'A changed line 5.')
  const b = await startEditingSession(page, [{ file, old: 'line 25\n', new: 'line twenty-five (B)\n' }], 'B changed line 25.')
  const work = fs.readFileSync(abs, 'utf8')
  expect(work).toBe(head.replace('line 5\n', 'line five (A)\n').replace('line 25\n', 'line twenty-five (B)\n'))

  // ── A's view: only A's hunk is preselected ──
  let dialog = await openCommitView(page, a)
  const row = dialog.locator(`[data-testid="scd-file"][data-path="${file}"]`)
  await expect(row).toHaveAttribute('data-owner', 'mixed')
  await expect(row).toHaveAttribute('data-state', 'some')
  const hunks = row.locator('[data-testid="scd-hunk"]')
  await expect(hunks).toHaveCount(2)
  await expect(hunks.nth(0)).toHaveAttribute('data-owner', 'mine')
  await expect(hunks.nth(0)).toHaveAttribute('data-checked', '1')
  await expect(hunks.nth(0)).toContainText('line five (A)')
  await expect(hunks.nth(1)).toHaveAttribute('data-owner', 'other')
  await expect(hunks.nth(1)).toHaveAttribute('data-checked', '0')
  await expect(hunks.nth(1)).toContainText('Not this session')
  await shot(dialog, `${browserName}-1-preselected.png`)

  // Suggest drafts a message from the selection (the fixture's model is a mock).
  const message = dialog.locator('[data-testid="scd-message"]')
  await dialog.locator('[data-testid="scd-suggest"]').click()
  await expect(message).not.toHaveValue('', { timeout: 60_000 })
  await message.fill('Rename line five')
  await dialog.locator('[data-testid="scd-commit"]').click()
  await expect(dialog.locator('[data-testid="scd-commit-ok"]')).toBeVisible({ timeout: 60_000 })
  const sha = (await dialog.locator('[data-testid="scd-commit-sha"]').getAttribute('title'))!
  expect(git(fx.project, ['rev-parse', 'HEAD']).trim()).toBe(sha)
  expect(git(fx.project, ['rev-parse', 'HEAD~1']).trim()).toBe(baseHead)
  expect(git(fx.project, ['log', '-1', '--format=%s']).trim()).toBe('Rename line five')
  const committed = git(fx.project, ['show', `HEAD:${file}`])
  expect(committed).toContain('line five (A)')
  expect(committed).not.toContain('line twenty-five (B)')
  expect(fs.readFileSync(abs, 'utf8')).toBe(work)
  expect(git(fx.project, ['diff', 'HEAD', '--', file])).toContain('+line twenty-five (B)')
  expect(git(fx.project, ['diff', '--cached', '--name-only']).trim()).toBe('')
  // The view reloads: B's hunk is all that is left, unchecked, so Commit is off.
  await expect(row.locator('[data-testid="scd-hunk"]')).toHaveCount(1)
  await expect(row).toHaveAttribute('data-state', 'none')
  await expect(dialog.locator('[data-testid="scd-commit"]')).toBeDisabled()
  await shot(dialog, `${browserName}-2-committed.png`)

  // ── Push behind a confirm that names the remote and the branch; no PR without gh ──
  await expect(dialog.locator('[data-testid="scd-pr"]')).toHaveCount(0)
  const plan = await (await page.request.get(`/api/sessions/${a.sid}/commit/plan`)).json()
  expect(plan.repos[0].pr).toEqual({ available: false, reason: 'no-gh' })
  await dialog.locator('[data-testid="scd-push"]').click()
  const confirm = dialog.locator('[data-testid="scd-confirm"]')
  await expect(confirm).toContainText('Push main to origin as main?')
  await shot(confirm, `${browserName}-3-push-confirm.png`)
  await confirm.locator('[data-testid="scd-confirm-ok"]').click()
  await expect(dialog.locator('[data-testid="scd-push-ok"]')).toBeVisible({ timeout: 60_000 })
  expect(git(fx.remote, ['rev-parse', 'main']).trim()).toBe(sha)
  await dialog.locator('.scd-close').click()
  await expect(dialog).toBeHidden()
  // The Changed view is full-screen over the other columns: toggle A's off to reach B.
  await page.locator(`${REAL_PANEL}[data-session-id="${a.sid}"]`).getByRole('button', { name: 'Changed' }).click()

  // ── B's view: B's hunk is preselected; a failing pre-commit hook commits nothing ──
  const hook = path.join(fx.project, '.git/hooks/pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\necho "lint failed: trailing words in shared file" >&2\nexit 1\n', { mode: 0o755 })
  try {
    dialog = await openCommitView(page, b)
    const rowB = dialog.locator(`[data-testid="scd-file"][data-path="${file}"]`)
    await expect(rowB).toHaveAttribute('data-owner', 'mine')
    await expect(rowB).toHaveAttribute('data-state', 'all')
    await dialog.locator('[data-testid="scd-message"]').fill('Rename line twenty-five')
    await dialog.locator('[data-testid="scd-commit"]').click()
    const job = dialog.locator('[data-testid="scd-job"]')
    await expect(job).toHaveAttribute('data-state', 'failed', { timeout: 60_000 })
    await expect(job.locator('[data-testid="scd-error"]')).toContainText('pre-commit hook failed')
    await expect(job.locator('[data-testid="scd-job-output"]')).toContainText('lint failed: trailing words in shared file')
    expect(git(fx.project, ['rev-parse', 'HEAD']).trim()).toBe(sha)
    await shot(dialog, `${browserName}-4-hook-failed.png`)
  } finally {
    fs.rmSync(hook, { force: true })
  }
  // The message survived the failure; the retry goes through.
  await expect(dialog.locator('[data-testid="scd-message"]')).toHaveValue('Rename line twenty-five')
  await dialog.locator('[data-testid="scd-commit"]').click()
  await expect(dialog.locator('[data-testid="scd-commit-ok"]')).toBeVisible({ timeout: 60_000 })
  expect(git(fx.project, ['log', '-1', '--format=%s']).trim()).toBe('Rename line twenty-five')
  expect(git(fx.project, ['show', `HEAD:${file}`])).toBe(work)
  expect(git(fx.project, ['status', '--porcelain', '--', file]).trim()).toBe('')
  // The view reloads: nothing of B's is left.
  await expect(dialog.getByText('Nothing this session changed is left uncommitted here.')).toBeVisible({ timeout: 30_000 })
  await expect(dialog.locator('.scd-reload')).toHaveText('Reload')
  await shot(dialog, `${browserName}-5-retry-committed.png`)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
