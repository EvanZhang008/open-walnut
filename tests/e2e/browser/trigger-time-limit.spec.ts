/**
 * A trigger's time limit on the surfaces a user meets it: the task's trigger card
 * (the TRIGGER pill's flyout) with its History, and the Routines card, fed by the
 * fixture's real local daemon running real check scripts.
 *
 * 2026-11-08, a trigger sweep: check scripts whose call timeouts times their retries
 * passed the trigger's limit were killed before the retry ran, nothing showed the
 * limit, and a killed run read "check timed out after 434s".
 *
 * Needs a daemon advertising `triggers-v1` (bash scripts/build-daemon.sh). The Mac app
 * is a WKWebView: run it in WebKit too (PW_WEBKIT=1 ... --project webkit).
 */
import fs from 'node:fs/promises'
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/trigger-time-limit`

// The daemon runs a new trigger's first check a few seconds after configure, and the
// slow script itself takes 6 s; a cold fixture can take a minute to draw the panel.
test.describe.configure({ timeout: 180_000 })

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, animations: 'disabled' })
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

async function createTrigger(taskId: string, name: string, run: string, timeoutSeconds: number): Promise<string> {
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      schedule: { kind: 'every', everyMs: 600_000 },
      check: { run, host: '__local__', timeoutSeconds },
      executor: { type: 'session', config: { target: taskId, prompt: 'Read the new items.' } },
    }),
  })
  if (!res.ok) throw new Error(`trigger create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { job: { id: string } }).job.id
}

async function lastCheck(id: string): Promise<any> {
  const res = await fetch(`${API}/api/routines/${id}`)
  return res.ok ? ((await res.json()) as { job: any }).job?.state?.lastCheck ?? null : null
}

function taskRow(page: Page, title: string): Locator {
  return page.locator('.todo-panel-item, .todo-pinned-card, .todo-focus-card').filter({ hasText: title })
}

