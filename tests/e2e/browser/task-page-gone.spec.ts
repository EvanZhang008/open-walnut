/**
 * The task page, and its pop-out, when the task goes away under it.
 *
 * The fork r6 gate (MED-1): the task page navigated home on a merge too, and a
 * pop-out ("Open in new tab", /popout?view=task&id=…) that navigated to an app
 * path crashed with "Rendered more hooks than during the previous render", in
 * Chromium and WebKit. The root cause was older: App returned the pop-out shell
 * above one of its hooks, so a plain delete crashed a pop-out on base too. Now:
 *  - merged: the page and the pop-out say "This task was merged into <title>"
 *    and link there; the pop-out's link stays in the pop-out;
 *  - deleted elsewhere: the pop-out says "This task was deleted"; the app's
 *    task page goes home, as before;
 *  - the pop-out's own Delete button: the same notice, no crash;
 *  - a link in the pop-out that leads to the app (a session row) opens the app
 *    in that tab: the path that crashed on base for any reason, not only a delete.
 * Every case also checks that no window shows the crash screen or throws.
 *
 * Chromium, and with PW_WEBKIT=1 --project webkit, WebKit (the Mac app).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { homeNavigation, openHome } from './home-navigation-helpers'

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 })
const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/task-page-gone'
const CRASH = 'Something went wrong rendering the page'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

/** Collect the page errors of a window (WebKit's access-control noise aside). */
function watch(win: Page, errors: string[]): void {
  win.on('pageerror', (error) => { if (!/due to access control checks|Load failed/.test(error.message)) errors.push(error.message) })
}

