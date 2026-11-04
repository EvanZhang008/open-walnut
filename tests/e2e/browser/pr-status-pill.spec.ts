/**
 * A task's linked pull request, live (src/core/pull-requests/, web PrPill.tsx): the pill on the
 * row and in the session header follows the pull request's checks, the card lists what failed
 * and saves its two switches, a failed check wakes the task's session with the check's name, and
 * a merge completes the task. GitHub is the test server's stand-in gh (tests/providers/fake-gh.mjs),
 * answering from files this spec writes into the fixture home: nothing reads the real GitHub.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${PORT}`
const SHOT_DIR = process.env.PR_PILL_SHOTS ?? ''

test.describe.configure({ mode: 'serial' })

const litter: string[] = []
const litterFiles: string[] = []

async function api<T>(p: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${p}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${p} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function ghDir(): Promise<string> {
  const { walnutHome } = await discoverBrowserFixture(PORT)
  if (PORT === 3456 || !/^walnut-pw-\d+$/.test(path.basename(walnutHome))) throw new Error(`not an isolated fixture: ${walnutHome}`)
  const dir = path.join(walnutHome, 'fake-gh')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

type Check = { name: string; state: 'pass' | 'fail' | 'run' }

/** A pull request as GitHub's GraphQL returns it (the fields providers.ts asks for). */
function prNode(repo: string, n: number, opts: { state?: 'OPEN' | 'MERGED' | 'CLOSED'; sha?: string; checks: Check[]; mergeable?: string; review?: string | null; author?: string; comments?: Array<{ id: string; author: string; body: string; at: string }>; reviews?: Array<{ id: string; author: string; state: string; body: string; at: string }> }) {
  return {
    number: n, url: `https://github.com/acme/${repo}/pull/${n}`, title: 'Add the CSV export button', state: opts.state ?? 'OPEN', isDraft: false,
    mergedAt: opts.state === 'MERGED' ? new Date().toISOString() : null, closedAt: opts.state === 'MERGED' ? new Date().toISOString() : null,
    headRefName: 'csv-export', headRefOid: opts.sha ?? '9f3c2a17d4e5', baseRefName: 'main', mergeable: opts.mergeable ?? 'MERGEABLE',
    reviewDecision: opts.review === undefined ? 'REVIEW_REQUIRED' : opts.review, author: { login: opts.author ?? 'walnut-dev' },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: opts.checks.length, nodes: opts.checks.map((c) => ({
      __typename: 'CheckRun', name: c.name,
      status: c.state === 'run' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: c.state === 'run' ? null : c.state === 'pass' ? 'SUCCESS' : 'FAILURE',
      detailsUrl: `https://ci.example.com/acme/${repo}/${encodeURIComponent(c.name)}`, isRequired: c.name === 'Lint & build',
    })) } } } }] },
    comments: { nodes: (opts.comments ?? []).map((c) => ({ id: c.id, author: { login: c.author }, authorAssociation: 'MEMBER', body: c.body, createdAt: c.at, url: `https://github.com/acme/${repo}/pull/${n}#${c.id}` })) },
    reviews: { nodes: (opts.reviews ?? []).map((r) => ({ id: r.id, author: { login: r.author }, authorAssociation: 'MEMBER', state: r.state, body: r.body, submittedAt: r.at, url: `https://github.com/acme/${repo}/pull/${n}#${r.id}`, comments: { totalCount: 0 } })) },
  }
}

async function writePr(repo: string, n: number, node: unknown): Promise<void> {
  const file = path.join(await ghDir(), `acme__${repo}__${n}.json`)
  await fs.writeFile(`${file}.tmp`, JSON.stringify(node))
  await fs.rename(`${file}.tmp`, file)
}

const GREEN: Check[] = [
  { name: 'Lint & build', state: 'pass' }, { name: 'Unit tests', state: 'pass' }, { name: 'Browser tests (webkit)', state: 'pass' },
]
const RUNNING: Check[] = [{ name: 'Lint & build', state: 'pass' }, { name: 'Unit tests', state: 'run' }, { name: 'Browser tests (webkit)', state: 'run' }]
const RED: Check[] = [{ name: 'Lint & build', state: 'pass' }, { name: 'Unit tests', state: 'fail' }, { name: 'Browser tests (webkit)', state: 'run' }]

