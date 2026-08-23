/**
 * Changed tab: the ✦ AI summary strip above each file's diff.
 *
 * The summary endpoint is stubbed at the network edge (page.route) — this spec
 * verifies the UI contract (strip renders the blurb, markdown code spans work,
 * per-file fetch on selection, toggle hides it and stops fetching, error path
 * offers Retry), not the model call. Server-side generation has its own unit
 * suite (tests/core/diff-summary.test.ts).
 */
import { test, expect, type Page, type Route } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'

// Same fixture session as the other session-panel specs; ui-prefs sync makes
// parallel workers fight over the open panel. Serial = correctness.
test.describe.configure({ mode: 'serial' })

const FILE_A = '/repo/src/alpha.ts'
const FILE_B = '/repo/src/beta.ts'

const lightList = {
  sessionId: SESSION_ID,
  groups: [{
    repoRoot: '/repo',
    label: 'repo',
    kind: 'cwd',
    files: [
      { filePath: FILE_A, relPath: 'src/alpha.ts', before: '', after: '', status: 'modified', ops: 2, partial: false },
      { filePath: FILE_B, relPath: 'src/beta.ts', before: '', after: '', status: 'modified', ops: 1, partial: false },
    ],
  }],
  fileCount: 2,
  anyPartial: false,
  light: true,
}

// FILE_A's diff is long on purpose: the sticky-strip test scrolls it.
const LONG_AFTER = 'const x = 2\n' + Array.from({ length: 300 }, (_, i) => `export const filler${i} = ${i};`).join('\n') + '\n'

const fullFile: Record<string, unknown> = {
  [FILE_A]: {
    sessionId: SESSION_ID, repoRoot: '/repo',
    file: { filePath: FILE_A, relPath: 'src/alpha.ts', before: 'const x = 1\n', after: LONG_AFTER, status: 'modified', ops: 2, partial: false },
  },
  [FILE_B]: {
    sessionId: SESSION_ID, repoRoot: '/repo',
    file: { filePath: FILE_B, relPath: 'src/beta.ts', before: 'let y = 0\n', after: 'let y = 9\n', status: 'modified', ops: 1, partial: false },
  },
}

interface StubOpts {
  /** Per-path summary responder; return null → 502. */
  summary: (filePath: string, callCount: number) => { summary: string } | null
}

/** Route ALL /changes* endpoints for the fixture session at the network edge. */
async function stubChangesApi(page: Page, opts: StubOpts): Promise<{ summaryCalls: string[] }> {
  const summaryCalls: string[] = []
  const perPathCounts = new Map<string, number>()
  await page.route(`**/api/sessions/${SESSION_ID}/changes**`, async (route: Route) => {
    const url = new URL(route.request().url())
    const path = url.searchParams.get('path') ?? ''
    if (url.pathname.endsWith('/changes/summary')) {
      summaryCalls.push(path)
      const n = (perPathCounts.get(path) ?? 0) + 1
      perPathCounts.set(path, n)
      const res = opts.summary(path, n)
      if (!res) {
        await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Summary generation failed' }) })
        return
      }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ filePath: path, relPath: path.replace('/repo/', ''), summary: res.summary, model: 'stub-model', cached: false, hash: 'h1' }),
      })
      return
    }
    if (url.pathname.endsWith('/changes/file')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fullFile[path]) })
      return
    }
    if (url.pathname.endsWith('/changes/triage')) {
      // FILE_A is the changeset's critical file → ✦ star in the tree.
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          critical: [{ filePath: FILE_A, relPath: 'src/alpha.ts', reason: 'core change' }],
          cached: false, hash: 'th1',
        }),
      })
      return
    }
    // Git bases (?base=uncommitted/remote) get FULL contents, light session
    // lists otherwise — mirrors the real endpoint's contract.
    if (url.searchParams.get('base')) {
      const gitList = {
        ...lightList,
        light: false,
        groups: [{
          ...lightList.groups[0],
          files: lightList.groups[0].files.map((f) => ({
            ...f,
            before: (fullFile[f.filePath] as { file: { before: string } }).file.before,
            after: (fullFile[f.filePath] as { file: { after: string } }).file.after,
          })),
        }],
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(gitList) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lightList) })
  })
  return { summaryCalls }
}

async function openChangedTab(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Changed' }).click()
  return panel
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-diff-ai-summary', '1') } catch { /* on */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('summary strip renders the blurb for the selected file, per-file on selection', async ({ page }) => {
  const { summaryCalls } = await stubChangesApi(page, {
    summary: (path) => ({
      summary: path === FILE_A
        ? 'Bumps the initial `x` value. In this changeset: the core edit.'
        : 'Raises `y` to nine. In this changeset: a companion tweak.',
    }),
  })
  const panel = await openChangedTab(page)

  // First file auto-selects → its strip appears with rendered markdown.
  const strip = panel.locator('.session-diff-ai-summary')
  await expect(strip).toBeVisible({ timeout: 10_000 })
  await expect(strip).toContainText('Bumps the initial')
  await expect(strip.locator('code').first()).toHaveText('x')

  // Selecting the second file fetches ITS summary.
  await panel.locator('.session-diff-tree-file', { hasText: 'beta.ts' }).click()
  await expect(strip).toContainText('Raises', { timeout: 10_000 })
  expect(summaryCalls).toContain(FILE_B)
})

