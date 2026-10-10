/**
 * Time tracking knows which part of a session panel had the input and which file
 * was open: real clicks in the chat column and in the Files view reach the
 * heartbeat as `view` (and `file` for the file viewer), the lease closes when the
 * window loses focus to another app, and the report groups the time by view and
 * by file (the path made relative to the session's working directory, on the
 * server). Run in both engines: the desktop app is a WKWebView.
 *
 *   npx playwright test time-tracking-views
 *   PW_WEBKIT=1 npx playwright test time-tracking-views --project webkit
 */
import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const FILE = 'time-view-target.txt'

interface Sample { kind: string; sessionId?: string; view?: string; file?: string; durationMs: number }

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  return (body?.session?.cwd ?? body?.cwd) as string
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      // An automated browser is not the human: the tracker stays off unless a test opts in.
      localStorage.setItem('walnut.time.allowAutomation', '1')
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
    } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('views and the open file reach the heartbeat and the report', async ({ page }, info) => {
  const posted: Sample[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/time/heartbeats')) {
      try { posted.push(...(JSON.parse(req.postData() ?? '{}').samples ?? [])) } catch { /* not ours */ }
    }
  })
  const cwd = await fixtureCwd(page)
  const target = path.join(cwd, FILE)
  await fs.writeFile(target, 'TIME VIEW TARGET\n')
  try {
    await page.locator('.todo-search-input').fill(SESSION_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible()
    await task.locator('.todo-item-title').click()
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`).first()
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Files' }).click()
    const explorer = panel.locator('.session-file-explorer')
    await expect(explorer).toBeVisible({ timeout: 15_000 })

    // The markers are in the DOM where the resolver looks for them.
    await expect(panel.locator('.session-panel-chat-col')).toHaveAttribute('data-time-view', 'chat')
    await expect(panel.locator('.session-panel-diff-col').first()).toHaveAttribute('data-time-view', 'files')

    // 1. Input in the chat column.
    await panel.locator('.session-panel-chat-col').click({ position: { x: 40, y: 40 } })
    await page.waitForTimeout(1_200)
    // 2. Open a file and work in the viewer.
    await explorer.locator('.sfe-name', { hasText: FILE }).click()
    const preview = explorer.locator('.session-file-explorer-preview')
    await expect(preview).toContainText('TIME VIEW TARGET', { timeout: 15_000 })
    await expect(preview).toHaveAttribute('data-time-file', target)
    await preview.click({ position: { x: 60, y: 60 } })
    await page.waitForTimeout(1_500)
    // 3. Another app takes the focus: the lease closes now, not 60 s later.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
      window.dispatchEvent(new Event('blur'))
    })
    await expect.poll(() => posted.some((s) => s.view === 'files' && s.file === target), { timeout: 10_000 }).toBe(true)
    const mine = posted.filter((s) => s.sessionId === SESSION_ID)
    expect(mine.some((s) => s.view === 'chat')).toBe(true)
    // The file sample ends at the blur: well under a lease.
    const fileSample = mine.find((s) => s.file === target)!
    expect(fileSample.durationMs).toBeLessThan(30_000)

    // 4. The report groups it: the view word, and the file relative to the session's cwd.
    await expect.poll(async () => {
      const r = await page.request.get('/api/time/report?last_days=1&group_by=view,file&top=50')
      const body = await r.json()
      const views = (body.groups?.view?.rows ?? []).map((v: { view: string }) => v.view)
      const files = (body.groups?.file?.rows ?? []).map((f: { file: string }) => f.file)
      return views.includes('chat') && views.includes('files') && files.includes(FILE)
    }, { timeout: 15_000 }).toBe(true)
    await page.screenshot({ path: `/tmp/time-review/pw-${info.project.name}-files-view.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } })
  } finally {
    await fs.rm(target, { force: true })
  }
})