function row(page: Page, taskId: string) {
  return page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const file of litterFiles.splice(0)) await fs.rm(file, { force: true })
})

test('the row pill follows the checks; the card lists the failure, saves its switches and refreshes', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  const repo = `export-${browserName}-${Date.now().toString(36)}`
  await writePr(repo, 41, prNode(repo, 41, { checks: RUNNING }))
  const project = `PR pill ${repo}`
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Ship the CSV export', source: 'local', pinned: false, project, tags: [`pr:https://github.com/acme/${repo}/pull/41`],
  })
  litter.push(task.id)

  await presetPanelView(page, { section: 'all', project: '' })
  // Tall enough for the whole card beside its row (it never covers the row; shorter, it scrolls).
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const pill = row(page, task.id).locator('[data-testid="pr-pill"]')
  // A newly linked pull request is read within seconds, without anyone pressing anything.
  await expect(pill).toHaveText('#41 · Checks running', { timeout: 20_000 })
  await expect(pill).toHaveAttribute('data-tone', 'pending')

  // CI fails: the next read (the card's Refresh here) turns the pill red.
  await writePr(repo, 41, prNode(repo, 41, { checks: RED }))
  await pill.click()
  const card = page.locator('[data-testid="pr-card"]')
  await expect(card).toBeVisible()
  await expect(card.locator('.pr-card-title')).toContainText('#41 Add the CSV export button')
  // The card opens whole: what it loads after it opened (the switches) grows it, never hides
  // under a cap measured before.
  await expect(card.locator('[data-testid="pr-switch-complete"]')).toBeVisible()
  await expect.poll(() => card.evaluate((el) => `${el.scrollHeight - el.clientHeight}`), { timeout: 3_000 }).toBe('0')
  // A window too short for it: the card scrolls under its foot, and Refresh stays in view.
  await page.setViewportSize({ width: 1280, height: 340 })
  await expect.poll(() => card.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const inView = await card.evaluate((el) => {
    const c = el.getBoundingClientRect()
    const r = el.querySelector('[data-testid="pr-card-refresh"]')!.getBoundingClientRect()
    return r.top >= c.top && r.bottom <= c.bottom + 0.5 && c.bottom <= window.innerHeight + 0.5
  })
  expect(inView).toBe(true)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await card.locator('[data-testid="pr-card-refresh"]').click()
  await expect(pill).toHaveText('#41 · 1 check failed', { timeout: 15_000 })
  await expect(pill).toHaveAttribute('data-tone', 'failed')
  await expect(card.locator('[data-testid="pr-card-checks"]')).toContainText('1 failed, 1 running, 1 passed')
  // What the read added (the failure, what the agent was told) grows the card; nothing hides
  // under its foot.
  await expect.poll(() => card.evaluate((el) => `${el.scrollHeight - el.clientHeight}`), { timeout: 3_000 }).toBe('0')
  const failed = card.locator('.pr-card-check[data-status="failed"] a')
  await expect(failed).toHaveText('Unit tests')
  await expect(failed).toHaveAttribute('href', `https://ci.example.com/acme/${repo}/Unit%20tests`)
  await expect(card.locator('[data-testid="pr-card-read"]')).toHaveText(/Checked just now/)
  await shot(page, `card-failed-${browserName}`)

  // The two switches are this task's own and survive a reload.
  const complete = card.locator('[data-testid="pr-switch-complete"]')
  const wake = card.locator('[data-testid="pr-switch-wake"]')
  await expect(complete).toHaveAttribute('aria-checked', 'true')
  await expect(wake).toHaveAttribute('aria-checked', 'true')
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/tasks/${task.id}`))
  await complete.click()
  expect((await saved).status()).toBe(200)
  await expect(complete).toHaveAttribute('aria-checked', 'false')
  // Two quick presses: both count, and the server keeps the last.
  await wake.focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Space')
  await expect(wake).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => (await api<{ task: { pr_wake?: boolean } }>(`/api/tasks/${task.id}`, 'GET')).task.pr_wake, { timeout: 10_000 }).toBe(true)
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await page.reload()
  await page.waitForLoadState('networkidle')
  await row(page, task.id).locator('[data-testid="pr-pill"]').click()
  await expect(page.locator('[data-testid="pr-switch-complete"]')).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator('[data-testid="pr-switch-wake"]')).toHaveAttribute('aria-checked', 'true')

  // With completing off, a merge leaves the task open and the card says why.
  await writePr(repo, 41, prNode(repo, 41, { state: 'MERGED', checks: GREEN }))
  await page.locator('[data-testid="pr-card-refresh"]').click()
  await expect(row(page, task.id).locator('[data-testid="pr-pill"]')).toHaveText('#41 · Merged', { timeout: 15_000 })
  await expect(page.locator('[data-testid="pr-card-note"]')).toContainText('This task stays open: Completing on merge is off for this task.')
  const after = await api<{ task: { phase: string } }>(`/api/tasks/${task.id}`, 'GET')
  expect(after.task.phase).not.toBe('COMPLETE')
})

test('the session\'s gh pr create links it; a failed check wakes the session with its name, and a merge completes the task', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  const repo = `wake-${browserName}-${Date.now().toString(36)}`
  await writePr(repo, 7, prNode(repo, 7, { checks: RUNNING }))
  const { fixtureRoot } = await discoverBrowserFixture(PORT)
  // The session opens the pull request itself: the URL gh printed becomes the task's link.
  const prUrl = `https://github.com/acme/${repo}/pull/7`
  const steps = { steps: [
    { command: 'git push -u origin csv-export', output: 'branch csv-export set up to track origin/csv-export' },
    // Encoded: the URL must come from gh's output, not from the message (a message's own links
    // are tagged by another path).
    { command: 'gh pr create --fill', outputB64: Buffer.from(`Creating pull request for csv-export into main in acme/${repo}\n\n${prUrl}\n`).toString('base64') },
  ], text: 'Opened the pull request.' }
  const start = await api<{ sessionId: string; taskId: string }>('/api/sessions/quick-start', 'POST', { cwd: path.join(fixtureRoot, 'projects', 'walnut'), message: `bash-steps:${JSON.stringify(steps)}` })
  const { sessionId, taskId } = start
  litter.push(taskId)
  await expect.poll(async () => ((await api<{ task: { tags?: string[] } }>(`/api/tasks/${taskId}`, 'GET')).task.tags ?? []).some((t) => t.includes(prUrl)), { timeout: 60_000 }).toBe(true)
  await expect.poll(async () => (await api<{ session: { process_status?: string } }>(`/api/sessions/${sessionId}`, 'GET')).session.process_status, { timeout: 60_000 }).toMatch(/idle|stopped/)
  await expect.poll(async () => (await api<{ prs: Array<{ checks: { pending: number } }> }>(`/api/tasks/${taskId}/pull-requests`, 'GET')).prs[0]?.checks.pending, { timeout: 20_000 }).toBe(2)

  await writePr(repo, 7, prNode(repo, 7, { checks: RED }))
  await api(`/api/tasks/${taskId}/pull-requests/refresh`, 'POST', {})
  const history = async () => JSON.stringify(await api(`/api/sessions/${sessionId}/history`, 'GET'))
  await expect.poll(history, { timeout: 60_000 }).toContain('Walnut: pull request watch')
  const text = await history()
  expect(text).toContain('A check failed (commit 9f3c2a1)')
  expect(text).toContain(`Unit tests: https://ci.example.com/acme/${repo}/Unit%20tests`)

  // The session header shows the same pill.
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(sessionId)
  await expect(row(page, taskId)).toBeVisible({ timeout: 20_000 })
  await row(page, taskId).locator('.todo-item-title').click()
  const headerPill = page.locator(`.session-panel[data-session-id="${sessionId}"] [data-testid="pr-pill"]`).first()
  await expect(headerPill).toHaveText(/#7 · 1 check failed/, { timeout: 30_000 })
  await shot(page, `header-failed-${browserName}`)

  // It merges: once the woken turn has ended, the task completes by itself.
  await writePr(repo, 7, prNode(repo, 7, { state: 'MERGED', checks: GREEN }))
  await expect.poll(async () => {
    await api(`/api/tasks/${taskId}/pull-requests/refresh`, 'POST', {})
    return (await api<{ task: { phase: string } }>(`/api/tasks/${taskId}`, 'GET')).task.phase
  }, { timeout: 90_000, intervals: [2_000] }).toBe('COMPLETE')
  await expect(headerPill).toHaveText(/#7 · Merged/, { timeout: 15_000 })
})

test('the card stays open while the read it asked for wakes the session', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  const repo = `redraw-${browserName}-${Date.now().toString(36)}`
  await writePr(repo, 8, prNode(repo, 8, { checks: RUNNING }))
  const { fixtureRoot } = await discoverBrowserFixture(PORT)
  const cwd = path.join(fixtureRoot, 'projects', 'walnut')
  const project = `PR pill ${repo}`
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', { title: 'Redraw while reading', source: 'local', pinned: false, project, cwd })
  litter.push(task.id)
  const started = await api<{ sessionId?: string }>(`/api/v1/tasks/${task.id}/start`, 'POST', { message: 'echo-input ready', cwd })
  let sessionId = started.sessionId
  await expect.poll(async () => (sessionId ??= (await api<{ task: { session_id?: string } }>(`/api/tasks/${task.id}`, 'GET')).task.session_id), { timeout: 30_000 }).toBeTruthy()
  await expect.poll(async () => (await api<{ session: { process_status?: string } }>(`/api/sessions/${sessionId}`, 'GET')).session.process_status, { timeout: 60_000 }).toMatch(/idle|stopped/)
  await api(`/api/tasks/${task.id}`, 'PATCH', { add_tags: [`pr:https://github.com/acme/${repo}/pull/8`] })
  await expect.poll(async () => (await api<{ prs: Array<{ checkedAt?: string }> }>(`/api/tasks/${task.id}/pull-requests`, 'GET')).prs[0]?.checkedAt, { timeout: 20_000 }).toBeTruthy()

  await presetPanelView(page, { section: 'all', project })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const pill = row(page, task.id).locator('[data-testid="pr-pill"]')
  await expect(pill).toHaveText('#8 · Checks running', { timeout: 20_000 })
  await pill.click()
  const card = page.locator('[data-testid="pr-card"]')
  await expect(card).toBeVisible()
  await writePr(repo, 8, prNode(repo, 8, { checks: RED }))
  await card.locator('[data-testid="pr-card-refresh"]').click()
  // The failure wakes the session, and the card stays (a row drawn anew: tests/web/pr-pill-remount.test.ts).
  await expect.poll(async () => JSON.stringify(await api(`/api/sessions/${sessionId}/history`, 'GET')), { timeout: 60_000 }).toContain('Walnut: pull request watch')
  await expect.poll(async () => (await api<{ session: { process_status?: string } }>(`/api/sessions/${sessionId}`, 'GET')).session.process_status, { timeout: 60_000 }).toMatch(/idle|stopped/)
  await page.waitForTimeout(1_000)
  await expect(card).toBeVisible()
  await expect(card.locator('[data-testid="pr-card-woke"]')).toContainText('Told the agent')
  await expect.poll(() => card.evaluate((el) => `${el.scrollHeight - el.clientHeight}`), { timeout: 3_000 }).toBe('0')
})