/** Every window of the context starts from the first-boot UI prefs. */
async function isolatePrefs(context: BrowserContext): Promise<void> {
  await context.route('**/api/ui-prefs', async (route) => {
    const body = route.request().method() === 'GET' ? '{"prefs":{}}' : '{"ok":true}'
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
}

/** Real UI route to the task page: sidebar, Tasks table, the row's title. */
async function openTaskPage(page: Page, id: string, title: string): Promise<void> {
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.locator('.sidebar a[href="/tasks"]').click()
  await expect(page.getByTestId('tasks-table')).toBeVisible()
  await page.locator('.tp-search').fill(title)
  await page.locator(`.tp-row[data-task-id="${id}"] .tp-row-title`).click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${id}$`))
  await expect(page.locator('.tdv2-title')).toHaveText(title, { timeout: 15_000 })
}

/** The task page's "Open in new tab": the pop-out window, showing the task. */
async function openPopout(page: Page, id: string, title: string, errors: string[]): Promise<Page> {
  const opened = page.context().waitForEvent('page')
  await page.locator('.tdv2-head button[aria-label="Open in new tab"]').click()
  const pop = await opened
  watch(pop, errors)
  await expect(pop.locator('.tdv2-title')).toHaveText(title, { timeout: 20_000 })
  expect(popoutTarget(pop)).toBe(id)
  return pop
}

/** The task a pop-out window shows, from its URL (null when it left the pop-out). */
function popoutTarget(pop: Page): string | null {
  const url = new URL(pop.url())
  return url.pathname === '/popout' && url.searchParams.get('view') === 'task' ? url.searchParams.get('id') : null
}

async function setUp(page: Page, baseURL: string, request: import('@playwright/test').APIRequestContext) {
  const engine = test.info().project.name
  const tag = `${engine}-${test.info().repeatEachIndex}-${Date.now()}`
  const make = async (title: string): Promise<string> => {
    const res = await request.post('/api/tasks', { data: { title, project: `Task page gone ${tag}`, source: 'local' } })
    expect(res.status()).toBe(201)
    const id = (await res.json()).task.id as string
    made.push(id)
    return id
  }
  const errors: string[] = []
  watch(page, errors)
  await isolatePrefs(page.context())
  await openHome(page, baseURL)
  return { engine, tag, make, errors }
}

test('a merge: the task page and its pop-out say where the task went, and the link goes there', async ({ page, baseURL, request }) => {
  test.setTimeout(120_000)
  const { engine, tag, make, errors } = await setUp(page, baseURL!, request)
  const survivorTitle = `Budget review ${tag}`
  const victimTitle = `Budget review copy ${tag}`
  const survivor = await make(survivorTitle)
  const victim = await make(victimTitle)
  await openTaskPage(page, victim, victimTitle)
  const pop = await openPopout(page, victim, victimTitle, errors)

  const res = await request.post(`/api/tasks/${survivor}/merge`, { data: { victim_ids: [victim] } })
  expect(res.status()).toBe(200)

  // Soft, so a failure still checks the other window and leaves the picture of it.
  for (const [name, win] of [['pop-out', pop], ['task page', page]] as const) {
    const notice = win.getByTestId('task-gone-notice')
    await expect.soft(notice, `${name}: notice`).toContainText('This task was merged into', { timeout: 10_000 })
    await expect.soft(notice.getByRole('link', { name: survivorTitle }), `${name}: link to the survivor`).toBeVisible()
    await expect.soft(win.getByText(CRASH), `${name}: crash screen`).toHaveCount(0)
  }
  expect.soft(popoutTarget(pop), 'the pop-out stays on the merged task').toBe(victim)
  expect.soft(new URL(page.url()).pathname, 'the task page stays on the merged task').toBe(`/tasks/${victim}`)
  await pop.screenshot({ path: `${SHOTS}/${engine}-merge-popout-notice.png` })
  await page.screenshot({ path: `${SHOTS}/${engine}-merge-page-notice.png` })

  // The pop-out's link stays in the pop-out and shows the survivor.
  await pop.getByTestId('task-gone-notice').getByRole('link', { name: survivorTitle }).click()
  await expect(pop.locator('.tdv2-title')).toHaveText(survivorTitle, { timeout: 15_000 })
  expect(popoutTarget(pop)).toBe(survivor)
  await expect(pop.getByTestId('task-gone-notice')).toHaveCount(0)

  // The task page's link opens the survivor's task page.
  await page.getByTestId('task-gone-notice').getByRole('link', { name: survivorTitle }).click()
  await expect(page).toHaveURL(new RegExp(`/tasks/${survivor}$`))
  await expect(page.locator('.tdv2-title')).toHaveText(survivorTitle, { timeout: 15_000 })
  await expect(page.getByTestId('task-gone-notice')).toHaveCount(0)

  for (const win of [pop, page]) await expect(win.getByText(CRASH)).toHaveCount(0)
  expect(errors).toEqual([])
  await pop.close()
})

test('a delete from elsewhere: the pop-out says so, the task page goes home, neither crashes', async ({ page, baseURL, request }) => {
  test.setTimeout(120_000)
  const { engine, tag, make, errors } = await setUp(page, baseURL!, request)
  const title = `Old draft ${tag}`
  const id = await make(title)
  await openTaskPage(page, id, title)
  const pop = await openPopout(page, id, title, errors)

  const res = await request.delete(`/api/tasks/${id}?force=true`)
  expect(res.ok()).toBe(true)

  await expect.soft(pop.getByTestId('task-gone-notice'), 'pop-out: notice').toHaveText('This task was deleted.', { timeout: 10_000 })
  await expect.soft(pop.getByText(CRASH), 'pop-out: crash screen').toHaveCount(0)
  expect.soft(popoutTarget(pop), 'the pop-out stays where it was').toBe(id)
  await expect.soft(page, 'task page: home').toHaveURL(new URL('/', baseURL).toString(), { timeout: 10_000 })
  await expect.soft(page.getByText(CRASH), 'task page: crash screen').toHaveCount(0)
  await pop.screenshot({ path: `${SHOTS}/${engine}-delete-popout-notice.png` })
  expect(errors).toEqual([])
  await pop.close()
})

test("the pop-out's own Delete: it says the task was deleted and does not crash", async ({ page, baseURL, request }) => {
  test.setTimeout(120_000)
  const { engine, tag, make, errors } = await setUp(page, baseURL!, request)
  const title = `Scratch note ${tag}`
  const id = await make(title)
  await openTaskPage(page, id, title)
  const pop = await openPopout(page, id, title, errors)

  await pop.locator('.tdv2-head').getByRole('button', { name: 'Delete', exact: true }).click()
  await pop.locator('.app-modal-overlay').getByRole('button', { name: 'Delete', exact: true }).click()

  await expect.soft(pop.getByTestId('task-gone-notice'), 'pop-out: notice').toHaveText('This task was deleted.', { timeout: 10_000 })
  await expect.soft(pop.getByText(CRASH), 'pop-out: crash screen').toHaveCount(0)
  expect.soft(popoutTarget(pop), 'the pop-out stays where it was').toBe(id)
  // The app's task page heard the delete too, and went home.
  await expect.soft(page, 'task page: home').toHaveURL(new URL('/', baseURL).toString(), { timeout: 10_000 })
  expect((await request.get(`/api/tasks/${id}`)).status()).toBe(404)
  await pop.screenshot({ path: `${SHOTS}/${engine}-own-delete-popout-notice.png` })
  expect(errors).toEqual([])
  await pop.close()
})

test('a session row in the pop-out opens the app in that tab, with no crash', async ({ page, baseURL, request }) => {
  // The fixture's first task: besides its own session it links one more, listed as a row.
  test.setTimeout(120_000)
  const { engine, errors } = await setUp(page, baseURL!, request)
  const id = 'pw-task-001'
  const title = 'Playwright test task'
  await openTaskPage(page, id, title)
  const pop = await openPopout(page, id, title, errors)

  await pop.locator('.tdv2-session-row').first().click()

  // The pop-out tab is now the app, on its home page.
  await expect.soft(pop, 'pop-out: the app home').toHaveURL(new URL('/', baseURL).toString(), { timeout: 15_000 })
  await expect.soft(homeNavigation(pop), 'pop-out: the home board').toBeVisible({ timeout: 30_000 })
  await expect.soft(pop.getByText(CRASH), 'pop-out: crash screen').toHaveCount(0)
  await pop.screenshot({ path: `${SHOTS}/${engine}-popout-session-row-app.png` })
  expect(errors).toEqual([])
  await pop.close()
})
