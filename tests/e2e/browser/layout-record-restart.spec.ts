/**
 * Home's and Org's layout survives a restart (web/src/utils/layout-record.ts).
 *
 * 2026-10-31, the user: "every time the Mac app restarts everything is gone ... these states
 * should be permanent, on disk", and for Org: "a lock icon in the org section ... and second
 * one come it will open next to it". The Mac app's web view drops sessionStorage on every
 * relaunch, where Home's columns and their locks lived; they are layout record fields now,
 * mirrored to the server's ui-prefs.json and adopted before the first render.
 *
 * Two restarts, both through the real server:
 *  - a new page in the same browser profile (sessionStorage empty, localStorage kept): the
 *    Mac app relaunching;
 *  - a new browser context (both empty): a new browser, or cleared data, on the server's
 *    copy alone.
 * The first load also comes through the legacy sessionStorage key (seedColumns), the path of
 * a window that was open across the upgrade.
 *
 * Automated browsers adopt no layout record from the shared fixture unless they opt in
 * (`walnut-e2e-layout-record`), so this spec opts in and the others stay isolated. The record
 * is one per server, so the browser projects take turns through this file (fileLock): run
 * side by side, one project's unlock reached the other's restart, which then read it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { homeColumns, loadHome, lockLeftmostPanel, seedColumns, setPanelMode } from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.LAYOUT_RECORD_SHOT_DIR ?? '/tmp/layout-record-restart'
const SIDS = ['pw-normal-session', 'pw-plan-session-completed'] as const
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Layout pins ${STAMP}`
const rowKey = `project:${PROJECT.toLowerCase()}`
const made: string[] = []
const ids = { alpha: '', alphaSid: '', beta: '' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

async function optIn(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(() => {
    try {
      localStorage.setItem('walnut-e2e-layout-record', '1')
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
    } catch { /* storage off */ }
  })
}

async function savedField(request: APIRequestContext, key: string): Promise<string> {
  const prefs = (await (await request.get('/api/ui-prefs')).json()).prefs as Record<string, { v: string | null }>
  return prefs[key]?.v ?? ''
}

async function stripIds(page: Page): Promise<string[]> {
  return page.locator('.main-page-session-column .session-panel[data-session-id]').evaluateAll(
    (els) => els.map((el) => `${el.getAttribute('data-session-id')}${el.querySelector('.session-panel-lock.is-locked') ? '*' : ''}`),
  )
}

async function freshContext(browser: Browser, baseURL: string | undefined): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } })
  await optIn(ctx)
  return ctx
}

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