test('signed out: the card says how to sign in, and reading again clears it', async ({ page, browserName }) => {
  const repo = `auth-${browserName}-${Date.now().toString(36)}`
  await writePr(repo, 3, prNode(repo, 3, { checks: GREEN, review: 'APPROVED' }))
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Docs fix', source: 'local', pinned: false, project: `PR pill ${repo}`, tags: [`pr:https://github.com/acme/${repo}/pull/3`],
  })
  litter.push(task.id)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const pill = row(page, task.id).locator('[data-testid="pr-pill"]')
  await expect(pill).toHaveText('#3 · Approved', { timeout: 20_000 })
  await expect(pill).toHaveAttribute('data-tone', 'passed')

  // Only this repository's reads: the other engine's spec may share the server.
  const marker = path.join(await ghDir(), `signed-out.acme__${repo}`)
  litterFiles.push(marker)
  await fs.writeFile(marker, '')
  // A list still settling after the load can redraw under the first click: click until it opens.
  await expect(async () => {
    if (!(await page.locator('[data-testid="pr-card"]').isVisible())) await pill.click()
    await expect(page.locator('[data-testid="pr-card"]')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await page.locator('[data-testid="pr-card-refresh"]').click()
  await expect(page.locator('[data-testid="pr-card-error"]')).toContainText('not signed in', { timeout: 15_000 })
  await expect(page.locator('[data-testid="pr-card-error"]')).toContainText('gh auth login')
  // The last good status stays on the pill, greyed and said to be not current.
  await expect(pill).toHaveText('#3 · Approved · not current')
  await expect(pill).toHaveAttribute('data-stale', 'true')
  await shot(page, `card-signed-out-${browserName}`)

  await fs.rm(marker, { force: true })
  await page.locator('[data-testid="pr-card-refresh"]').click()
  await expect(page.locator('[data-testid="pr-card-error"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(pill).toHaveText('#3 · Approved')
  await expect(pill).not.toHaveAttribute('data-stale', 'true')
  await page.keyboard.press('Escape')

  // A pull request first linked while signed out shows only that: no made-up checks or review.
  const repo2 = `${repo}-new`
  const marker2 = path.join(await ghDir(), `signed-out.acme__${repo2}`)
  litterFiles.push(marker2)
  await fs.writeFile(marker2, '')
  await writePr(repo2, 4, prNode(repo2, 4, { checks: GREEN }))
  const { task: fresh } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Docs fix two', source: 'local', pinned: false, project: `PR pill ${repo}`, tags: [`pr:https://github.com/acme/${repo2}/pull/4`],
  })
  litter.push(fresh.id)
  const pill2 = row(page, fresh.id).locator('[data-testid="pr-pill"]')
  await expect(pill2).toHaveText('#4 · No status', { timeout: 20_000 })
  await pill2.click()
  const card = page.locator('[data-testid="pr-card"]')
  await expect(card.locator('[data-testid="pr-card-error"]')).toContainText('gh auth login')
  await expect(card).not.toContainText('No review needed yet')
  await expect(card.locator('[data-testid="pr-card-checks"]')).toHaveCount(0)
  await expect(card.locator('[data-testid="pr-switch-wake"]')).toHaveCount(0)
  await expect(card.locator('[data-testid="pr-card-read"]')).toHaveText(/^Tried /)
  await shot(page, `card-never-read-${browserName}`)
  await page.keyboard.press('Escape')

  // Two pull requests that gh cannot read for the same reason: the card says it once.
  const both = [`${repo}-a`, `${repo}-b`]
  for (const r of both) {
    const m = path.join(await ghDir(), `signed-out.acme__${r}`)
    litterFiles.push(m)
    await fs.writeFile(m, '')
    await writePr(r, 5, prNode(r, 5, { checks: GREEN }))
  }
  const { task: pair } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Docs fix pair', source: 'local', pinned: false, project: `PR pill ${repo}`, tags: both.map((r) => `pr:https://github.com/acme/${r}/pull/5`),
  })
  litter.push(pair.id)
  const pill3 = row(page, pair.id).locator('[data-testid="pr-pill"]')
  await expect(pill3).toHaveText(/^#5 · No status/, { timeout: 20_000 })
  await pill3.click()
  await expect(card.locator('[data-testid="pr-card-pr"]')).toHaveCount(2)
  await expect(card.locator('[data-testid="pr-card-error"]')).toHaveCount(1)
})

