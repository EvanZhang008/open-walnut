/**
 * A routine whose clock a host's daemon holds (clock-routine-v1, docs/plan/walnut-trigger.md
 * "Clock routines") says where, the way a trigger names its check's host:
 *
 *   - its Routines card carries a "clock @ <host>" line; a routine on this server's
 *     timer carries none. A Claude Code routine's run that came due there says it
 *     waits for this Mac to start it;
 *   - it shows on its task's TRIGGER pill with the same label, "Run now" in place of
 *     "Run check now", and no "last check" line (a clock has no check). The task's
 *     routine on this server's timer is on the pill too, with no host label;
 *   - Pause keeps it on its task (the clock stays with its host, armed nowhere), with
 *     what Resume will do; Resume gives it a next run again;
 *   - Run now's run is a row in the same History.
 *
 * The handover itself runs in tests/e2e/clock-routine-cluster-e2e.test.ts; here the
 * fixture's cron state names the fixture's configured (disabled) remote host as the
 * clock's holder, so nothing ever dials it.
 *
 * Run in WebKit too (PW_WEBKIT=1 … --project webkit): the Mac app is a WKWebView.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${PORT}`
const SHOTS = '/tmp/g9-cron'
/** The fixture config's remote host (test-server.ts): known, so no placement takes the clock back. */
const HOST = 'fixture-remote'

test.describe.configure({ timeout: 180_000 })

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, animations: 'disabled', scale: 'css' })
}

function taskRow(page: Page, title: string): Locator {
  return page.locator('.todo-panel-item, .todo-pinned-card, .todo-focus-card').filter({ hasText: title })
}

async function createTask(title: string): Promise<{ id: string; title: string }> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, source: 'local', project: 'Work' }),
  })
  const body = await res.text()
  expect(res.ok, body).toBe(true)
  return (JSON.parse(body) as { task: { id: string; title: string } }).task
}

async function createRoutine(name: string, executor: { type: string; config: Record<string, unknown> }): Promise<string> {
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, executor }),
  })
  const body = await res.text()
  expect(res.status, body).toBe(201)
  return (JSON.parse(body) as { job: { id: string } }).job.id
}

async function getRoutine(id: string): Promise<any | null> {
  const res = await fetch(`${API}/api/routines/${id}`)
  return res.ok ? ((await res.json()) as { job: any }).job : null
}

const createSessionRoutine = (name: string, taskId: string) =>
  createRoutine(name, { type: 'session', config: { target: taskId, prompt: 'Post the morning digest.' } })

/** Hand the routine's clock to HOST in the fixture's cron state, as a settled handover leaves it. */
async function handClockToHost(id: string, dueAtMs?: number): Promise<void> {
  const { walnutHome } = await discoverBrowserFixture(PORT)
  if (PORT === 3456 || !/^walnut-pw-\d+$/.test(path.basename(walnutHome))) throw new Error(`not an isolated fixture: ${walnutHome}`)
  const file = path.join(walnutHome, 'cron-state.json')
  // The server rewrites the file under its lock; a write it raced is simply done again.
  await expect.poll(async () => {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as { version: number; states: Record<string, any> }
    const st = raw.states[id] ?? {}
    if (st.clockHost !== HOST) {
      const next = dueAtMs ?? (typeof st.nextRunAtMs === 'number' ? st.nextRunAtMs : Date.now() + 3_600_000)
      raw.states[id] = { ...st, clockHost: HOST, clockFromMs: next, nextRunAtMs: next }
      await fs.writeFile(`${file}.pw-tmp`, JSON.stringify(raw, null, 2))
      await fs.rename(`${file}.pw-tmp`, file)
    }
    return (await getRoutine(id))?.state?.clockHost
  }, { timeout: 20_000 }).toBe(HOST)
}

async function cleanup(ids: string[], taskId: string): Promise<void> {
  for (const id of ids) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
  await fetch(`${API}/api/tasks/${taskId}`, { method: 'DELETE' }).catch(() => {})
}