test('the trigger card shows each check\'s time limit and last run, and History says a kill at the limit', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView, showEverything } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW trigger time limit task')
  const stamp = `${Date.now()}`
  const made: string[] = []
  try {
    const fast = await createTrigger(task.id, `PW fast ${stamp}`, `echo '{"fire": false}'`, 120)
    const slow = await createTrigger(task.id, `PW slow ${stamp}`, `sleep 6; echo '{"fire": false}'`, 10)
    const hung = await createTrigger(task.id, `PW hung ${stamp}`, 'sleep 60', 3)
    made.push(fast, slow, hung)
    // Each daemon run lands before the UI is opened, so the card draws it on first paint.
    await expect.poll(async () => (await lastCheck(fast))?.outcome ?? null, { timeout: 60_000 }).toBe('quiet')
    await expect.poll(async () => (await lastCheck(slow))?.outcome ?? null, { timeout: 60_000 }).toBe('quiet')
    await expect.poll(async () => (await lastCheck(hung))?.outcome ?? null, { timeout: 60_000 }).toBe('error')
    expect(await lastCheck(hung)).toMatchObject({
      error: 'check killed at the 3 s limit (timeoutSeconds): it was still running', killedAtLimit: true,
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
    await showEverything(page)
    const pill = taskRow(page, task.title).getByTestId('task-trigger-pill')
    await expect(pill).toHaveAttribute('data-trigger-count', '3', { timeout: 15_000 })
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    await expect(flyout).toBeVisible()
    const row = (name: string) => flyout.locator('.trigger-jobs-row', { hasText: `${name} ${stamp}` })

    const fastTime = row('PW fast').getByTestId('trigger-jobs-time')
    await expect(fastTime).toHaveText(/^time limit 120 s · last run \d+(\.\d)? s$/)
    await expect(fastTime).toHaveAttribute('data-near', 'false')
    const slowTime = row('PW slow').getByTestId('trigger-jobs-time')
    await expect(slowTime).toHaveText(/^time limit 10 s · last run [6-9](\.\d)? s, over half of it$/)
    await expect(slowTime).toHaveAttribute('data-near', 'true')
    const hungTime = row('PW hung').getByTestId('trigger-jobs-time')
    await expect(hungTime).toHaveText('time limit 3 s · last run killed at the limit')
    await expect(hungTime).toHaveAttribute('data-near', 'true')
    await expect(row('PW hung').locator('.trigger-jobs-last'))
      .toContainText('error: check killed at the 3 s limit (timeoutSeconds): it was still running')
    // The warning colour is the theme's, distinct from the plain line's.
    const [plainColor, nearColor] = await Promise.all([
      fastTime.evaluate((el) => getComputedStyle(el).color),
      slowTime.evaluate((el) => getComputedStyle(el).color),
    ])
    expect(nearColor).not.toBe(plainColor)

    // History: the killed run says so, and the slow one says it came close.
    const hungRow = row('PW hung')
    await hungRow.getByTestId('trigger-audit-toggle').click()
    await expect(hungRow.getByTestId('trigger-audit-list'))
      .toContainText('check error: check killed at the 3 s limit (timeoutSeconds): it was still running')
    const slowRow = row('PW slow')
    await slowRow.getByTestId('trigger-audit-toggle').click()
    await expect(slowRow.getByTestId('trigger-audit-list'))
      .toContainText(/quiet — the script said no · ran [6-9](\.\d)? s, over half its 10 s limit/)
    await shot(flyout, 'flyout')

    const box = await flyout.boundingBox()
    const viewport = page.viewportSize()!
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    await page.keyboard.press('Escape')
    await expect(flyout).toBeHidden()

    // The Routines card carries the same line.
    await page.getByTestId('sidebar-core-app-routines').click()
    await expect(page.locator('.page-title')).toContainText('Routines')
    const card = page.locator('.routine-list .routine-card', { hasText: `PW hung ${stamp}` }).first()
    await expect(card.getByTestId('routine-check-time')).toHaveText('time limit 3 s · last run killed at the limit')
    await expect(card.getByTestId('routine-check-time')).toHaveAttribute('data-near', 'true')
    const slowCard = page.locator('.routine-list .routine-card', { hasText: `PW slow ${stamp}` }).first()
    await expect(slowCard.getByTestId('routine-check-time')).toHaveText(/over half of it$/)
    await shot(card, 'routines-card')
  } finally {
    for (const id of made) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
  }
})

// 2026-11-09 review: the form's Test check gave up at the web client's 15 s, so a valid check that
// runs 20 s of a 30 s limit could not be tested there, and the form never showed the time against
// the limit. Now each call waits 10 s, then reads the same run again by its id.
test('the form\'s Test check waits out a long check and warns it ran over half its limit', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.getByTestId('sidebar-core-app-routines').click()
  await expect(page.locator('.page-title')).toContainText('Routines')
  await page.getByRole('button', { name: 'Build it myself' }).click()
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: /Add a check script/ }).click()
  await form.locator('#routine-check-run').fill(`sleep 18; echo '{"fire": false}'`)
  await form.locator('#routine-check-timeout').fill('30')
  const calls: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/routines/check-test')) calls.push(r.postData() ?? '') })
  await form.getByRole('button', { name: 'Test check' }).click()
  await expect(form.getByRole('button', { name: 'Testing…' })).toBeVisible()
  const verdict = form.locator('.routine-check-test-verdict')
  await expect(verdict).toContainText(/Would stay quiet now · ran 1[89](\.\d)? s of its 30 s limit/, { timeout: 60_000 })
  await expect(form.getByTestId('routine-check-test-limit')).toContainText(/^This test run took 1[89](\.\d)? s, 6\d% of its 30 s time limit/)
  // It took more than one call, the later ones reading the same run by its id.
  expect(calls.length).toBeGreaterThan(1)
  expect(calls.slice(1).every((b) => /"testId":"tt_[0-9a-f]{12}"/.test(b))).toBe(true)
  await form.locator('.routine-check-test').last().scrollIntoViewIfNeeded()
  await shot(form.locator('.routine-check-test').last(), 'form-test')
  await form.getByRole('button', { name: 'Cancel' }).click()
})
