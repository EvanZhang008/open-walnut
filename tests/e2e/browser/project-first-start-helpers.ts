/**
 * The helpers of tests/e2e/browser/project-first-start*.spec.ts (the v6 new task draft of the
 * experiment project_first_start): registry rows, the experiments, the draft's mode tiles, its
 * Project + Where row and their menus, Start and what it sent, the composer's place, and the
 * task's workspace as the server reports it.
 */
import path from 'node:path'
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { draftComposer } from './draft-helpers'

export const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
export const SHOTS = process.env.PW_SCREENSHOT_DIR ?? path.join(process.env.WALNUT_TASK_DIR ?? '/tmp', 'shots', 'project-first-start')
/** Linux and Windows call the machine Walnut runs on this; a Mac says "This Mac". */
export const LOCAL_NAME = process.platform === 'darwin' ? 'This Mac' : 'This computer'

export interface Ws { state: string; provider: string; root?: string; inputs?: Record<string, unknown>; repos?: Array<{ name?: string }> }

export async function makeProject(request: APIRequestContext, name: string, metadata: Record<string, unknown>): Promise<void> {
  expect((await request.post('/api/projects', { data: { name } })).ok()).toBe(true)
  if (Object.keys(metadata).length) {
    const res = await request.put(`/api/projects/${encodeURIComponent(name)}/metadata`, { data: metadata })
    expect(res.ok(), await res.text()).toBe(true)
  }
}

/** The experiment on or off; `more`: other experiments in the same write (isolated_workspace_by_default). */
export async function setFlag(request: APIRequestContext, on: boolean, more: Record<string, boolean> = {}): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { experimental?: Record<string, boolean> }
  const res = await request.put('/api/config', { data: { experimental: { ...(cfg.experimental ?? {}), ...more, project_first_start: on } } })
  expect(res.ok()).toBe(true)
}

export async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

export async function readTask(page: Page, taskId: string): Promise<{ workspace?: Ws; project?: string }> {
  const res = await page.request.get(`/api/tasks/${taskId}`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { task: { workspace?: Ws; project?: string } }).task
}

export async function waitWorkspace(page: Page, taskId: string, state: string, timeout = 90_000): Promise<Ws> {
  let last: Ws | undefined
  await expect.poll(async () => { last = (await readTask(page, taskId)).workspace; return last?.state }, { timeout, message: `workspace of ${taskId} never reached ${state}` }).toBe(state)
  return last!
}

const isQuickStart = (method: string, url: string): boolean => method === 'POST' && new URL(url).pathname === '/api/sessions/quick-start'

/** Type the first message and press Enter; returns the request body and the answer. */
export async function start(page: Page, message: string): Promise<{ sent: Record<string, unknown>; answer: Record<string, unknown> }> {
  const response = page.waitForResponse((r) => isQuickStart(r.request().method(), r.url()))
  const input = draftComposer(page)
  await input.fill(message)
  await input.press('Enter')
  const res = await response
  expect(res.status(), await res.text()).toBe(200)
  return { sent: res.request().postDataJSON() as Record<string, unknown>, answer: await res.json() as Record<string, unknown> }
}

/** Every quick-start request the page sends from now on (a blocked Start sends none). */
export function countStarts(page: Page): { readonly n: number } {
  const seen = { n: 0 }
  page.on('request', (r) => { if (isQuickStart(r.method(), r.url())) seen.n += 1 })
  return seen
}

// ── The v6 body ──

export const v6 = (panel: Locator): Locator => panel.getByTestId('draft-v6')
export const tile = (panel: Locator, mode: 'task' | 'chat'): Locator => panel.locator(`.draft-v6-tile[data-mode-card="${mode}"]`)
export const projectField = (panel: Locator): Locator => panel.getByTestId('draft-v6-project')
export const whereField = (panel: Locator): Locator => panel.getByTestId('draft-v6-where')
export const line = (panel: Locator): Locator => panel.getByTestId('draft-v6-line')
export const whereMenu = (page: Page): Locator => page.getByTestId('draft-v6-where-menu')
export const projectMenu = (page: Page): Locator => page.getByTestId('draft-v6-project-menu')
export const hostMenu = (page: Page): Locator => page.getByTestId('draft-v6-host-menu')
/** The draft's send arrow (the v6 draft has no send words: Evan crossed out "Start task", 2026-11-23). */
export const sendArrow = (panel: Locator): Locator => panel.locator('.draft-v6-input .wn-input-send')

