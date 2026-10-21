/**
 * Transfer a task to another engine or host, from the session panel's ⋮ menu.
 *
 * The dialog's choices come from GET /api/v1/tasks/:id/transfer-options. A real
 * transfer needs real engines and hosts, so the POST is answered here and the
 * spec asserts the BODY the UI sent; the options are canned too, so the blocked
 * pair (an ACP engine on a remote host) is always there. One test reads the real
 * options route to prove the dialog renders the server's own answer.
 *
 * Covered: the blocked pair is disabled with its reason; "nothing would change"
 * disables Transfer with a hint; another host + instruction + keep-source sends
 * the right body, the dialog closes, the toast names the new task and its session
 * opens in the Home columns with a "Moved from" line; a 409 shows the server's
 * words inline and keeps every choice. Run under WebKit too:
 *   PW_WEBKIT=1 npx playwright test tests/e2e/browser/session-transfer.spec.ts --project webkit
 */
import { mkdirSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const TASK_TITLE = 'Editor fixture task'
// The "new" task the canned success points at: a seeded task with its own session.
const NEW_TASK_ID = 'pw-task-tags'
const NEW_TASK_TITLE = 'Tagged ticket run fixture task'
const NEW_SESSION_ID = 'pw-tags-session'
const SHOTS = '/tmp/session-transfer'
const BLOCKED = 'Codex runs on this machine only for now'

const OPTIONS = {
  taskId: TASK_ID,
  source: { sessionId: SESSION_ID, engine: 'claude', host: '__local__', cwd: '/work/editor-fixture' },
  engines: [{ id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex' }],
  hosts: [
    { alias: '__local__', kind: 'laptop', probedAt: null },
    { alias: 'devbox', kind: 'dev-box', probedAt: null },
  ],
  options: [
    { engine: 'claude', host: '__local__' },
    { engine: 'claude', host: 'devbox' },
    { engine: 'codex', host: '__local__' },
    { engine: 'codex', host: 'devbox', blockedReason: BLOCKED },
  ],
}

test.describe.configure({ timeout: 120_000 })
mkdirSync(SHOTS, { recursive: true })

const panelOf = (page: Page, sid: string) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)

async function cannedOptions(page: Page) {
  await page.route(`**/api/v1/tasks/${TASK_ID}/transfer-options`, (route) => route.fulfill({ json: OPTIONS }))
}

/** Boot, find the fixture task, open its session column by clicking the row's title. */
async function openSourcePanel(page: Page) {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = panelOf(page, SESSION_ID)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

async function openTransferFromPanel(page: Page) {
  const panel = await openSourcePanel(page)
  await panel.locator('.session-panel-title-meta .task-kebab-btn').click()
  const item = page.locator('.task-kebab-menu:visible [data-testid="task-kebab-transfer"]')
  await expect(item).toHaveText(/Transfer…/)
  await item.click()
  const dialog = page.getByTestId('transfer-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('transfer from the session menu: blocked pair, nothing-changes guard, submit and open the new task', async ({ page }) => {
  await cannedOptions(page)
  // The new task carries its link back, the way the server writes it.
  await page.route((url) => url.pathname === '/api/tasks', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { tasks?: { id: string; transferred_from?: string }[] }
    for (const t of body.tasks ?? []) if (t.id === NEW_TASK_ID) t.transferred_from = TASK_ID
    await route.fulfill({ response: res, json: body })
  })
  let sent: Record<string, unknown> | null = null
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  // The server runs a transfer as a job: POST answers 202 at once, the client
  // reads it back with short GETs until the job is done.
  let polls = 0
  await page.route(`**/api/v1/tasks/${TASK_ID}/transfer`, async (route: Route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: { transferId: 'xf-test000000', state: 'running', sourceTaskId: TASK_ID } })
  })
  await page.route('**/api/v1/transfers/xf-test000000', async (route: Route) => {
    polls++
    if (polls < 2) { await route.fulfill({ status: 202, json: { transferId: 'xf-test000000', state: 'running' } }); return }
    await held
    await route.fulfill({
      json: {
        transferId: 'xf-test000000', state: 'done',
        taskId: NEW_TASK_ID, title: NEW_TASK_TITLE, sessionId: NEW_SESSION_ID, sourceTaskId: TASK_ID,
        sourceCompleted: false, history: 'native-copy', target: { engine: 'claude', host: 'devbox', cwd: '/home/dev/editor-fixture' },
      },
    })
  })

  const dialog = await openTransferFromPanel(page)
  await expect(dialog).toContainText('Now: Claude Code on This Mac')
  // Pre-selected: the current engine and host.
  await expect(dialog.getByTestId('xfer-engine-claude')).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('xfer-host-__local__')).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('xfer-host-devbox')).toContainText('Dev box')
  await expect(dialog.getByTestId('xfer-host-__local__')).toContainText('Laptop')

  // Nothing would change: same engine, host and directory.
  const submit = dialog.getByTestId('xfer-submit')
  await expect(submit).toBeDisabled()
  await expect(dialog.getByTestId('xfer-hint')).toHaveText(/Nothing would change/)
  await expect(dialog.getByTestId('xfer-dir-same')).toHaveAttribute('aria-checked', 'true')
  await dialog.screenshot({ path: `${SHOTS}/1-nothing-changes.png` })

  // Another host: Codex cannot go there, and says why; the directory follows the host.
  await dialog.getByTestId('xfer-host-devbox').click()
  const codex = dialog.getByTestId('xfer-engine-codex')
  await expect(codex).toBeDisabled()
  await expect(codex).toContainText(BLOCKED)
  await expect(dialog.getByTestId('xfer-dir-auto')).toHaveAttribute('aria-checked', 'true')
  await expect(submit).toBeEnabled()
  await expect(dialog.getByTestId('xfer-hint')).toHaveCount(0)

  await dialog.getByTestId('xfer-keep-source').check()
  await dialog.getByTestId('xfer-message').fill('Run the tests first')
  await dialog.screenshot({ path: `${SHOTS}/2-ready.png` })
  await submit.click()
  await expect(submit).toHaveText('Transferring…')
  await expect(submit).toBeDisabled()
  // The page stays usable while it runs: the dialog hides and the request goes on.
  await dialog.getByRole('button', { name: 'Hide' }).click()
  await expect(dialog).toBeHidden()
  release()

  await expect.poll(() => sent).not.toBeNull()
  expect(sent).toEqual({ engine: 'claude', host: 'devbox', cwd: 'auto', mode: 'carry', keep_source: true, message: 'Run the tests first', wait_ms: 8000 })

  await expect(page.locator('.notification-toast--success', { hasText: `Moved to ${NEW_TASK_TITLE}` })).toBeVisible({ timeout: 20_000 })
  expect(polls).toBeGreaterThanOrEqual(2)
  const newPanel = panelOf(page, NEW_SESSION_ID)
  await expect(newPanel).toBeVisible({ timeout: 30_000 })
  const links = newPanel.getByTestId('session-transfer-links')
  await expect(links).toContainText('Moved from')
  await expect(links.locator('a.task-link')).toHaveText(TASK_TITLE)
  await page.screenshot({ path: `${SHOTS}/3-opened.png` })
})