// One project at a time through this file (the record is the server's, not the browser's).
const LOCK = path.join(os.tmpdir(), `walnut-layout-record-spec-${TEST_PORT}.lock`)
const LOCK_STALE_MS = 15 * 60_000
async function fileLock(): Promise<void> {
  const until = Date.now() + 10 * 60_000
  for (;;) {
    try { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid)); return } catch { /* held */ }
    try {
      const held = fs.statSync(LOCK).mtimeMs
      const pid = Number(fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'))
      let alive = true
      // Signal 0 only asks whether the holder still runs; it sends nothing.
      if (pid > 1) { try { process.kill(pid, 0) } catch { alive = false } } else alive = false
      if (!alive || Date.now() - held > LOCK_STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true })
    } catch { /* racing the holder's release */ }
    if (Date.now() > until) throw new Error(`layout record spec lock still held: ${LOCK}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}
test.beforeAll(async ({ request }) => {
  test.setTimeout(11 * 60_000)
  await fileLock()
  // Start from a cleared record: an earlier run that died may have left pins of deleted tasks.
  const cleared = JSON.stringify({ v: 1, value: null })
  const keys = ['home-columns', 'phone-columns', 'org-columns', 'home-focused-task', 'ask-selected', 'ask-agent']
  const res = await request.put('/api/ui-prefs', {
    data: { prefs: Object.fromEntries(keys.map((k) => [`open-walnut-layout:${k}`, { v: cleared, ts: Date.now() }])) },
  })
  expect(res.ok()).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (fs.existsSync(path.join(LOCK, 'pid')) && fs.readFileSync(path.join(LOCK, 'pid'), 'utf8') === String(process.pid)) {
    fs.rmSync(LOCK, { recursive: true, force: true })
  }
})

test('Home: the columns and their lock come back after a relaunch and in a new browser', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await optIn(page)
  await setPanelMode(page, '2')
  // The window open across the upgrade: its strip is still in the old sessionStorage key.
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 25_000 })
  await lockLeftmostPanel(page)
  const expected = [SIDS[1], `${SIDS[0]}*`]
  await expect.poll(() => stripIds(page)).toEqual(expected)
  // The mirror's debounced PUT reached the server's file.
  await expect.poll(() => savedField(page.request, 'open-walnut-layout:home-columns'), { timeout: 15_000 })
    .toContain(`{"id":"${SIDS[0]}","locked":true}`)
  await page.screenshot({ path: `${SHOTS}/1-home-before.png`, scale: 'css' })

  // Relaunch: a new page of the same profile, sessionStorage empty, no seeding script.
  const relaunched = await page.context().newPage()
  await relaunched.addInitScript(() => { try { sessionStorage.clear() } catch { /* off */ } })
  await loadHome(relaunched)
  await expect.poll(() => stripIds(relaunched), { timeout: 25_000 }).toEqual(expected)
  await relaunched.reload()
  await expect.poll(() => stripIds(relaunched), { timeout: 25_000 }).toEqual(expected)
  await relaunched.close()

  // A new browser: nothing local at all, only the server's copy.
  const ctx = await freshContext(browser, baseURL)
  try {
    const fresh = await ctx.newPage()
    await loadHome(fresh)
    await expect.poll(() => stripIds(fresh), { timeout: 25_000 }).toEqual(expected)
    await fresh.screenshot({ path: `${SHOTS}/2-home-new-browser.png`, scale: 'css' })
    // Unlocking is kept the same way.
    await fresh.locator(`.main-page-session-column .session-panel[data-session-id="${SIDS[0]}"] .session-panel-lock`).click()
    await expect.poll(() => savedField(fresh.request, 'open-walnut-layout:home-columns'), { timeout: 15_000 })
      .not.toContain('"locked":true')
  } finally {
    await ctx.close()
  }
})

test('Home: a task detail open before a reload or relaunch does not come back over Home; the focus does', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await optIn(page)
  const title = `Detail stays shut ${STAMP}`
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  await loadHome(page)
  const card = (p: Page) => p.locator('.todo-pinned-card', { hasText: title }).first()
  await card(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.locator('.task-detail-modal .todo-detail-title')).toHaveText(title)
  await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(task.id)

  const shut = async (p: Page, label: string) => {
    await expect(card(p)).toHaveClass(/todo-pinned-card-active/, { timeout: 25_000 })
    // Give a late restore every chance to open it.
    await p.waitForTimeout(1500)
    await expect(p.locator('.task-detail-modal'), label).toHaveCount(0)
  }
  // A reload (a deploy's stale-bundle reload, ⌘R) keeps ?task= in the address.
  await page.reload()
  await shut(page, 'after a reload')
  await page.screenshot({ path: `${SHOTS}/5-home-reload-no-detail.png`, scale: 'css' })
  // The Mac app's page-process recycle loads the same address in a new page.
  const recycled = await page.context().newPage()
  await recycled.goto(page.url())
  await shut(recycled, 'after a recycle at the same address')
  // A relaunch opens the bare address; the saved focus comes back as a row, not a sheet.
  await recycled.goto('/')
  await shut(recycled, 'after a relaunch')
  // The detail still opens on a click.
  await card(recycled).getByRole('button', { name: 'More actions' }).click()
  await recycled.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(recycled.locator('.task-detail-modal .todo-detail-title')).toHaveText(title)
  await recycled.close()
})

test('Home: a full-screen session panel does not come back after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await optIn(page)
  await seedColumns(page, [SIDS[0]])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SIDS[0]}"]`)
  await expect(panel).toBeVisible({ timeout: 25_000 })
  // The user's click enters full screen.
  await panel.locator('.session-panel-expand').click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  // A reload (a deploy, a restart) brings the column back, never the sheet.
  await page.reload()
  await expect(panel).toBeVisible({ timeout: 25_000 })
  await page.waitForTimeout(1500)
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  await page.screenshot({ path: `${SHOTS}/6-home-reload-no-fullscreen.png`, scale: 'css' })
})