test('another person\'s pull request says whose it is and offers no switches; the keyboard reaches the card', async ({ page, browserName }) => {
  const repo = `other-${browserName}-${Date.now().toString(36)}`
  await writePr(repo, 9, prNode(repo, 9, { checks: RED, author: 'kim' }))
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Review the export change', source: 'local', pinned: false, project: `PR pill ${repo}`, tags: [`pr:https://github.com/acme/${repo}/pull/9`],
  })
  litter.push(task.id)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const pill = row(page, task.id).locator('[data-testid="pr-pill"]')
  await expect(pill).toHaveText('#9 · 1 check failed · by kim', { timeout: 20_000 })
  // Folded in a tight column it keeps the state as a word.
  await expect(pill).toHaveAttribute('data-short', '#9 kim 1 check failed')
  await expect(pill).toHaveAttribute('data-theirs', 'true')

  // Enter opens the card and puts the focus in it, not on the row behind.
  await pill.focus()
  await page.keyboard.press('Enter')
  const card = page.locator('[data-testid="pr-card"]')
  await expect(card).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="pr-card"]'))).toBe(true)
  await expect(card.locator('[data-testid="pr-card-not-mine"]')).toContainText('Opened by kim')
  await expect(card.locator('[data-testid="pr-switch-wake"], [data-testid="pr-switch-complete"]')).toHaveCount(0)
  await shot(page, `card-not-mine-${browserName}`)
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid)).toBe('pr-pill')

  // Narrower desktop windows (the phone layout starts at 768) fold the column: the state's word
  // always shows whole inside the pill, and each other part (whose, the number) is either whole
  // on the line or gone, never a fragment.
  for (const width of [1280, 900, 820]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('.home-navigation-scroll[data-row-fit="tight"]')).toHaveCount(1)
    await expect(pill.locator('.pr-pill-word')).toBeVisible()
    const fit = await pill.evaluate((el) => {
      const p = el.getBoundingClientRect()
      const line = el.querySelector('.pr-pill-short')!.getBoundingClientRect()
      const part = (c: string) => el.querySelector(`.${c}`)!.getBoundingClientRect()
      const shown = (r: DOMRect) => r.width > 0 && r.top < line.bottom - 1
      const whole = (r: DOMRect) => !shown(r) || (r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && r.left >= line.left - 0.5)
      const word = part('pr-pill-word')
      return {
        word: shown(word) && whole(word),
        parts: ['pr-pill-who', 'pr-pill-n'].every((c) => whole(part(c))),
        long: getComputedStyle(el.querySelector('.task-pill-long')!).display,
        whoShown: shown(part('pr-pill-who')),
        numberShown: shown(part('pr-pill-n')),
        narrow: el.closest('.home-navigation-scroll')!.getAttribute('data-row-narrow') === 'true',
      }
    })
    // A narrow column drops every number at once.
    if (fit.narrow) expect(fit.numberShown, `${width}px`).toBe(false)
    expect(fit, `${width}px`).toMatchObject({ word: true, parts: true, long: 'none' })
    // Whose goes after the number, never before it.
    if (!fit.whoShown) expect(fit.numberShown, `${width}px`).toBe(false)
    if (SHOT_DIR) await row(page, task.id).screenshot({ path: path.join(SHOT_DIR, `row-folded-not-mine-${width}-${browserName}.png`) })
  }
})

