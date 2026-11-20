/**
 * The helpers of tests/e2e/browser/project-first-start.spec.ts (the Work in pill of the
 * experiment project_first_start): registry rows, the experiments, the draft's Work in pill and
 * its popover, Start and what it sent, and the task's workspace as the server reports it.
 */
import path from 'node:path'
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { draftComposer } from './draft-helpers'

export const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
export const SHOTS = process.env.PW_SCREENSHOT_DIR ?? '/tmp/project-first-start'

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

/** Type the first message and press Enter; returns the request body and the answer. */
export async function start(page: Page, message: string): Promise<{ sent: Record<string, unknown>; answer: Record<string, unknown> }> {
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(message)
  await input.press('Enter')
  const res = await response
  expect(res.status(), await res.text()).toBe(200)
  return { sent: res.request().postDataJSON() as Record<string, unknown>, answer: await res.json() as Record<string, unknown> }
}

export const pillsRow = (panel: Locator): Locator => panel.locator('.draft-composer-bar')
export const workIn = (panel: Locator): Locator => panel.getByTestId('draft-work-in-pill')
export const picker = (page: Page): Locator => page.getByTestId('work-in-picker')
export const projectRow = (box: Locator, name: string): Locator => box.getByTestId(`work-in-project-${name}`)

export async function openPicker(page: Page, panel: Locator, tab: 'projects' | 'folders' = 'projects'): Promise<Locator> {
  await workIn(panel).click()
  await expect(picker(page)).toBeVisible()
  await picker(page).getByTestId(`work-in-tab-${tab}`).click()
  await expect(picker(page).getByTestId(`work-in-tab-${tab}`)).toHaveAttribute('aria-selected', 'true')
  return picker(page)
}

export async function pickProject(page: Page, panel: Locator, name: string): Promise<void> {
  const box = await openPicker(page, panel)
  await box.getByTestId('work-in-search').fill(name)
  await projectRow(box, name).locator('.wip-pick').click()
  await expect(picker(page)).toHaveCount(0)
}

/** The Work in pill is the row's one "where": none of the pills it replaced is there. */
export async function expectOnePill(panel: Locator): Promise<void> {
  await expect(workIn(panel)).toHaveCount(1)
  for (const gone of ['.draft-folder-pill', '.draft-project-chip', '.draft-quick-block', '[data-testid="draft-workspace-auto"]',
    '[data-testid="draft-workspace-row"]', '[data-testid="draft-start-host-pill"]', '[data-testid="draft-project-source-chip"]',
    '[data-testid="draft-project-start-pill"]']) {
    await expect(panel.locator(gone), gone).toHaveCount(0)
  }
  await expect(pillsRow(panel).locator('.session-action-chip').first()).toHaveAttribute('data-testid', 'draft-work-in-pill')
}

/** "Browse or type a path…": today's full folder picker, confirmed on `cwd`. */
export async function browseTo(page: Page, panel: Locator, cwd: string): Promise<void> {
  const box = await openPicker(page, panel, 'folders')
  await box.getByTestId('work-in-browse').click()
  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })
  await expect(selector.locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  const localTab = selector.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  const input = selector.locator('.sps-search-input')
  await input.fill(cwd)
  await input.press('Shift+Enter')
  await expect(selector).toBeHidden()
  await expect(workIn(panel)).toContainText(path.basename(cwd))
}

export async function shot(page: Page, name: string, target: Locator, pad = 12): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5_000 }).catch(() => {})
  const box = await target.boundingBox()
  const vp = page.viewportSize()!
  const file = path.join(SHOTS, `${name}.png`)
  if (!box) { await page.screenshot({ path: file }); return }
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  await page.screenshot({ path: file, clip: { x, y, width: Math.min(vp.width - x, box.width + pad * 2), height: Math.min(vp.height - y, box.height + pad * 2) } })
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

