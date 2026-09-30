/**
 * Pause and Resume a walnut-trigger from its task, against the fixture's REAL
 * local daemon (it runs the check on a 10s cadence and reports every check):
 *
 *   - a paused trigger stays on its task through a reload, marked Paused, with
 *     no next run and Resume in place of Pause / Run check now;
 *   - while paused the daemon stops checking (lastCheck stops moving);
 *   - Resume re-arms it: a next run is scheduled and checks come back;
 *   - what appeared while paused arrives ONCE, as one fire, and nothing replays;
 *   - a trigger the server stopped after failing checks reads Stopped, on the
 *     task and on the Routines card.
 *
 * Needs a daemon advertising `triggers-v1` (bash scripts/build-daemon.sh).
 * Run in WebKit too (PW_WEBKIT=1 … --project webkit): the Mac app is a WKWebView.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/trigger-pause'

// Real cadences: a 5s first-run delay, a 10s floor, and windows that prove a
// paused trigger stays quiet. A cold fixture can take a minute to draw.
test.describe.configure({ timeout: 240_000 })

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, animations: 'disabled' })
}

function taskRow(page: Page, title: string): Locator {
  return page.locator('.todo-panel-item, .todo-pinned-card, .todo-focus-card').filter({ hasText: title })
}

async function createTask(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', project: 'Work' }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { task: { id: string; title: string } }).task
}

async function createTrigger(taskId: string, name: string, run: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/v1/routines/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, run, every: '10s', prompt: 'Read the new items.', session: taskId,
      description: 'Pause test trigger.',
    }),
  })
  if (res.status !== 201) throw new Error(`trigger create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { job: { id: string } }).job
}

async function getRoutine(id: string): Promise<any | null> {
  const res = await fetch(`${API}/api/routines/${id}`)
  return res.ok ? ((await res.json()) as { job: any }).job : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  const { showEverything } = await import('./todo-panel-helpers')
  await showEverything(page)
}

async function cleanup(routineIds: string[], taskId: string, dir?: string): Promise<void> {
  for (const id of routineIds) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
  await fetch(`${API}/api/tasks/${taskId}`, { method: 'DELETE' }).catch(() => {})
  if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

test('a paused trigger stays on its task through a reload, stops checking, and Resume re-arms it', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW pause task')
  const name = `PW pause ${Date.now()}`
  const created = await createTrigger(task.id, name, `echo '{"fire": false}'`)
  try {
    // Its first check proves the daemon is polling it.
    await expect.poll(async () => (await getRoutine(created.id))?.state?.lastCheck?.atMs ?? 0, { timeout: 45_000 })
      .toBeGreaterThan(0)
    await openHome(page)
    const row = taskRow(page, task.title)
    const pill = row.getByTestId('task-trigger-pill')
    await expect(pill).toHaveText('TRIGGER', { timeout: 15_000 })
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    const trow = flyout.locator(`.trigger-jobs-row[data-routine-id="${created.id}"]`)
    await expect(trow.locator('.trigger-jobs-tally')).toContainText(/next run/i)

    // Pause: the ONLY trigger on the task stays, muted, with Resume.
    await trow.getByRole('button', { name: 'Pause' }).click()
    await expect(trow).toHaveAttribute('data-state', 'paused')
    await expect(pill).toHaveText('TRIGGER · PAUSED')
    await expect(pill).toHaveAttribute('data-paused', 'true')
    await expect(trow.getByTestId('trigger-jobs-state')).toHaveText('Paused')
    await expect(trow.getByTestId('trigger-jobs-off')).toContainText(/^Paused (just now|\dm ago): not checking\. On Resume, anything that appeared meanwhile arrives once, as one fire\.$/)
    await expect(trow.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(trow.getByRole('button', { name: 'Pause' })).toHaveCount(0)
    await expect(trow.getByRole('button', { name: 'Run check now' })).toHaveCount(0)
    await expect(trow.getByRole('button', { name: 'Delete' })).toBeVisible()
    await expect(trow.locator('.trigger-jobs-tally')).not.toContainText(/next run/i)
    // The pill's colour is not the armed accent: it reads as off at a glance.
    const [pausedColor, pausedBorder] = await pill.evaluate((el) => {
      const cs = getComputedStyle(el)
      return [cs.color, cs.borderTopStyle]
    })
    expect(pausedBorder).toBe('dashed')
    await shot(flyout, 'paused-flyout')
    await shot(row, 'paused-row')
    // The UI answers before the server does: wait for the PATCH to land.
    await expect.poll(async () => (await getRoutine(created.id))?.enabled).toBe(false)
    const paused = await getRoutine(created.id)
    expect(typeof paused.state.pausedAtMs).toBe('number')
    expect(paused.state.nextRunAtMs).toBeUndefined()

    // While paused the daemon does not check it: over two cadences and the
    // first-run delay, lastCheck does not move (a check already running when the
    // pause landed may still report once, so read the mark after a settle).
    await sleep(6_000)
    const mark = (await getRoutine(created.id)).state.lastCheck.atMs
    await sleep(25_000)
    expect((await getRoutine(created.id)).state.lastCheck.atMs).toBe(mark)

    // A reload keeps it on the task as Paused.
    await page.keyboard.press('Escape')
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
    const pill2 = taskRow(page, task.title).getByTestId('task-trigger-pill')
    await expect(pill2).toHaveText('TRIGGER · PAUSED', { timeout: 15_000 })
    expect(await pill2.getAttribute('title')).toContain(`${name} (paused`)
    await pill2.click()
    const trow2 = page.getByTestId('trigger-jobs-flyout').locator(`.trigger-jobs-row[data-routine-id="${created.id}"]`)
    await expect(trow2.getByTestId('trigger-jobs-state')).toHaveText('Paused')

    // Resume: armed again, a next run on the card, and checks come back.
    await trow2.getByRole('button', { name: 'Resume' }).click()
    await expect(trow2).toHaveAttribute('data-state', 'armed')
    await expect(pill2).toHaveText('TRIGGER')
    await expect(pill2).not.toHaveAttribute('data-paused', 'true')
    const armedColor = await pill2.evaluate((el) => getComputedStyle(el).color)
    expect(armedColor).not.toBe(pausedColor)
    await expect.poll(async () => (await getRoutine(created.id))?.state?.lastCheck?.atMs ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(mark)
    const resumed = await getRoutine(created.id)
    expect(resumed.enabled).toBe(true)
    expect(resumed.state.pausedAtMs).toBeUndefined()
    expect(resumed.state.nextRunAtMs).toBeGreaterThan(Date.now() - 1_000)
    await expect(trow2.locator('.trigger-jobs-tally')).toContainText(/next run/i, { timeout: 15_000 })
    await expect(trow2.getByRole('button', { name: 'Run check now' })).toBeVisible()
  } finally {
    await cleanup([created.id], task.id)
  }
})

test('what appeared while paused arrives once, as ONE fire, on Resume; nothing replays after', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-trigger-pause-'))
  const feed = path.join(dir, 'items.json')
  const write = (ids: string[]) =>
    fs.writeFile(feed, JSON.stringify({ fire: true, items: ids.map((id) => ({ id, title: `item ${id}` })) }))
  await write(['a'])
  const task = await createTask('PW pause backlog task')
  const created = await createTrigger(task.id, `PW backlog ${Date.now()}`, `cat ${feed}`)
  try {
    // Item a fires once, then the check is quiet (a is seen).
    await expect.poll(async () => (await getRoutine(created.id))?.state?.fireCount ?? 0, { timeout: 60_000 }).toBe(1)
    await openHome(page)
    const pill = taskRow(page, task.title).getByTestId('task-trigger-pill')
    await expect(pill).toHaveText('TRIGGER', { timeout: 15_000 })
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    const trow = flyout.locator(`.trigger-jobs-row[data-routine-id="${created.id}"]`)
    await trow.getByRole('button', { name: 'Pause' }).click()
    await expect(trow).toHaveAttribute('data-state', 'paused')
    await expect.poll(async () => (await getRoutine(created.id))?.enabled).toBe(false)
    // The disarm reaches the daemon a moment after the server records it; a check
    // in that gap must not see the new items.
    await sleep(6_000)
    expect((await getRoutine(created.id)).state.fireCount).toBe(1)

    // Three new items while paused: nothing fires.
    await write(['a', 'b', 'c', 'd'])
    await sleep(25_000)
    expect((await getRoutine(created.id)).state.fireCount).toBe(1)

    // Resume: the first check sees all three and fires ONCE with them.
    await trow.getByRole('button', { name: 'Resume' }).click()
    await expect(trow).toHaveAttribute('data-state', 'armed')
    await expect.poll(async () => (await getRoutine(created.id))?.state?.fireCount ?? 0, { timeout: 45_000 }).toBe(2)
    const job = await getRoutine(created.id)
    expect(job.state.fireLog[0]).toMatchObject({ items: 3 })
    // And no storm: two more cadences stay quiet (everything is seen).
    await sleep(25_000)
    const after = await getRoutine(created.id)
    expect(after.state.fireCount).toBe(2)
    expect(after.state.lastCheck).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
    await expect(trow.locator('.trigger-jobs-tally')).toContainText('fired 2×', { timeout: 15_000 })
    await shot(flyout, 'resumed-flyout')
  } finally {
    await cleanup([created.id], task.id, dir)
  }
})

test('a trigger stopped after failing checks reads Stopped on its task and on the Routines card', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW stopped trigger task')
  const name = `PW stopped ${Date.now()}`
  const failing = await createTrigger(task.id, name, 'exit 3')
  const pausedName = `PW paused card ${Date.now()}`
  const quiet = await createTrigger(task.id, pausedName, `echo '{"fire": false}'`)
  try {
    await fetch(`${API}/api/routines/${quiet.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    })
    // Five errors in a row on a 10s cadence: the server switches it off.
    await expect.poll(async () => (await getRoutine(failing.id))?.enabled, { timeout: 120_000, intervals: [2_000] }).toBe(false)
    const stopped = await getRoutine(failing.id)
    expect(stopped.state.pausedAtMs).toBeUndefined()

    await openHome(page)
    const pill = taskRow(page, task.title).getByTestId('task-trigger-pill')
    await expect(pill).toHaveText('TRIGGER ×2 · OFF', { timeout: 15_000 })
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    const srow = flyout.locator(`.trigger-jobs-row[data-routine-id="${failing.id}"]`)
    await expect(srow).toHaveAttribute('data-state', 'stopped')
    await expect(srow.getByTestId('trigger-jobs-state')).toHaveText('Stopped')
    await expect(srow.getByTestId('trigger-jobs-off')).toHaveText('Stopped after 5 failed checks. Resume retries the check; one more failure stops it again.')
    await expect(srow.getByRole('button', { name: 'Resume' })).toBeVisible()
    await expect(flyout.locator(`.trigger-jobs-row[data-routine-id="${quiet.id}"]`)).toHaveAttribute('data-state', 'paused')
    await shot(flyout, 'stopped-flyout')
    await page.keyboard.press('Escape')

    // The Routines card: the switch says why it is off, the timing says since
    // when, and a paused trigger offers no Run now (its daemon has disarmed it).
    await page.getByTestId('sidebar-core-app-routines').click()
    await expect(page.locator('.page-title')).toContainText('Routines')
    const stoppedCard = page.locator('.routine-list .routine-card', { hasText: name }).first()
    const pausedCard = page.locator('.routine-list .routine-card', { hasText: pausedName }).first()
    await expect(stoppedCard.locator('.cron-toggle-btn')).toHaveText('Stopped')
    await expect(stoppedCard.locator('.cron-job-desc')).toContainText('Stopped after 5 failed checks')
    await expect(pausedCard.locator('.cron-toggle-btn')).toHaveText('Paused')
    await expect(pausedCard.locator('.cron-toggle-btn')).toHaveAttribute('title', 'Resume')
    await expect(pausedCard.locator('.cron-job-desc')).toContainText(/Paused (just now|\dm ago)/)
    await expect(pausedCard.locator('.cron-job-desc')).not.toContainText(/Next run/)
    await pausedCard.locator('.cron-menu-btn').click()
    await expect(pausedCard.getByRole('button', { name: 'Edit' })).toBeVisible()
    await expect(pausedCard.getByRole('button', { name: 'Run now' })).toHaveCount(0)
    await shot(pausedCard, 'paused-card')
    await pausedCard.locator('.cron-menu-btn').click()
    await expect(pausedCard.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    // Resume from the card: On again.
    await pausedCard.locator('.cron-toggle-btn').click()
    await expect(pausedCard.locator('.cron-toggle-btn')).toHaveText('On')
    await expect.poll(async () => (await getRoutine(quiet.id))?.enabled).toBe(true)
    await expect.poll(async () => (await getRoutine(quiet.id))?.state?.pausedAtMs ?? null).toBeNull()
  } finally {
    await cleanup([failing.id, quiet.id], task.id)
  }
})