test('in the list by project, every row with a pull request has its title on one line and its pills on the next', async ({ page, browserName }) => {
  const repo = `lines-${browserName}-${Date.now().toString(36)}`
  const project = `PR pill ${repo}`
  await writePr(repo, 61, prNode(repo, 61, { checks: RUNNING }))
  await writePr(repo, 62, prNode(repo, 62, { checks: RED }))
  const make = async (title: string, tags: string[]) => {
    const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', { title, source: 'local', pinned: false, project, tags })
    litter.push(task.id)
    return task.id
  }
  const short = await make('Fix', [`pr:https://github.com/acme/${repo}/pull/61`])
  const long = await make('Move the invoice totals to the new tax rate table', [`pr:https://github.com/acme/${repo}/pull/62`])
  const later = await make('Tidy', [])
  await page.addInitScript(() => localStorage.setItem('walnut-todo-panel-design', 'project'))
  await presetPanelView(page, { section: 'all', project })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(row(page, short).locator('[data-testid="pr-pill"]')).toHaveAttribute('data-tone', 'pending', { timeout: 20_000 })
  // A link that arrives after the row drew (the row restyles without :has, which WebKit misses).
  await api(`/api/tasks/${later}`, 'PATCH', { add_tags: [`pr:https://github.com/acme/${repo}/pull/61`] })
  await expect(row(page, later).locator('[data-testid="pr-pill"]')).toHaveAttribute('data-tone', 'pending', { timeout: 20_000 })
  for (const id of [short, long, later]) {
    const below = await row(page, id).evaluate((el) => {
      const title = el.querySelector('.todo-item-title')!.getBoundingClientRect()
      const pill = el.querySelector('[data-testid="pr-pill"]')!.getBoundingClientRect()
      return pill.top >= title.bottom - 0.5
    })
    expect(below, id).toBe(true)
  }
  await shot(page, 'list-by-project-lines')
})