test('a refused transfer shows the server error inline and keeps the choices', async ({ page }) => {
  await cannedOptions(page)
  const err = 'The workspace could not be packed: disk full on this Mac'
  await page.route(`**/api/v1/tasks/${TASK_ID}/transfer`, (route) => route.fulfill({
    status: 409, json: { error: err, code: 'engine_host_unsupported' },
  }))
  const dialog = await openTransferFromPanel(page)
  await dialog.getByTestId('xfer-engine-codex').click()
  await dialog.getByTestId('xfer-mode-brief').click()
  await dialog.getByTestId('xfer-submit').click()
  await expect(dialog.getByTestId('xfer-error')).toHaveText(err)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('xfer-engine-codex')).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('xfer-mode-brief')).toHaveAttribute('aria-checked', 'true')
  await expect(dialog.getByTestId('xfer-submit')).toBeEnabled()
  await dialog.screenshot({ path: `${SHOTS}/4-error.png` })
  // Changing a choice clears the stale error.
  await dialog.getByTestId('xfer-mode-carry').click()
  await expect(dialog.getByTestId('xfer-error')).toHaveCount(0)
})

test('the task kebab has Transfer for a task with a session, and the dialog reads the real options', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const row = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.hover()
  await row.locator('.task-kebab-btn').click()
  await page.locator('.task-kebab-menu:visible [data-testid="task-kebab-transfer"]').click()
  const dialog = page.getByTestId('transfer-dialog')
  await expect(dialog).toBeVisible()
  // The real route: Claude Code on This Mac is the source and both are listed.
  await expect(dialog.getByTestId('xfer-engine-claude')).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
  await expect(dialog.getByTestId('xfer-host-__local__')).toContainText('This Mac')
  await expect(dialog.getByTestId('xfer-submit')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('Settings > Remote Hosts: "What Walnut knows" shows the profile and edits kind, note and probe', async ({ page }) => {
  const HOST = 'fixture-remote'
  const profile = {
    host: HOST, kind: 'private-cloud-vm', kindReasons: ['cloud metadata answered', 'no public address'], kindSetByUser: false,
    probed: {
      os: { prettyName: 'Ubuntu 24.04 LTS' }, arch: 'arm64', cpus: 8, memBytes: 32 * 1024 ** 3, diskFreeBytes: 120 * 1024 ** 3,
      tools: { git: '2.43.0', node: '22.3.0', docker: null }, probedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    observed: { repoPaths: { walnut: { path: '/home/dev/walnut', at: new Date().toISOString() } }, reaches: {} },
    notes: [
      { key: 'old', fact: 'Older note about the proxy', at: '2026-10-01T00:00:00.000Z' },
      { key: 'new', fact: 'Newest note: builds need the cache dir', at: '2026-10-20T00:00:00.000Z' },
    ],
    updatedAt: new Date().toISOString(),
  }
  const patches: unknown[] = []
  await page.route(`**/api/v1/hosts/${HOST}/profile`, async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { profile, summary: 'x' } })
    const body = route.request().postDataJSON() as { kind?: string | null; user_note?: string }
    patches.push(body)
    const next = { ...profile, ...(body.kind !== undefined ? { kind: body.kind ?? 'private-cloud-vm', kindSetByUser: body.kind !== null } : {}), ...(body.user_note !== undefined ? { userNote: body.user_note } : {}) }
    return route.fulfill({ json: { profile: next } })
  })
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.getByTestId('sidebar-core-app-settings').click()
  await page.getByTestId('settings-nav-remote-hosts').click()
  const toggle = page.getByTestId(`host-profile-toggle-${HOST}`)
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const box = page.getByTestId(`host-profile-${HOST}`)
  await expect(box).toContainText('Cloud VM (private) (automatic)')
  await expect(box).toContainText('cloud metadata answered; no public address')
  await expect(box.getByTestId('host-profile-system')).toHaveText('Ubuntu 24.04 LTS · arm64 · 8 CPUs · 32 GB memory · 120 GB free')
  await expect(box).toContainText('git 2.43.0, node 22.3.0')
  await expect(box).toContainText('Not found: docker')
  await expect(box).toContainText('/home/dev/walnut')
  const noteTexts = await box.locator('p', { hasText: /note/ }).allInnerTexts()
  expect(noteTexts[0]).toContain('Newest note')
  // The content box is `display: contents` (a run of rows in the group): shoot the group.
  await page.locator('.settings-group', { has: toggle }).first().screenshot({ path: `${SHOTS}/5-host-profile.png` })

  await box.getByRole('button', { name: 'Probe again' }).click()
  await expect.poll(() => patches.length).toBe(1)
  expect(patches[0]).toEqual({ refresh: true })

  await box.getByRole('button', { name: `Kind of Big remote host` }).click()
  await page.locator('.task-kebab-project-flyout [data-option="dev-box"]').click()
  await expect.poll(() => patches.length).toBe(2)
  expect(patches[1]).toEqual({ kind: 'dev-box' })
  await expect(box).toContainText('Dev box')
  await box.getByRole('button', { name: `Kind of Big remote host` }).click()
  await page.locator('.task-kebab-project-flyout [data-option="auto"]').click()
  await expect.poll(() => patches.length).toBe(3)
  expect(patches[2]).toEqual({ kind: null })

  await box.locator(`#host-note-${HOST}`).fill('Use the build cache in /data')
  await box.locator(`#host-note-${HOST}`).press('Enter')
  await expect.poll(() => patches.length).toBe(4)
  expect(patches[3]).toEqual({ user_note: 'Use the build cache in /data' })
})
