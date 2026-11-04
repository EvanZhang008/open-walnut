/**
 * A session's git state at a glance, read from a REAL repository by the
 * server's own git code (git-glance-fixture.ts):
 *   - the task row's pill names the branch, the uncommitted files, their +/-
 *     lines and the commit not pushed;
 *   - the session's Changed chip counts the files its tab lists, and the tab's
 *     strip repeats the git state;
 *   - while the tab is open, an edit the session makes shows up by itself
 *     (no Re-scan click): the list, the strip and the chip's number follow.
 */
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { GIT_GLANCE_BRANCH, GIT_GLANCE_SESSION, GIT_GLANCE_TASK } from './git-glance-fixture'

// One repo shared by every case, and the last case edits it.
test.describe.configure({ mode: 'serial' })

async function repoPath(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${GIT_GLANCE_SESSION}`)
  expect(res.ok()).toBeTruthy()
  const body = await res.json() as { cwd?: string; session?: { cwd?: string } }
  const cwd = body.cwd ?? body.session?.cwd
  expect(cwd, 'the fixture session has its repo as cwd').toBeTruthy()
  return cwd!
}

async function taskRow(page: Page) {
  await page.locator('.todo-search-input').fill('Git glance fixture')
  const row = page.locator(`.todo-panel-item[data-task-id="${GIT_GLANCE_TASK}"]`)
  await expect(row).toBeVisible()
  return row
}

async function openPanel(page: Page) {
  const row = await taskRow(page)
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${GIT_GLANCE_SESSION}"]`)
  await expect(panel).toBeVisible()
  return panel
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('the task row shows the branch, uncommitted files, +/- lines and the unpushed commit', async ({ page }) => {
  const row = await taskRow(page)
  const pill = row.getByTestId('git-glance-pill')
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await expect(pill.locator('.git-glance-branch')).toHaveText(GIT_GLANCE_BRANCH)
  await expect(pill.getByTestId('git-glance-files')).toHaveText('2')
  // src/app.ts +3 -1, src/feature.ts (new) +3.
  await expect(pill.locator('.git-glance-add')).toHaveText('+6')
  await expect(pill.locator('.git-glance-del')).toHaveText('−1')
  await expect(pill.getByTestId('git-glance-ahead')).toHaveText('↑1')
  const title = await pill.getAttribute('title')
  expect(title).toContain(`branch ${GIT_GLANCE_BRANCH}, tracking origin/${GIT_GLANCE_BRANCH}`)
  expect(title).toContain('2 changed files not committed, 1 new')
  expect(title).toContain('1 commit not pushed')
})

test('the Changed chip counts what its tab lists, and the tab shows the git strip', async ({ page }) => {
  const panel = await openPanel(page)
  const chip = panel.getByTestId('session-changed-chip')
  // The number is there before the tab is ever opened, and its tooltip says what it counts.
  await expect(chip.getByTestId('session-changed-count')).toHaveText('2', { timeout: 20_000 })
  expect(await chip.getAttribute('title')).toContain('This session changed 2 files (2 still uncommitted in its repo)')
  await chip.click()
  const diff = panel.locator('.session-diff-view')
  await expect(diff).toBeVisible()
  await expect(diff.locator('.session-diff-toolbar-title')).toContainText('2 files changed', { timeout: 20_000 })
  const strip = diff.getByTestId('session-diff-gitstrip')
  await expect(strip).toBeVisible()
  await expect(strip.locator('.git-glance-branch')).toHaveText(GIT_GLANCE_BRANCH)
  await expect(strip.getByTestId('git-glance-files')).toHaveText('2 uncommitted files')
  await expect(strip.getByTestId('git-glance-ahead')).toHaveText('↑1 unpushed')
  // The chip's number is the tab's own count, there whether the tab is open or not.
  await expect(chip.getByTestId('session-changed-count')).toHaveText('2', { timeout: 15_000 })
  await chip.click()
  await expect(diff).toBeHidden()
  await expect(chip.getByTestId('session-changed-count')).toHaveText('2')
})

test('an open Changed tab follows the session as it edits, with no Re-scan', async ({ page }) => {
  test.setTimeout(120_000)
  const repo = await repoPath(page)
  const panel = await openPanel(page)
  const chip = panel.getByTestId('session-changed-chip')
  await chip.click()
  const diff = panel.locator('.session-diff-view')
  await expect(diff.locator('.session-diff-toolbar-title')).toContainText('files changed', { timeout: 20_000 })
  const before = Number((await diff.locator('.session-diff-toolbar-title').innerText()).match(/(\d+) files? changed/)![1])
  // The user is reading src/app.ts and has started a comment on one of its lines.
  await diff.locator('.session-diff-tree').getByText('app.ts', { exact: true }).click()
  const pane = diff.locator('.session-diff-filepane[data-file-path$="/src/app.ts"]')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  await pane.locator('.diff-gutter').first().click()
  const box = pane.locator('.session-diff-comment-input')
  await expect(box).toBeVisible()
  await box.fill('half-typed note')

  // The session writes one more file: on disk, and in its transcript.
  const name = `extra-${Date.now()}.ts`
  const file = path.join(repo, 'src', name)
  await fs.writeFile(file, 'export const extra = 1\n')
  const jsonl = path.join(path.dirname(repo), '..', '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'), `${GIT_GLANCE_SESSION}.jsonl`)
  await fs.appendFile(jsonl, JSON.stringify({
    type: 'assistant', sessionId: GIT_GLANCE_SESSION, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${name}`, name: 'Write', input: { file_path: file, content: 'export const extra = 1\n' } }] },
  }) + '\n')

  // No click: the tab re-reads its repos, sees the change, and re-reads the list.
  await expect(diff.locator('.session-diff-toolbar-title')).toContainText(`${before + 1} files changed`, { timeout: 60_000 })
  await expect(diff.locator('.session-diff-tree').getByText(name)).toBeVisible()
  await expect(diff.getByTestId('session-diff-gitstrip').getByTestId('git-glance-files')).toHaveText(`${before + 1} uncommitted files`)
  await expect(chip.getByTestId('session-changed-count')).toHaveText(String(before + 1), { timeout: 15_000 })
  // What the user was doing survived the re-read: the same file, the comment and its text.
  await expect(pane).toBeVisible()
  await expect(box).toHaveValue('half-typed note')
  // Another file changed: the commented line did not, so no warning.
  await expect(diff.getByTestId('session-diff-comment-changed')).toBeHidden()

  // Now the session edits the very line under the comment: the box says so, and keeps the words.
  const appTs = path.join(repo, 'src', 'app.ts')
  const before1 = await fs.readFile(appTs, 'utf8')
  const after1 = before1.replace('export function app(): string {', 'export function app(): number {')
  expect(after1).not.toBe(before1)
  await fs.writeFile(appTs, after1)
  await fs.appendFile(jsonl, JSON.stringify({
    type: 'assistant', sessionId: GIT_GLANCE_SESSION, timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_line_${Date.now()}`, name: 'Edit', input: { file_path: appTs, old_string: 'export function app(): string {', new_string: 'export function app(): number {' } }] },
  }) + '\n')
  await expect(diff.getByTestId('session-diff-comment-changed')).toBeVisible({ timeout: 60_000 })
  await expect(box).toHaveValue('half-typed note')
})