test('in the flat list a short meta line keeps the pill whole, and the card never covers its own row', async ({ page, browserName }) => {
  const repo = `flat-${browserName}-${Date.now().toString(36)}`
  const project = `PR pill ${repo}`
  await writePr(repo, 81, prNode(repo, 81, { checks: RED }))
  await writePr(repo, 82, prNode(repo, 82, { checks: GREEN }))
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Fix the flaky export test', source: 'local', pinned: false, project, tags: [81, 82].map((n) => `pr:https://github.com/acme/${repo}/pull/${n}`),
  })
  litter.push(task.id)
  await api(`/api/tasks/${task.id}`, 'PATCH', { phase: 'NEED_ACTION' })
  await page.addInitScript(() => localStorage.setItem('walnut-todo-panel-design', 'status'))
  await presetPanelView(page, { section: 'all', project })
  await page.setViewportSize({ width: 820, height: 600 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const card = page.locator(`[data-task-id="${task.id}"]`).first()
  const pill = card.locator('[data-testid="pr-pill"]')
  await expect(pill).toHaveAttribute('data-tone', 'failed', { timeout: 20_000 })
  const line = await card.locator('.status-card-meta').evaluate((m) => {
    const p = m.querySelector('[data-testid="pr-pill"]')!
    const project = m.querySelector('.status-card-project')
    const box = m.getBoundingClientRect(), r = p.getBoundingClientRect()
    return {
      projectShown: !!project && getComputedStyle(project).display !== 'none' && project.getBoundingClientRect().width > 0,
      projectWidth: project ? Math.round(project.getBoundingClientRect().width) : 0,
      pillInside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
      lineWidth: Math.round(box.width),
    }
  })
  // Either the name keeps a few letters or it leaves the line: never a sliver beside a lone dot.
  expect(line.pillInside, JSON.stringify(line)).toBe(true)
  if (line.projectShown) expect(line.projectWidth, JSON.stringify(line)).toBeGreaterThanOrEqual(30)
  await pill.click()
  const popup = page.locator('[data-testid="pr-card"]')
  await expect(popup).toBeVisible()
  const overlap = await page.evaluate((id) => {
    const row = document.querySelector(`[data-task-id="${id}"]`)!.getBoundingClientRect()
    const c = document.querySelector('[data-testid="pr-card"]')!.getBoundingClientRect()
    return Math.max(0, Math.min(row.bottom, c.bottom) - Math.max(row.top, c.top))
  }, task.id)
  expect(overlap, 'the card covers its own row').toBeLessThanOrEqual(1)
  await shot(page, 'flat-820-card')
})

