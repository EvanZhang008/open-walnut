/**
 * Every panel beside an Org node stays as the user left it, locked or not (2026-11-17, the user: "I
 * have this task open, but I did not lock it. Then I switch to other chat, and come back, it should
 * be there ... whether it is locked or not, you can't change it every time I go out and come back").
 * Picking another node used to clear the free (unlocked) panel, so it was gone on the way back.
 *
 * Two VPs, each with its own panels (a pin and a free one under the first, a free one under the
 * second), picked back and forth, a new task opened under one, a reload, Home and back, a close:
 * after every step each node shows exactly its own panels, in their order, at the same width.
 * Only the user's own × or a task opened beside that same node changes what a node shows.
 * The fixture is shared, so this file makes its own projects and keeps its prefs to itself.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { openTaskFromRail } from './org-view-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT_A = `Free kept a ${STAMP}`
const PROJECT_B = `Free kept b ${STAMP}`
const KEY_A = `project:${PROJECT_A.toLowerCase()}`
const KEY_B = `project:${PROJECT_B.toLowerCase()}`
const made: string[] = []
const ids = { a1: '', a2: '', b1: '', b2: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.beforeAll(async ({ request }) => {
  const create = async (title: string, project: string) => {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project, source: 'local' })
    made.push(task.id)
    return task.id
  }
  ids.a1 = await create(`Kept a1 ${STAMP}`, PROJECT_A)
  ids.a2 = await create(`Kept a2 ${STAMP}`, PROJECT_A)
  ids.b1 = await create(`Kept b1 ${STAMP}`, PROJECT_B)
  ids.b2 = await create(`Kept b2 ${STAMP}`, PROJECT_B)
  // Two tasks each, so each project has a VP of its own.
  for (const to of [PROJECT_A, PROJECT_B]) made.push((await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to })).task.id)
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

/** The server's ui-prefs, kept for this page only: GET answers what was PUT, last writer per key. */
async function ownUiPrefs(page: Page): Promise<void> {
  const prefs: Record<string, { v: string | null; ts: number }> = { 'open-walnut-home-chat-visible': { v: 'false', ts: 1 } }
  await page.route(/\/api\/ui-prefs(\?|$)/, async (route) => {
    const req = route.request()
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as { prefs?: Record<string, { v: string | null; ts: number }> }
      for (const [k, e] of Object.entries(body.prefs ?? {})) if (!prefs[k] || e.ts >= prefs[k].ts) prefs[k] = e
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      return
    }
    const key = new URL(req.url()).searchParams.get('key')
    const out = key ? (key in prefs ? { [key]: prefs[key] } : {}) : prefs
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: out }) })
  })
}

const side = (page: Page) => page.getByTestId('org-side')
const sideOf = (page: Page, id: string) => page.locator(`[data-testid="org-side"][data-target="task:${id}"]`)
/** What the strip shows, in order, a pin marked `*`. */
const strip = (page: Page) => side(page).evaluateAll(
  (els) => els.map((el) => `${el.getAttribute('data-target')}${el.classList.contains('is-locked') ? '*' : ''}`),
)
const stripWidth = (page: Page) => page.getByTestId('org-side-strip').evaluate((el) => Math.round(el.getBoundingClientRect().width))

async function pick(page: Page, key: string, project: string): Promise<void> {
  await page.locator(`[data-testid="org-channel"][data-key="${key}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${project} VP`)
}

async function openFromRail(page: Page, id: string): Promise<void> {
  await openTaskFromRail(page, id, () => expect(sideOf(page, id)).toBeVisible({ timeout: 5_000 }))
}

test('every panel beside a VP, locked or not, is still there after another VP, a reload and Home', async ({ page }) => {
  await ownUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut-e2e-layout-record', '1') } catch { /* storage off */ }
  })
  await page.setViewportSize({ width: 1600, height: 940 })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()

  // Under the first VP: a1 locked, a2 open beside it, not locked.
  await pick(page, KEY_A, PROJECT_A)
  await openFromRail(page, ids.a1)
  await sideOf(page, ids.a1).getByTestId('org-side-lock').click()
  await expect.poll(() => strip(page)).toEqual([`task:${ids.a1}*`])
  await openFromRail(page, ids.a2)
  const A = [`task:${ids.a2}`, `task:${ids.a1}*`]
  await expect.poll(() => strip(page)).toEqual(A)
  const widthA = await stripWidth(page)
  await page.screenshot({ path: `${SHOTS}/org-free-kept-a-${test.info().project.name}.png` })

  // Under the second VP: b1 open, not locked. Nothing of the first VP's.
  await pick(page, KEY_B, PROJECT_B)
  await expect.poll(() => strip(page)).toEqual([])
  await openFromRail(page, ids.b1)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.b1}`])

  for (let round = 0; round < 3; round++) {
    await pick(page, KEY_A, PROJECT_A)
    await expect.poll(() => strip(page), { message: `round ${round}: the first VP's panels` }).toEqual(A)
    expect(Math.abs((await stripWidth(page)) - widthA), `round ${round}: the same width`).toBeLessThanOrEqual(1)
    await pick(page, KEY_B, PROJECT_B)
    await expect.poll(() => strip(page), { message: `round ${round}: the second VP's panel` }).toEqual([`task:${ids.b1}`])
  }

  // A new task under the second VP takes that VP's free panel only.
  await openFromRail(page, ids.b2)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.b2}`])
  await pick(page, KEY_A, PROJECT_A)
  await expect.poll(() => strip(page)).toEqual(A)
  await pick(page, KEY_B, PROJECT_B)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.b2}`])

  // A reload, on the second VP.
  await page.reload()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT_B} VP`, { timeout: 30_000 })
  await expect.poll(() => strip(page), { timeout: 25_000 }).toEqual([`task:${ids.b2}`])
  await pick(page, KEY_A, PROJECT_A)
  await expect.poll(() => strip(page)).toEqual(A)

  // Home and back: the page comes back on the first VP as it was; the second keeps its own.
  await page.locator('.sidebar-home-group a').first().click()
  await expect(page.locator('.todo-panel').first()).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT_A} VP`, { timeout: 30_000 })
  await expect.poll(() => strip(page), { timeout: 25_000 }).toEqual(A)
  expect(Math.abs((await stripWidth(page)) - widthA)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${SHOTS}/org-free-kept-a-after-${test.info().project.name}.png` })
  await pick(page, KEY_B, PROJECT_B)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.b2}`])

  // The user's own x closes it, and closed it stays: away and back, and a reload.
  await pick(page, KEY_A, PROJECT_A)
  await sideOf(page, ids.a2).locator('[data-testid="org-side-close"], .session-panel-close').first().click()
  await expect.poll(() => strip(page)).toEqual([`task:${ids.a1}*`])
  await pick(page, KEY_B, PROJECT_B)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.b2}`])
  await pick(page, KEY_A, PROJECT_A)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.a1}*`])
  await page.reload()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT_A} VP`, { timeout: 30_000 })
  await expect.poll(() => strip(page), { timeout: 25_000 }).toEqual([`task:${ids.a1}*`])
  await page.waitForTimeout(1000)
  await expect.poll(() => strip(page)).toEqual([`task:${ids.a1}*`])
})
