/**
 * The phone's ⋮ menu reaches a session's background work too (2026-10-26). The phone
 * draws its own menu rows instead of the desktop's session section, so the
 * "Background tasks" row lives there as well: after every task finished there is no
 * note on the chat to open the list from. A session that never had background work
 * has no such row. The ledger comes from the session's workflow route, as on a reload.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { PHONE } from './phone-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID_BG = '7e1b2026-1026-4000-8000-0000000000c1'
const SID_NONE = '7e1b2026-1026-4000-8000-0000000000c2'
const SID_RUN = '7e1b2026-1026-4000-8000-0000000000c3'
const SHOTS = '/tmp/background-placement'
// A fixture task, so the session has a menu at all (the task's menu is the session's).
const TASK_ID = 'pw-task-question-recovery'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.setTimeout(120_000)

const iso = (ago: number) => new Date(Date.now() - ago).toISOString()
const finished = (id: string, taskType: string, description: string) => ({
  taskId: id, toolUseId: `call-${id}`, taskType, status: 'completed', isBackgrounded: true, description,
  startedAt: Date.now() - 60_000, endedAt: Date.now() - 20_000,
})
const running = (id: string, description: string) => ({
  taskId: id, toolUseId: `call-${id}`, taskType: 'local_bash', status: 'running', isBackgrounded: true, description,
  startedAt: Date.now() - 60_000,
})

async function open(page: Page, sid: string, tasks: object[], processStatus = 'idle') {
  await isolateUiPrefs(page)
  await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* off */ } })
  await page.route(`**/api/sessions/${sid}`, (route: Route) => route.fulfill({ json: {
    session: { claudeSessionId: sid, taskId: TASK_ID, project: 'Walnut', process_status: processStatus, mode: 'default', startedAt: iso(600_000), lastActiveAt: iso(5_000), messageCount: 2, title: 'Background phone fixture' },
    pendingPermissions: [],
  } }))
  const messages = [{ role: 'user', text: 'Run the checks', timestamp: iso(60_000), msgId: 'u-1' }, { role: 'assistant', text: 'All checks passed.', timestamp: iso(50_000), msgId: 'a-1' }]
  await page.route(`**/api/sessions/${sid}/history**`, (route: Route) => route.fulfill({ json: { messages, cursor: 2, delta: false } }))
  await page.route(`**/api/sessions/${sid}/workflow`, (route: Route) => route.fulfill({ json: { sessionId: sid, inFlight: 0, tasks, agents: [], phases: [] } }))
  await page.goto(`/?s1=${sid}`)
  const panel = page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 60_000 })
  await expect(panel).toContainText('All checks passed.', { timeout: 20_000 })
  return panel
}

test('after every task finished, the phone menu opens the Background tasks list', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const panel = await open(page, SID_BG, [
    finished('audit', 'local_agent', 'Audit the route deadlines'),
    finished('tests', 'local_bash', 'npm run test:quick'),
  ])
  await expect(panel.locator('[data-testid="session-background-note"]')).toHaveCount(0)
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  const row = page.getByTestId('phone-row-background')
  await expect(row).toHaveText('Background tasks', { timeout: 15_000 })
  const menu = page.locator('.task-kebab-menu:visible')
  await menu.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)))
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-phone-menu-row.png`, scale: 'css' })
  await row.click()
  const tasksPanel = page.locator('.wf-modal--tasks')
  await expect(tasksPanel).toHaveCount(1)
  await expect(tasksPanel.locator('.wf-modal-meta').first()).toHaveText('1 agent · 1 command')
  await expect(page.getByTestId('phone-row-background')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a session that never had background work has no phone menu row', async ({ page }) => {
  await open(page, SID_NONE, [])
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByTestId('phone-row-files')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('phone-row-background')).toHaveCount(0)
})

test('while a command runs after the turn, the phone row counts it', async ({ page }) => {
  // A detached command keeps the session running after its turn.
  const panel = await open(page, SID_RUN, [running('serve', 'npm run dev'), finished('tests', 'local_bash', 'npm test')], 'running')
  await expect(panel.locator('[data-testid="session-background-note"]')).toContainText('1 command still running in the background')
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByTestId('phone-row-background')).toHaveText('Background tasks (1 running)', { timeout: 15_000 })
})