test.describe('Org', () => {
  test.beforeAll(async ({ request }) => {
    const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
    const cwd = `${fixtureRoot}/projects/walnut`
    const create = async (title: string) => {
      const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
      made.push(task.id)
      return task.id
    }
    ids.alpha = await create(`Pin alpha ${STAMP}`)
    ids.beta = await create(`Pin beta ${STAMP}`)
    const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
    made.push(contact.task.id)
    ids.alphaSid = (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message: `Pin alpha ready ${STAMP}`, taskId: ids.alpha })).sessionId
  })

  const side = (page: Page) => page.getByTestId('org-side')
  const teamItem = (page: Page, id: string) => page.locator(`[data-testid="org-team-item"][data-task-id="${id}"]`)
  async function openLead(page: Page): Promise<void> {
    await loadHome(page)
    await page.getByTestId('sidebar-org').click()
    await page.locator(`[data-testid="org-channel"][data-key="${rowKey}"]`).click()
    await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
    await page.getByTestId('org-tab-team').click()
  }
  /** Click a Team row and wait for the URL to open it (the list re-sorts as statuses move under load). */
  async function openFromTeam(page: Page, id: string): Promise<void> {
    await expect(async () => {
      await teamItem(page, id).click()
      await expect(page).toHaveURL(new RegExp(`open=task(%3A|:)${id}`), { timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
  }
  const stripTargets = (page: Page) => side(page).evaluateAll(
    (els) => els.map((el) => `${el.getAttribute('data-target')}${el.classList.contains('is-locked') ? '*' : ''}`),
  )

  test('a locked panel stays, the next task opens next to it, and both come back after a restart', async ({ page, browser, baseURL }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await optIn(page)
    await openLead(page)
    await teamItem(page, ids.alpha).click()
    await expect(side(page)).toHaveAttribute('data-session-id', ids.alphaSid)
    // The session panel beside the page carries the lock now.
    await side(page).locator('.session-panel-lock').click()
    await expect(side(page)).toHaveClass(/is-locked/)
    await openFromTeam(page, ids.beta)
    await expect(side(page)).toHaveCount(2, { timeout: 15_000 })
    const expected = [`task:${ids.beta}`, `task:${ids.alpha}*`]
    await expect.poll(() => stripTargets(page)).toEqual(expected)
    // Side by side, the pin on the right.
    const [left, right] = await Promise.all([side(page).nth(0).boundingBox(), side(page).nth(1).boundingBox()])
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1)
    await expect(side(page).nth(1)).toHaveAttribute('data-session-id', ids.alphaSid)
    await page.screenshot({ path: `${SHOTS}/3-org-two-panels.png`, scale: 'css' })

    // Another task replaces the free panel, never the pin.
    await openFromTeam(page, ids.alpha)
    await expect.poll(() => stripTargets(page)).toEqual([`task:${ids.alpha}*`])
    await openFromTeam(page, ids.beta)
    await expect.poll(() => stripTargets(page)).toEqual(expected)
    await expect.poll(() => savedField(page.request, 'open-walnut-layout:org-columns'), { timeout: 15_000 })
      .toContain(`{"id":"task:${ids.alpha}","locked":true}`)

    // A new browser opens /org with nothing local: the pin is back (the free panel rode the
    // URL and this device's place, which a new browser does not have).
    const ctx = await freshContext(browser, baseURL)
    try {
      const fresh = await ctx.newPage()
      await openLead(fresh)
      await expect.poll(() => stripTargets(fresh), { timeout: 25_000 }).toEqual([`task:${ids.alpha}*`])
      await openFromTeam(fresh, ids.beta)
      await expect.poll(() => stripTargets(fresh)).toEqual(expected)
      // Reload: the place brings the free panel back beside the pin.
      await fresh.reload()
      await expect.poll(() => stripTargets(fresh), { timeout: 25_000 }).toEqual(expected)
      // Both panels show their task, not a placeholder: the pin its session, the free one its card.
      await expect(side(fresh).nth(1)).toHaveAttribute('data-session-id', ids.alphaSid, { timeout: 30_000 })
      await expect(side(fresh).nth(0).getByTestId('org-side-title')).toHaveText(`Pin beta ${STAMP}`, { timeout: 30_000 })
      await expect(fresh.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
      await fresh.screenshot({ path: `${SHOTS}/4-org-after-restart.png`, scale: 'css' })
      // × on the pin closes it for good.
      await side(fresh).nth(1).locator('.session-panel-close').first().click()
      await expect.poll(() => stripTargets(fresh)).toEqual([`task:${ids.beta}`])
      await expect.poll(() => savedField(fresh.request, 'open-walnut-layout:org-columns'), { timeout: 15_000 })
        .not.toContain(ids.alpha)
    } finally {
      await ctx.close()
    }
  })
})