/** The lower row's More: the draft's one menu (tier, priority, dates, the task source). */
export async function openMore(panel: Locator): Promise<Locator> {
  await panel.locator('.draft-v6-lower button.draft-more-btn').click()
  const menu = panel.page().getByTestId('draft-task-menu')
  await expect(menu).toBeVisible({ timeout: 10_000 })
  return menu
}

export async function pickProject(page: Page, panel: Locator, name: string): Promise<void> {
  await projectField(panel).click()
  await expect(projectMenu(page)).toBeVisible()
  await projectMenu(page).getByTestId('draft-v6-project-search').fill(name)
  await projectMenu(page).getByTestId(`draft-v6-project-${name}`).first().click()
  await expect(projectMenu(page)).toHaveCount(0)
  await expect(panel.getByTestId('draft-v6-project-name')).toHaveText(name)
}

/** The Where menu from the field's own button, at its right end (a folder crumb would open it at that level). */
export async function openWhere(page: Page, panel: Locator): Promise<Locator> {
  const open = whereField(panel).getByTestId('draft-v6-where-open')
  const box = (await open.boundingBox())!
  await open.click({ position: { x: box.width - 14, y: box.height / 2 } })
  await expect(whereMenu(page)).toBeVisible()
  return whereMenu(page)
}

/** Type a path into the Where menu and use it, as a person would. */
export async function pickTypedPath(page: Page, panel: Locator, cwd: string): Promise<void> {
  const menu = await openWhere(page, panel)
  await menu.getByTestId('draft-v6-where-search').fill(cwd)
  const use = menu.getByTestId('draft-v6-use-path')
  await expect(use).toHaveAttribute('data-state', 'valid', { timeout: 20_000 })
  await use.click()
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(whereField(panel)).toHaveAttribute('data-auto', 'false')
  await expect(panel.getByTestId('draft-v6-folder')).toContainText(path.basename(cwd))
}

/** The host crumb (the field's first part, wide or narrow) opens the Host menu; then a host. */
export async function pickHost(page: Page, panel: Locator, key: string): Promise<void> {
  await whereField(panel).getByTestId('draft-v6-host').click()
  await expect(hostMenu(page)).toBeVisible()
  await hostMenu(page).getByTestId(`draft-v6-host-${key}`).click()
  await expect(hostMenu(page)).toHaveCount(0)
}

export interface DirEntry { cwd: string; host?: string | null; hostLabel?: string; project?: string; count?: number; lastUsed?: string }

/** The recent-folders list with `extra` first (only the LIST is added to; the folders stay as they are).
 *  `only`: the list is `extra` alone, for a test whose memory must not see earlier tests' starts. */
export async function withDirs(page: Page, extra: DirEntry[], opts: { only?: boolean } = {}): Promise<void> {
  await page.route('**/api/sessions/working-dirs*', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs?: Array<Record<string, unknown>> }
    body.dirs = [...extra.map((d) => ({ host: null, project: '', count: 3, lastUsed: new Date().toISOString(), ...d })), ...(opts.only ? [] : body.dirs ?? [])]
    await route.fulfill({ response: res, json: body })
  })
}

// ── Nothing jumps ──

export interface Geometry { composer: { x: number; y: number; width: number; height: number }; lower: { x: number; y: number; width: number; height: number } }

/** Where the composer and the row under it stand. */
export async function geometry(panel: Locator): Promise<Geometry> {
  const composer = await panel.locator('.draft-v6-input').boundingBox()
  const lower = await panel.getByTestId('draft-v6-lower').boundingBox()
  expect(composer, 'the composer is on screen').toBeTruthy()
  expect(lower, 'the lower row is on screen').toBeTruthy()
  return { composer: composer!, lower: lower! }
}

/** The composer and the lower row stand where they stood at `base`, to the pixel. */
export async function expectSameGeometry(panel: Locator, base: Geometry, step: string): Promise<void> {
  const now = await geometry(panel)
  const round = (g: Geometry) => JSON.stringify({
    composer: [g.composer.x, g.composer.y, g.composer.width, g.composer.height].map(Math.round),
    lower: [g.lower.x, g.lower.y, g.lower.width, g.lower.height].map(Math.round),
  })
  expect(round(now), `the composer moved: ${step}`).toBe(round(base))
}

/** The whole window (the user's size) once animations settle: every state is reviewed in its page. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5_000 }).catch(() => {})
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