test('✦ AI toggle hides the strip and stops fetching; sticky via localStorage', async ({ page }) => {
  const { summaryCalls } = await stubChangesApi(page, {
    summary: () => ({ summary: 'Anything.' }),
  })
  const panel = await openChangedTab(page)
  await expect(panel.locator('.session-diff-ai-summary')).toBeVisible({ timeout: 10_000 })

  // Pin the real contract: selecting a file with the toggle OFF must not fetch
  // THAT file's summary. (Not a global count freeze — a late ui-prefs merge or
  // StrictMode remount can land a stray call for the already-open file under
  // machine load; that race is not the behavior under test.)
  const betaBefore = summaryCalls.filter((p) => p === FILE_B).length
  await panel.locator('.session-diff-ai-toggle').click()
  await expect(panel.locator('.session-diff-ai-summary')).toHaveCount(0)

  await panel.locator('.session-diff-tree-file', { hasText: 'beta.ts' }).click()
  await expect(panel.locator('.session-diff-filepane-path')).toContainText('beta.ts')
  expect(summaryCalls.filter((p) => p === FILE_B).length).toBe(betaBefore)

  // Preference persisted.
  const stored = await page.evaluate(() => localStorage.getItem('open-walnut-diff-ai-summary'))
  expect(stored).toBe('0')

  // Toggle back on → strip returns.
  await panel.locator('.session-diff-ai-toggle').click()
  await expect(panel.locator('.session-diff-ai-summary')).toBeVisible({ timeout: 10_000 })
})

test('failed generation shows a quiet error with a working Retry', async ({ page }) => {
  await stubChangesApi(page, {
    // First call per path fails, second succeeds — exercises Retry.
    summary: (_path, n) => (n === 1 ? null : { summary: 'Recovered summary.' }),
  })
  const panel = await openChangedTab(page)

  const strip = panel.locator('.session-diff-ai-summary')
  await expect(strip).toContainText('AI summary unavailable', { timeout: 10_000 })
  await strip.locator('.session-diff-ai-retry').click()
  await expect(strip).toContainText('Recovered summary.', { timeout: 10_000 })
})

test('strip stays pinned to the top of the scroller while the diff scrolls', async ({ page }) => {
  await stubChangesApi(page, { summary: () => ({ summary: 'Pinned summary.' }) })
  const panel = await openChangedTab(page)
  const strip = panel.locator('.session-diff-ai-summary')
  await expect(strip).toContainText('Pinned summary.', { timeout: 10_000 })

  const scroller = panel.locator('.session-diff-main')
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
  // Sticky = the strip's box hugs the scroller's top edge even when scrolled
  // (the header sits directly above it inside the same sticky wrapper).
  await expect(strip).toBeVisible()
  const [stripBox, scrollerBox, headBox] = await Promise.all([
    strip.boundingBox(), scroller.boundingBox(),
    panel.locator('.session-diff-filepane-head').boundingBox(),
  ])
  expect(stripBox && scrollerBox && headBox).toBeTruthy()
  expect(Math.abs(headBox!.y - scrollerBox!.y)).toBeLessThan(2)
  expect(Math.abs(stripBox!.y - (headBox!.y + headBox!.height))).toBeLessThan(2)
})

test('strip and ✦ star persist under git bases (Uncommitted)', async ({ page }) => {
  await stubChangesApi(page, { summary: () => ({ summary: 'Session-authored change.' }) })
  const panel = await openChangedTab(page)
  await expect(panel.locator('.session-diff-ai-summary')).toBeVisible({ timeout: 10_000 })

  await panel.locator('.session-diff-base-select select').selectOption('uncommitted')
  // The summary still describes the session's own change to this file.
  await expect(panel.locator('.session-diff-ai-summary')).toContainText('Session-authored change.', { timeout: 10_000 })
  await expect(panel.locator('.session-diff-tree-critical')).toHaveCount(1, { timeout: 10_000 })

  // Base choice is remembered per session (ui-prefs) — reset for other specs.
  await panel.locator('.session-diff-base-select select').selectOption('session')
  await expect(panel.locator('.session-diff-ai-summary')).toBeVisible({ timeout: 10_000 })
})

test('triage stars the critical file in the tree with a reason tooltip', async ({ page }) => {
  await stubChangesApi(page, { summary: () => ({ summary: 'Whatever.' }) })
  const panel = await openChangedTab(page)

  const star = panel.locator('.session-diff-tree-critical')
  await expect(star).toHaveCount(1, { timeout: 10_000 })
  await expect(star).toHaveAttribute('title', 'AI: core change')
  // The star sits on FILE_A's row, not FILE_B's.
  await expect(
    panel.locator('.session-diff-tree-file', { hasText: 'alpha.ts' }).locator('.session-diff-tree-critical'),
  ).toHaveCount(1)
})