test('a routine whose clock is on a host names it on its card and on its task', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView, showEverything } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW clock host task')
  const stamp = Date.now()
  const onHost = `PW clock on host ${stamp}`
  const onServer = `PW clock on server ${stamp}`
  const onHostCli = `PW clock Claude Code ${stamp}`
  const hostId = await createSessionRoutine(onHost, task.id)
  const serverId = await createSessionRoutine(onServer, task.id)
  const cliId = await createRoutine(onHostCli, { type: 'claude-code', config: { host: HOST, cwd: '/tmp', instructions: 'Sweep the build logs.' } })
  try {
    await handClockToHost(hostId)
    // Its 09:00 came due ten minutes ago while this Mac was away: the host holds that run.
    await handClockToHost(cliId, Date.now() - 10 * 60_000)
    expect((await getRoutine(serverId))?.state?.clockHost).toBeUndefined()

    // The Routines page: the host-held one says where its clock runs, the other says nothing.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const link = page.getByTestId('sidebar-core-app-routines')
    await expect(link).toBeVisible({ timeout: 90_000 })
    await link.click()
    await expect(page.locator('.page-title')).toContainText('Routines')
    const hostCard = page.locator('.routine-list .routine-card', { hasText: onHost }).first()
    const serverCard = page.locator('.routine-list .routine-card', { hasText: onServer }).first()
    await expect(hostCard).toBeVisible({ timeout: 20_000 })
    await expect(serverCard).toBeVisible()
    const line = hostCard.getByTestId('routine-clock-host')
    await expect(line).toHaveText(`clock @ ${HOST}`)
    await expect(line).toHaveAttribute('title', `Its clock runs on ${HOST}, where its work runs, so it fires while this Mac sleeps.`)
    await expect(serverCard.getByTestId('routine-clock-host')).toHaveCount(0)
    await expect(hostCard.getByTestId('routine-clock-wait')).toHaveCount(0)
    await hostCard.scrollIntoViewIfNeeded()
    await shot(hostCard, 'routine-card-clock-host')
    // A Claude Code run the host holds waits for this Mac, and the card says so.
    const cliCard = page.locator('.routine-list .routine-card', { hasText: onHostCli }).first()
    const cliLine = cliCard.getByTestId('routine-clock-host')
    await expect(cliLine.locator('code')).toHaveText(`clock @ ${HOST}`)
    await expect(cliCard.getByTestId('routine-clock-wait')).toHaveText(new RegExp(`^Due 1\\dm ago: waiting on ${HOST} for this Mac to start it$`))
    // Its slot is past: the timing line names no next run beside it.
    await expect(cliCard.locator('.cron-job-desc')).toHaveText(/^Every day at 9:00\sAM( UTC)?$/)
    await expect(cliLine).toHaveAttribute('title', `Its clock runs on ${HOST}, where its work runs. A run that comes due while this Mac sleeps waits there, and this Mac starts it when it is back.`)
    await cliCard.scrollIntoViewIfNeeded()
    await shot(cliCard, 'routine-card-clock-waiting')

    // The task: one TRIGGER pill, listing both of its clock routines, the host named on the one it holds.
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
    await showEverything(page)
    const row = taskRow(page, task.title)
    const pill = row.getByTestId('task-trigger-pill')
    await expect(pill).toHaveText('TRIGGER', { timeout: 20_000 })
    await expect(pill).toHaveAttribute('data-trigger-count', '2')
    await expect(pill).toHaveAttribute('title', new RegExp(`clock @ ${HOST}`))
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    await expect(flyout).toBeVisible()
    const trow = flyout.locator(`.trigger-jobs-row[data-routine-id="${hostId}"]`)
    await expect(trow.getByTestId('trigger-jobs-clock')).toHaveText(`clock @ ${HOST}`)
    const srow = flyout.locator(`.trigger-jobs-row[data-routine-id="${serverId}"]`)
    await expect(srow).toBeVisible()
    await expect(srow.getByTestId('trigger-jobs-clock')).toHaveCount(0)
    await expect(srow.locator('.trigger-jobs-tally')).toContainText(/next run/i)
    await expect(trow.locator('.trigger-jobs-last')).toHaveCount(0)
    await expect(trow.locator('.trigger-jobs-tally')).toContainText(/next run/i)
    await expect(trow.getByRole('button', { name: 'Run now' })).toBeVisible()
    await expect(trow.getByRole('button', { name: 'Run check now' })).toHaveCount(0)
    await expect(flyout.locator('.trigger-jobs-foot')).toHaveText("Each run is delivered into this task's session, from this Mac or from the host whose daemon holds its clock.")
    await expect(trow.getByText('What it injects when it runs')).toBeVisible()
    await expect(trow.getByText('No runs recorded yet')).toBeVisible()
    await shot(flyout, 'task-trigger-flyout-clock')

    // Pause: it stays on its task, with its host, and says what Resume does.
    await trow.getByRole('button', { name: 'Pause' }).click()
    await expect(trow).toHaveAttribute('data-state', 'paused')
    await expect(trow.getByTestId('trigger-jobs-off')).toContainText(/: not running\. On Resume, it runs again from its next slot\.$/)
    await expect(trow.getByTestId('trigger-jobs-clock')).toHaveText(`clock @ ${HOST}`)
    // The pill reads paused only when every routine on it is: the server's one still runs.
    await expect(pill).not.toHaveAttribute('data-paused', 'true')
    await expect.poll(async () => (await getRoutine(hostId))?.enabled).toBe(false)
    expect((await getRoutine(hostId))?.state?.clockHost).toBe(HOST)
    await shot(flyout, 'task-trigger-flyout-clock-paused')

    // Resume: armed again, with its next slot from now, still on its host.
    await trow.getByRole('button', { name: 'Resume' }).click()
    await expect(trow).not.toHaveAttribute('data-state', 'paused')
    await expect(trow.locator('.trigger-jobs-tally')).toContainText(/next run/i)
    const resumed = await getRoutine(hostId)
    expect(resumed.enabled).toBe(true)
    expect(resumed.state.clockHost).toBe(HOST)
    expect(resumed.state.nextRunAtMs).toBeGreaterThan(Date.now())
    expect(resumed.state.clockFromMs).toBe(resumed.state.nextRunAtMs)

    // Run now on the server's one: its run is a row in the same History, marked as Run now.
    await expect(srow.getByText('No runs recorded yet')).toBeVisible()
    await srow.getByRole('button', { name: 'Run now' }).click()
    const toggle = srow.getByTestId('trigger-audit-toggle')
    await expect(toggle).toHaveText(/^History \(1 recorded run\)/, { timeout: 60_000 })
    await toggle.click()
    const runRow = srow.getByTestId('trigger-audit-list').locator('.trigger-audit-row')
    await expect(runRow).toHaveCount(1)
    await expect(runRow.locator('.trigger-audit-what')).toHaveText(/^run now → /)
    await shot(flyout, 'task-trigger-flyout-run-now')
  } finally {
    await cleanup([hostId, serverId, cliId], task.id)
  }
})
