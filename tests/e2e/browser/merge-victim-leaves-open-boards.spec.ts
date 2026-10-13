/**
 * A merge takes its victims off every open board, live.
 *
 * The r5 gate's L-27: a merge announced each victim's delete as `{ task }` with
 * no id, the board removes rows by id, and every open window, the Mac app
 * included, kept the merged tasks until a reload; a click on one then reached a
 * task that was gone. Here two windows show the board, the merge goes over
 * HTTP (what a session's task_merge sends), and both windows must drop the
 * victims with no reload while the survivor stays.
 *
 * Chromium, and with PW_WEBKIT=1 --project webkit, WebKit (the Mac app).
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, openListProject } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 })
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/merge-victim-leaves-open-boards'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

const row = (page: Page, id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"]`)

/** The board in a window of its own, the project's list open; a reload would drop the marker. */
async function openBoard(page: Page, baseURL: string, project: string, errors: string[]): Promise<void> {
  page.on('pageerror', (error) => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message) })
  await isolateUiPrefs(page)
  await openHome(page, baseURL)
  await openListProject(page, project)
  await page.evaluate(() => { (window as unknown as { __sameLoad: boolean }).__sameLoad = true })
}

test('a merge takes the victims off every open board with no reload; the survivor stays', async ({ page, baseURL, request }) => {
  test.setTimeout(120_000)
  const engine = test.info().project.name
  const tag = `${engine}-${test.info().repeatEachIndex}-${Date.now()}`
  const project = `Merge live ${tag}`
  const make = async (title: string): Promise<string> => {
    const res = await request.post('/api/tasks', { data: { title, project, source: 'local' } })
    expect(res.status()).toBe(201)
    const id = (await res.json()).task.id as string
    made.push(id)
    // New tasks are pinned; these belong to the project's list.
    expect((await request.delete(`/api/focus/tasks/${id}`)).ok()).toBe(true)
    return id
  }
  const survivor = await make(`Quarterly report ${tag}`)
  const victims = [await make(`Quarterly report copy ${tag}`), await make(`Quarterly report second copy ${tag}`)]

  const errors: string[] = []
  const other = await page.context().newPage()
  await openBoard(page, baseURL!, project, errors)
  await openBoard(other, baseURL!, project, errors)
  for (const win of [page, other]) {
    for (const id of [survivor, ...victims]) await expect(row(win, id)).toBeVisible()
  }
  await other.locator('.todo-panel').screenshot({ path: `${SHOTS}/${engine}-second-window-before.png` })

  const res = await request.post(`/api/tasks/${survivor}/merge`, { data: { victim_ids: victims } })
  expect(res.status()).toBe(200)
  expect(await res.json()).toMatchObject({ merged: 2, task: { id: survivor } })

  // Soft, so a failure still checks the other window and leaves the picture of it.
  for (const [name, win] of [['first', page], ['second', other]] as const) {
    for (const id of victims) await expect.soft(row(win, id), `${name} window, victim ${id}`).toHaveCount(0, { timeout: 5_000 })
    await expect.soft(row(win, survivor), `${name} window, survivor`).toBeVisible()
    expect.soft(await win.evaluate(() => (window as unknown as { __sameLoad?: boolean }).__sameLoad), `${name} window reloaded`).toBe(true)
  }
  await other.locator('.todo-panel').screenshot({ path: `${SHOTS}/${engine}-second-window-after.png` })
  expect(errors).toEqual([])
  await other.close()
})
