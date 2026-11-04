/**
 * The Changed tab's compare picker, Viewed marks and Ignore whitespace, on a
 * REAL git repository (compare-fixture.ts): "Branch vs <default branch>", any
 * branch (searchable), one of the newest commits, a Viewed mark that turns into
 * "changed" when the file changes again, and a whitespace-only commit.
 *
 * Needs its own fixture: PW_COMPARE_FIXTURE=1 on its own port, e.g.
 *   PW_COMPARE_FIXTURE=1 PW_TEST_PORT=3531 ./node_modules/.bin/playwright test tests/e2e/browser/diff-compare.spec.ts --project=chromium
 *   PW_COMPARE_FIXTURE=1 PW_TEST_PORT=3531 PW_WEBKIT=1 ./node_modules/.bin/playwright test tests/e2e/browser/diff-compare.spec.ts --project=webkit
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, type Page } from '@playwright/test'
import { leaveFullscreen } from './draft-helpers'

const SESSION_ID = 'pw-compare-session'
const TASK_ID = 'pw-task-compare'

test.skip(process.env.PW_COMPARE_FIXTURE !== '1', 'needs PW_COMPARE_FIXTURE=1 on its own PW_TEST_PORT')
// One fixture repo and one remembered comparison per session: serial.
test.describe.configure({ mode: 'serial' })

const BRANCH_FILES = ['usage.md', 'todo.md', 'format.ts', 'index.ts', 'parser.ts', 'parser.test.ts']

async function openChanged(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // A panel kept full screen by the last visit comes back that way: start from the plain page.
  await leaveFullscreen(page)
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  // After a reload the app reopens the panel it last showed, over the task list.
  if (!(await panel.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false))) {
    await page.locator('.todo-search-input').fill(SESSION_ID)
    await page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"] .todo-item-title`).click()
  }
  await expect(panel).toBeVisible()
  // The Changed button toggles; a restored panel may already show the tab.
  const view = panel.locator('.session-diff-view')
  if (!(await view.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false))) {
    await panel.getByRole('button', { name: 'Changed' }).click()
  }
  await expect(panel.locator('.session-diff-view')).toBeVisible({ timeout: 10_000 })
  return panel
}

async function pick(page: Page, panel: ReturnType<Page['locator']>, name: RegExp) {
  await panel.locator('.session-diff-compare-trigger').click()
  const pop = page.getByRole('dialog', { name: 'Compare with' })
  await expect(pop).toBeVisible()
  await pop.getByRole('option', { name }).first().click()
  await expect(pop).toBeHidden()
}

async function treeNames(panel: ReturnType<Page['locator']>): Promise<string[]> {
  return panel.locator('.session-diff-tree-file .session-diff-tree-name').allTextContents()
}

async function repoRoot(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}/changes/refs`)
  expect(res.ok()).toBe(true)
  return (await res.json()).repoRoot as string
}

test('the picker lists the working-tree comparisons, every branch and the newest commits', async ({ page }) => {
  const panel = await openChanged(page)
  // The comparison is remembered per session: an earlier run may have left another.
  if (!(await panel.locator('.session-diff-compare-trigger').textContent())?.includes('What this session changed')) {
    await pick(page, panel, /What this session changed/)
  }
  await expect(panel.locator('.session-diff-compare-trigger')).toContainText('What this session changed')
  await expect.poll(() => treeNames(panel)).toEqual(['index.ts'])

  await panel.locator('.session-diff-compare-trigger').click()
  const pop = page.getByRole('dialog', { name: 'Compare with' })
  // The branch list is one git read on the server: under load it can take a few seconds.
  await expect(pop.getByRole('option', { name: /Branch vs origin\/main/ })).toBeVisible({ timeout: 15_000 })
  const refs = pop.locator('.sdc-item-ref .sdc-ref-name')
  // Every branch but the checked-out one (against itself it is only the uncommitted work)
  // and the default one (the "Branch vs origin/main" row above; a filter finds it there).
  await expect(refs).toHaveCount(3)
  expect((await refs.allTextContents()).sort()).toEqual(['experiment/cache', 'main', 'origin/release/1.x'])
  await expect(pop.getByText('Files this session edited')).toBeVisible()
  await expect(pop.locator('.sdc-section', { hasText: 'Commits on' })).toContainText('feature/parser-errors')
  const commits = pop.locator('.sdc-item-commit')
  await expect(commits).toHaveCount(7)
  await expect(commits.first().locator('.sdc-subject')).toHaveText('Rename the guide to usage')
  // The branch's own four commits carry the "on this branch" dot; main's do not.
  await expect(pop.locator('.sdc-item-commit .sdc-onbranch')).toHaveCount(4)

  // One filter narrows the options, branches and commits together; Esc closes and keeps the comparison.
  await page.keyboard.type('parser')
  await expect(refs).toHaveCount(0)
  await expect(commits.locator('.sdc-subject')).toHaveText(['Add parser tests'])
  await pop.getByRole('combobox', { name: 'Filter branches and commits' }).fill('release')
  await expect(refs).toHaveText(['origin/release/1.x'])
  await expect(commits).toHaveCount(0)
  await pop.getByRole('combobox', { name: 'Filter branches and commits' }).fill('origin/main')
  await expect(pop.locator('.sdc-item-quick')).toHaveText([/Branch vs origin\/main/])
  await expect(refs).toHaveCount(0)
  // The checked-out branch's name finds its working-tree rows (it is not listed as a branch).
  await pop.getByRole('combobox', { name: 'Filter branches and commits' }).fill('feature/parser-errors')
  await expect(pop.locator('.sdc-item-quick')).toHaveText([/Uncommitted changes/, /Not yet pushed/])
  await expect(refs).toHaveCount(0)
  await pop.getByRole('combobox', { name: 'Filter branches and commits' }).fill('pushed')
  await expect(pop.locator('.sdc-item-quick')).toHaveText([/Not yet pushed/])
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()
  await expect(panel.locator('.session-diff-compare-trigger')).toContainText('What this session changed')

  // Tab leaves the picker: it closes and the Compare button has the focus again.
  await panel.locator('.session-diff-compare-trigger').click()
  await expect(pop).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect(pop).toBeHidden()
  await expect(panel.locator('.session-diff-compare-trigger')).toBeFocused()
})

test('Branch vs the default branch: every file the branch changes since it left main, nothing main did after', async ({ page }) => {
  const panel = await openChanged(page)
  await pick(page, panel, /Branch vs origin\/main/)
  await expect(panel.locator('.session-diff-compare-trigger')).toContainText('Branch vs origin/main')
  const strip = panel.locator('.session-diff-compare-strip[data-compare="branch"]')
  await expect(strip).toContainText('origin/main')
  await expect(strip.locator('code')).toHaveText(/^[0-9a-f]{7}$/)
  await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(BRANCH_FILES)
  await expect(panel.locator('.session-diff-toolbar-title')).toContainText('6 files changed')
  // Hide whitespace marks the reindented file in the tree (git says so, no content needed).
  const ws = panel.locator('.session-diff-ws-toggle')
  if ((await ws.getAttribute('aria-pressed')) !== 'true') await ws.click()
  await expect(panel.locator('.session-diff-tree-file[data-ws-only="true"] .session-diff-tree-name')).toHaveText(['format.ts'])
  // One count everywhere: hiding whitespace changes how a diff reads, not what is listed.
  await expect(panel.locator('.session-diff-toolbar-title')).toContainText('6 files changed')
  await expect(panel.locator('.session-diff-toolbar-title')).toContainText('1 whitespace only')
  await expect(panel.locator('.session-diff-toolbar-title')).toContainText('0 of 6 viewed')
  await expect(panel.locator('.session-diff-tree-dir.is-repo .session-diff-tree-count')).toHaveText('6')
  await panel.locator('.session-diff-tree-file', { hasText: 'format.ts' }).click()
  await expect(panel.locator('.session-diff-filepane-path')).toHaveText('src/format.ts')
  await expect(panel.locator('.session-diff-viewed-toggle')).toHaveCount(1)
  await ws.click()
  await expect(panel.locator('.session-diff-tree-file[data-ws-only="true"]')).toHaveCount(0)
  // package.json changed on main after the branch left: not part of this branch.
  expect(await treeNames(panel)).not.toContain('package.json')

  // Each file's diff loads on selection, from git.
  await panel.locator('.session-diff-tree-file', { hasText: 'parser.test.ts' }).click()
  await expect(panel.locator('.session-diff-filepane-path')).toHaveText('test/parser.test.ts')
  await expect(panel.locator('.session-diff-main')).toContainText("throw new Error('line numbers')")
  await panel.locator('.session-diff-tree-file', { hasText: 'usage.md' }).click()
  await expect(panel.locator('.session-diff-main')).toContainText('File moved from docs/guide.md')
  // A move with nothing changed has no Markdown to render, and no comment hint without lines.
  await expect(panel.locator('.session-diff-rendered-toggle')).toHaveCount(0)
  await expect(panel.locator('.session-diff-filepane-hint')).toHaveCount(0)
  // The untracked note reads as untracked (U), not as a file git added.
  const note = panel.locator('.session-diff-tree-file', { hasText: 'todo.md' })
  await expect(note.locator('.session-diff-tree-status')).toHaveText('U')
  await note.click()
  await expect(panel.locator('.session-diff-filepane-head')).toContainText('untracked')
  await expect(panel.locator('.session-diff-rendered-toggle')).toHaveCount(1)

  // An untracked binary file: a placeholder, never its bytes as lines.
  const bin = path.join(await repoRoot(page), 'notes', 'logo.png')
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]))
  try {
    await panel.locator('.session-diff-refresh').click()
    await panel.locator('.session-diff-tree-file', { hasText: 'logo.png' }).click({ timeout: 15_000 })
    await expect(panel.locator('.session-diff-main')).toContainText('Binary file: no line diff to show.')
    await expect(panel.locator('.session-diff-main .diff-line')).toHaveCount(0)
  } finally {
    fs.rmSync(bin, { force: true })
  }
  await panel.locator('.session-diff-refresh').click()
  await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(BRANCH_FILES)

  // Remembered: a reload comes back to the same comparison.
  await page.reload()
  const again = await openChanged(page)
  await expect(again.locator('.session-diff-compare-trigger')).toContainText('Branch vs origin/main')
  await expect.poll(() => treeNames(again), { timeout: 15_000 }).toEqual(BRANCH_FILES)
})

test('any branch: picked from the filtered list with the keyboard, its merge-base decides the files', async ({ page }) => {
  const panel = await openChanged(page)
  await panel.locator('.session-diff-compare-trigger').click()
  // Typed straight after the click: nothing may be lost to the button.
  await page.keyboard.type('experiment')
  await page.keyboard.press('Enter')
  // experiment/cache sits where the branch left main: the same files as Branch vs origin/main.
  await expect(panel.locator('.session-diff-compare-trigger')).toContainText('Branch vs experiment/cache')
  await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(BRANCH_FILES)
})

test('switching comparisons keeps the open file when the new one has it', async ({ page }) => {
  const panel = await openChanged(page)
  await pick(page, panel, /Branch vs origin\/main/)
  await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(BRANCH_FILES)
  await panel.locator('.session-diff-tree-file', { hasText: 'parser.ts' }).first().click()
  await expect(panel.locator('.session-diff-filepane-path')).toHaveText('src/parser.ts')
  await panel.locator('.session-diff-compare-trigger').click()
  await page.getByRole('dialog', { name: 'Compare with' }).getByRole('option', { name: /experiment\/cache/ }).click()
  await expect(panel.locator('.session-diff-compare-trigger')).toContainText('Branch vs experiment/cache')
  await expect(panel.locator('.session-diff-filepane-path')).toHaveText('src/parser.ts', { timeout: 15_000 })
  await pick(page, panel, /Branch vs origin\/main/)
  await expect(panel.locator('.session-diff-filepane-path')).toHaveText('src/parser.ts', { timeout: 15_000 })
})

test('a remembered branch that was deleted: back to the default branch, with a note, not an error page', async ({ page }) => {
  const root = await repoRoot(page)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('branch', '-f', 'pw-gone', 'main')
  try {
    const panel = await openChanged(page)
    await panel.locator('.session-diff-compare-trigger').click()
    await page.keyboard.type('pw-gone')
    await page.keyboard.press('Enter')
    await expect(panel.locator('.session-diff-compare-trigger')).toContainText('Branch vs pw-gone')
    await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(BRANCH_FILES)
  } finally {
    git('branch', '-D', 'pw-gone')
  }
  await page.reload()
  const again = await openChanged(page)
  await expect(again.locator('.session-diff-notice')).toContainText('Branch pw-gone is no longer in this repository', { timeout: 15_000 })
  await expect(again.locator('.session-diff-error-box')).toHaveCount(0)
  await expect(again.locator('.session-diff-compare-trigger')).toContainText('Branch vs origin/main')
  await expect.poll(() => treeNames(again), { timeout: 15_000 }).toEqual(BRANCH_FILES)
})

test('Not yet pushed on a branch never pushed: everything since it left the default branch, for the session\'s files', async ({ page }) => {
  const panel = await openChanged(page)
  await pick(page, panel, /Not yet pushed/)
  await expect(panel.locator('.session-diff-error-box')).toHaveCount(0)
  await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(['index.ts'])
  // The list says it holds only the session's files (the branch has more).
  await expect(panel.locator('.session-diff-compare-strip[data-compare="remote"]')).toContainText('Only the files this session edited')
})

test('a window too narrow for a tree, a diff and the chat opens Changed without the chat, one click brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  const panel = await openChanged(page)
  const show = panel.locator('.session-diff-show-chat')
  await expect(show).toHaveText('Show chat')
  await expect(page.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(1)
  await expect.poll(() => panel.locator('.session-diff-view').evaluate((e) => e.clientWidth)).toBeGreaterThan(700)
  await show.click()
  await expect(page.locator('.session-panel-split.is-changed-open .session-panel-chat-col')).toBeVisible()
  await expect(page.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(0)
  await expect(show).toHaveCount(0)
})

test('one commit: only its files, its own content, named in the strip; Ignore whitespace empties a reindent', async ({ page }) => {
  const panel = await openChanged(page)
  await panel.locator('.session-diff-compare-trigger').click()
  await page.keyboard.type('Reindent')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.session-diff-compare-trigger')).toContainText(/Commit [0-9a-f]{7} · Reindent the formatter/)
  const strip = panel.locator('.session-diff-compare-strip[data-compare="commit"]')
  await expect(strip).toContainText('Reindent the formatter')
  await expect(strip).toContainText('Riley Park')
  await expect(strip).toContainText('vs parent')
  await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(['format.ts'])
  await expect(panel.locator('.session-diff-main')).toContainText('const out: string[] = []')

  const ws = panel.locator('.session-diff-ws-toggle')
  if ((await ws.getAttribute('aria-pressed')) === 'true') await ws.click()
  await ws.click()
  await expect(ws).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.session-diff-main')).toContainText('Only whitespace changed in this file.')
  await panel.getByRole('button', { name: 'Show whitespace (all files)' }).click()
  await expect(ws).toHaveAttribute('aria-pressed', 'false')
  await expect(panel.locator('.session-diff-main')).toContainText('const out: string[] = []')

  // Esc on the comparison help closes the help only, never the panel.
  const help = panel.locator('.session-diff-base-help')
  await help.focus()
  await expect(page.locator('.session-diff-base-popover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.session-diff-base-popover')).toHaveCount(0)
  await expect(panel.locator('.session-diff-view')).toBeVisible()

  // A picked commit is kept like any comparison: a reload comes back to it.
  await page.reload()
  const again = await openChanged(page)
  await expect(again.locator('.session-diff-compare-trigger')).toContainText(/Commit [0-9a-f]{7} · Reindent the formatter/, { timeout: 15_000 })
  await expect.poll(() => treeNames(again), { timeout: 15_000 }).toEqual(['format.ts'])
})

test('Viewed marks: tick, count, next unviewed, kept across a reload, and "changed" once the file changes again', async ({ page }) => {
  const root = await repoRoot(page)
  const parserPath = path.join(root, 'src/parser.ts')
  const original = fs.readFileSync(parserPath, 'utf8')
  try {
    const panel = await openChanged(page)
    await pick(page, panel, /Branch vs origin\/main/)
    await expect.poll(() => treeNames(panel), { timeout: 15_000 }).toEqual(BRANCH_FILES)
    // Clear marks a previous run left, so the counts below start at zero.
    for (const row of await panel.locator('.session-diff-tree-file.is-viewed').all()) {
      await row.click()
      await panel.locator('.session-diff-viewed-toggle input').uncheck()
    }
    await expect(panel.locator('.session-diff-viewed-count')).toHaveText('0 of 6 viewed')

    await panel.locator('.session-diff-tree-file', { hasText: 'parser.ts' }).first().click()
    await expect(panel.locator('.session-diff-filepane-path')).toHaveText('src/parser.ts')
    await panel.locator('.session-diff-viewed-toggle input').check()
    await expect(panel.locator('.session-diff-tree-file[data-viewed="viewed"]')).toHaveCount(1)
    await expect(panel.locator('.session-diff-viewed-count')).toHaveText('1 of 6 viewed')

    // Next unviewed opens a file not yet ticked.
    await panel.getByRole('button', { name: 'Next unviewed' }).click()
    await expect(panel.locator('.session-diff-filepane-path')).not.toHaveText('src/parser.ts')
    await expect(panel.locator('.session-diff-viewed-toggle input')).not.toBeChecked()

    await page.reload()
    const again = await openChanged(page)
    await expect(again.locator('.session-diff-viewed-count')).toHaveText('1 of 6 viewed', { timeout: 15_000 })

    // The file changes on disk: the tick no longer covers it, with no click (the quiet refresh).
    fs.writeFileSync(parserPath, original + '\nexport const VERSION = 2\n')
    const parserRow = again.locator('.session-diff-tree-file', { hasText: 'parser.ts' }).first()
    await expect(parserRow).toHaveAttribute('data-viewed', 'changed', { timeout: 10_000 })
    await expect(parserRow.getByRole('img', { name: 'changed since viewed' })).toBeVisible()
    await expect(again.locator('.session-diff-viewed-count')).toHaveText('0 of 6 viewed')
    await expect(again.locator('.session-diff-changed-count')).toHaveText('1 changed since viewed')
    await parserRow.click()
    await expect(again.locator('.session-diff-viewed-changed')).toHaveText('Changed since viewed')
    // Ticking again covers the new version.
    await again.locator('.session-diff-viewed-toggle input').check()
    await expect(parserRow).toHaveAttribute('data-viewed', 'viewed')
    await again.locator('.session-diff-viewed-toggle input').uncheck()
    await expect(parserRow).toHaveAttribute('data-viewed', 'unviewed')
    // The same from the keyboard: V ticks and unticks the open file, N opens the next unviewed one.
    await parserRow.click()
    await page.keyboard.press('v')
    await expect(parserRow).toHaveAttribute('data-viewed', 'viewed')
    await page.keyboard.press('n')
    await expect(again.locator('.session-diff-filepane-path')).not.toHaveText('src/parser.ts')
    await parserRow.click()
    await page.keyboard.press('v')
    await expect(parserRow).toHaveAttribute('data-viewed', 'unviewed')
  } finally {
    fs.writeFileSync(parserPath, original)
  }
})
