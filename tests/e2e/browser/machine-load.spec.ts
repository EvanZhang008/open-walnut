/**
 * What each session costs its machine, as the user sees it: the Machine load
 * card in the notification panel's System section (every connected host, its
 * sessions by memory, Stop), the Memory and CPU rows at the foot of a session
 * column's ⋮ menu, and the heavy pill, which a small session never wears.
 *
 * Real path end to end: the fixture's mock daemon runs the real sampler over
 * the real `ps` with the mock CLI as the session's root process, so the
 * numbers on screen are the mock CLI's own RSS. Nothing is routed.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openBell } from './host-problems-fixture-helpers'
import { railButton } from './banner-placement-helpers'
import { discoverBrowserFixture } from './codex-test-audit'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}`
const SHOTS = '/tmp/machine-load/shots'

test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

/** The fixture's seeded project folder: a real directory the mock CLI runs in. */
let cwd = ''
test.beforeAll(async () => {
  ;({ fixtureRoot: cwd } = await discoverBrowserFixture(TEST_PORT))
  cwd = `${cwd}/projects/walnut`
})

const litter: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of litter.splice(0)) await request.delete(`/api/tasks/${id}`).catch(() => undefined)
})

const shot = (name: string) => `${SHOTS}/${test.info().project.name}-${name}.png`

interface Launched { taskId: string; sessionId: string }

/**
 * A real mock-CLI session (quick-start), linked to its task. The mock CLI's
 * plain turn exits at its end; `snapshot-clean-turn:` answers and then stays
 * alive between turns the way the real CLI does, which is the process the
 * sampler measures.
 */
async function launch(page: Page, label: string): Promise<Launched> {
  const res = await page.request.post('/api/sessions/quick-start', {
    data: { cwd, message: `snapshot-clean-turn:machine load ${label} ${STAMP}`, project: 'Machine load spec' },
  })
  expect(res.status(), await res.text()).toBe(200)
  const launched = await res.json() as Launched
  litter.push(launched.taskId)
  // The CLI is up once the session record has its pid (the sampler only lists live roots).
  await expect.poll(async () => {
    const s = await page.request.get(`/api/sessions/${launched.sessionId}`)
    if (!s.ok()) return null
    return ((await s.json()) as { session?: { pid?: number } }).session?.pid ?? null
  }, { timeout: 60_000 }).toBeTruthy()
  return launched
}

async function openColumn(page: Page, sid: string): Promise<Locator> {
  await page.addInitScript((id) => {
    try { sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }])) } catch { /* ignore */ }
  }, sid)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