test('the card quotes what a reviewer asked, links the comments, and closes a task whose pull request merged before it was linked', async ({ page, browserName }) => {
  const repo = `quote-${browserName}-${Date.now().toString(36)}`
  const project = `PR pill ${repo}`
  const asked = 'Please rename the helper before this lands.'
  await writePr(repo, 71, prNode(repo, 71, { checks: GREEN, review: 'CHANGES_REQUESTED', reviews: [{ id: 'PRR_71', author: 'kim', state: 'CHANGES_REQUESTED', body: asked, at: new Date().toISOString() }], comments: [{ id: 'IC_71', author: 'lee', body: 'Agreed, the old name reads oddly.', at: new Date().toISOString() }] }))
  await writePr(repo, 72, prNode(repo, 72, { checks: GREEN, state: 'MERGED' }))
  const make = async (title: string, n: number) => {
    const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', { title, source: 'local', pinned: false, project, tags: [`pr:https://github.com/acme/${repo}/pull/${n}`] })
    litter.push(task.id)
    return task.id
  }
  const reviewed = await make('Rename the helper', 71)
  const merged = await make('Ship what already merged', 72)
  await writePr(repo, 73, prNode(repo, 73, { checks: GREEN }))
  await writePr(repo, 74, prNode(repo, 74, { checks: RUNNING }))
  const { task: halves } = await api<{ task: { id: string } }>('/api/tasks', 'POST', {
    title: 'Land both halves', source: 'local', pinned: false, project, tags: [73, 74].map((n) => `pr:https://github.com/acme/${repo}/pull/${n}`),
  })
  litter.push(halves.id)
  await presetPanelView(page, { section: 'all', project })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const pill = row(page, reviewed).locator('[data-testid="pr-pill"]')
  await expect(pill).toHaveAttribute('data-tone', 'changes', { timeout: 20_000 })
  await pill.click()
  const card = page.locator('[data-testid="pr-card"]')
  await expect(card.locator('[data-testid="pr-card-review-quote"]')).toHaveText(asked)
  // The quoted review is not counted again: the one other remark is.
  await expect(card.locator('.pr-card-comments')).toHaveText('1 comment')
  await expect(card.locator('.pr-card-comments')).toHaveAttribute('href', `https://github.com/acme/${repo}/pull/71`)
  await shot(page, 'card-review-quote')
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)

  const mergedPill = row(page, merged).locator('[data-testid="pr-pill"]')
  await expect(mergedPill).toHaveAttribute('data-tone', 'merged', { timeout: 20_000 })
  await mergedPill.click()
  await expect(card.locator('[data-testid="pr-card-note"]')).toContainText('already merged when it was linked')
  await shot(page, 'card-merged-before-link')
  // Walnut never completes it by itself; the user can, from here.
  expect((await api<{ task: { phase: string } }>(`/api/tasks/${merged}`, 'GET')).task.phase).not.toBe('COMPLETE')
  await card.locator('[data-testid="pr-card-complete-now"]').click()
  await expect.poll(async () => (await api<{ task: { phase: string } }>(`/api/tasks/${merged}`, 'GET')).task.phase, { timeout: 15_000 }).toBe('COMPLETE')
  if (await card.count()) await page.keyboard.press('Escape')

  // One half merges: the card says the task waits for the other.
  await expect.poll(async () => (await api<{ prs: Array<{ checkedAt?: string }> }>(`/api/tasks/${halves.id}/pull-requests`, 'GET')).prs.every((p) => p.checkedAt), { timeout: 20_000 }).toBe(true)
  await writePr(repo, 73, prNode(repo, 73, { checks: GREEN, state: 'MERGED' }))
  const halvesPill = row(page, halves.id).locator('[data-testid="pr-pill"]')
  await halvesPill.click()
  await card.locator('[data-testid="pr-card-refresh"]').click()
  await expect(card.locator('[data-pr-url$="/pull/73"] [data-testid="pr-card-note"]')).toHaveText('Merged. The task completes once #74 is merged or closed too.', { timeout: 15_000 })
  expect((await api<{ task: { phase: string } }>(`/api/tasks/${halves.id}`, 'GET')).task.phase).not.toBe('COMPLETE')
  await shot(page, 'card-one-half-merged')
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 480, height: 900 }, hasTouch: true })

  test('the row says the state in words, and the session\'s top bar opens the card', async ({ page, browserName }) => {
    test.setTimeout(150_000)
    const repo = `phone-${browserName}-${Date.now().toString(36)}`
    await writePr(repo, 5, prNode(repo, 5, { checks: RED }))
    const { fixtureRoot } = await discoverBrowserFixture(PORT)
    const cwd = path.join(fixtureRoot, 'projects', 'walnut')
    const project = `PR pill ${repo}`
    const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', { title: 'Phone pull request task', source: 'local', pinned: false, project, cwd })
    litter.push(task.id)
    const started = await api<{ sessionId?: string }>(`/api/v1/tasks/${task.id}/start`, 'POST', { message: 'echo-input ready', cwd })
    await expect.poll(async () => started.sessionId ?? (await api<{ task: { session_id?: string } }>(`/api/tasks/${task.id}`, 'GET')).task.session_id, { timeout: 30_000 }).toBeTruthy()
    await api(`/api/tasks/${task.id}`, 'PATCH', { add_tags: [`pr:https://github.com/acme/${repo}/pull/5`] })

    await presetPanelView(page, { section: 'all', project })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const rowPill = row(page, task.id).locator('[data-testid="pr-pill"]')
    // A phone's row pills are labels in words (phone-fixes-r3.css): the state reads in full.
    await expect(rowPill).toBeVisible({ timeout: 20_000 })
    await expect(rowPill).toHaveText('#5 · 1 check failed', { timeout: 20_000 })
    await row(page, task.id).getByText('Phone pull request task').click()
    const barPill = page.locator('.phone-topbar [data-testid="pr-pill"]:visible')
    await expect(barPill).toBeVisible({ timeout: 20_000 })
    await expect(barPill).toHaveAttribute('data-tone', 'failed')
    await barPill.click()
    const card = page.locator('[data-testid="pr-card"]')
    await expect(card).toBeVisible()
    await expect(card.locator('.pr-card-check[data-status="failed"]')).toContainText('Unit tests')
    const box = (await card.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(480.5)
    await shot(page, `phone-card-${browserName}`)
    await page.keyboard.press('Escape')
    await expect(card).toBeHidden()
  })
})