/** Home with no session column open: nothing on the page holds the session's state but the card. */
async function openHomeWithoutColumns(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([])) } catch { /* ignore */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

/** Open the bell, then System; returns the Machine load card. */
async function openMachineLoad(page: Page): Promise<Locator> {
  await openBell(page)
  const system = railButton(page, 'System')
  if (await system.getAttribute('aria-current') !== 'true') await system.click()
  await expect(system).toHaveAttribute('aria-current', 'true')
  const card = page.locator('.notification-panel [data-testid="nfc-machine-load"]')
  await expect(card).toBeVisible({ timeout: 20_000 })
  return card
}

const MEM = /^\d+ MB$|^\d+(\.\d)? GB$/
const CPU = /^\d+%$/

test('the System section lists this machine with the live session, its memory, then its CPU on the second sample', async ({ page }) => {
  const a = await launch(page, 'A')
  const panel = await openColumn(page, a.sessionId)
  const card = await openMachineLoad(page)

  const local = card.locator('[data-testid="machine-host"][data-host="__local__"]')
  await expect(local).toBeVisible({ timeout: 20_000 })
  await expect(local.locator('.machine-host-label')).toHaveText('Local')
  await expect(local.getByTestId('machine-host-totals')).toHaveText(/^\d+ sessions? · (\d+ MB|\d+(\.\d)? GB)/, { timeout: 20_000 })

  // The local host is open by default; the session is a row with the mock CLI's own RSS.
  const row = local.locator(`[data-testid="machine-session"][data-sid="${a.sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row.getByTestId('machine-session-mem')).toHaveText(MEM)
  const mb = Number((await row.getByTestId('machine-session-mem').textContent())!.replace(/ MB| GB/, ''))
  expect(mb).toBeGreaterThan(0)
  await expect(row.locator('.machine-session-name')).toContainText('machine load A')
  // CPU needs two samples; the open card asks every 5s.
  await expect(row.locator('.machine-session-cpu')).toHaveText(CPU, { timeout: 30_000 })
  await expect(row.locator('.machine-spark')).toBeVisible()
  await page.screenshot({ path: shot('system-card'), clip: { x: 0, y: 0, width: 1280, height: 720 } })

  // A small session wears no heavy pill on its column.
  await expect(panel.getByTestId('session-resource-pill')).toHaveCount(0)
})

test('the ⋮ menu ends with Memory and CPU rows for a live session, and nothing extra for one with no process', async ({ page }) => {
  const a = await launch(page, 'B')
  const panel = await openColumn(page, a.sessionId)
  await panel.locator('.session-panel-header .task-kebab-btn').click()
  const meta = page.locator('.task-kebab-menu').getByTestId('session-kebab-meta')
  await expect(meta).toBeVisible()
  // Opening the menu asks for a fresh reading, so the rows land within seconds of the first open.
  await expect(meta.locator('.task-kebab-meta-label')).toHaveText(['Created', 'Updated', 'Host', 'Memory', 'CPU'], { timeout: 20_000 })
  await expect(meta.locator('[data-meta="memory"] .task-kebab-meta-value')).toHaveText(/^(\d+ MB|\d+(\.\d)? GB) · \d+ process(es)?$/)
  await expect(meta.locator('[data-meta="cpu"] .task-kebab-meta-value')).toHaveText(/^(—|\d+%)$/)
  await page.screenshot({ path: shot('kebab-rows'), clip: { x: 0, y: 0, width: 1280, height: 720 } })
  await page.keyboard.press('Escape')

  // The fixture's seeded session has a fake pid: no process, no rows.
  await page.addInitScript(() => {
    try { sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-normal-session', locked: false }])) } catch { /* ignore */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const seeded = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  await expect(seeded).toBeVisible({ timeout: 30_000 })
  await seeded.locator('.session-panel-header .task-kebab-btn').click()
  const meta2 = page.locator('.task-kebab-menu').getByTestId('session-kebab-meta')
  await expect(meta2).toBeVisible()
  await expect(meta2.locator('.task-kebab-meta-label')).toHaveText(['Created', 'Updated', 'Host'])
})

test('Stop from the Machine load card ends the CLI through the session route, and the row leaves the list', async ({ page }) => {
  const a = await launch(page, 'C')
  // The column stays closed: the card alone must carry the host's answer to the row.
  await openHomeWithoutColumns(page)
  await expect(page.locator(`.session-panel[data-session-id="${a.sessionId}"]`)).toHaveCount(0)
  const card = await openMachineLoad(page)
  const row = card.locator(`[data-testid="machine-session"][data-sid="${a.sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })

  const terminate = page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/api/sessions/${a.sessionId}/terminate`), { timeout: 20_000 })
  // The dialog names the session the row shows (its side title may not have landed yet).
  const shown = (await row.locator('.machine-session-name').textContent())!.trim()
  await row.locator('.machine-session-stop').click()
  const dialog = page.getByRole('dialog', { name: /^Stop / })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(`Stop “${shown}”?`)
  await expect(row.locator('.machine-session-stop')).toHaveText('Stop')
  await dialog.getByRole('button', { name: 'Stop session' }).click()
  const answer = await (await terminate).response()
  const status = ((await answer!.json()) as { status: 'terminated' | 'pending' }).status

  // The row says what the server did. A confirmed stop: the CLI is gone and the
  // next samples drop it. A pending one (the host has not confirmed, e.g. its
  // daemon has no spawn record): the row says so with the host's reason, and the
  // CLI is still there.
  const read = async () => ((await (await page.request.get(`/api/sessions/${a.sessionId}`)).json()) as {
    session?: { process_status?: string; stopRequest?: { state?: string; error?: string } }
  }).session
  if (status === 'terminated') {
    await expect.poll(async () => (await read())?.process_status ?? null, { timeout: 60_000 }).toMatch(/stopped|error/)
    await expect(row).toHaveCount(0, { timeout: 30_000 })
  } else {
    const outcome = row.getByTestId('machine-session-stop-outcome')
    await expect(outcome).toHaveText('Pending', { timeout: 10_000 })
    const rec = await read()
    expect(rec?.stopRequest?.state).toBe('pending')
    if (rec?.stopRequest?.error) await expect(outcome).toHaveAttribute('title', new RegExp(rec.stopRequest.error.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await expect(row).toBeVisible()
    await page.screenshot({ path: shot('stop-pending'), clip: { x: 0, y: 0, width: 1280, height: 720 } })
  }
  test.info().annotations.push({ type: 'stop-outcome', description: status })
})

test('a cancelled Stop keeps the session running', async ({ page }) => {
  const a = await launch(page, 'D')
  await openColumn(page, a.sessionId)
  const card = await openMachineLoad(page)
  const row = card.locator(`[data-testid="machine-session"][data-sid="${a.sessionId}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  let terminates = 0
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/terminate')) terminates++ })
  await row.locator('.machine-session-stop').click()
  const dialog = page.getByRole('dialog', { name: /^Stop / })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep running' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()
  const s = await page.request.get(`/api/sessions/${a.sessionId}`)
  expect(((await s.json()) as { session?: { process_status?: string } }).session?.process_status).not.toMatch(/stopped|error/)
  expect(terminates).toBe(0)
})
