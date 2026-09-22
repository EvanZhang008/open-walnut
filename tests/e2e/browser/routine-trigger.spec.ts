/**
 * walnut-trigger in the real UI: the Routines form's Check section, the Test
 * button's three verdicts, the save-time refusal of a wall-clock trigger, and
 * the card's Trigger badge + last-check line fed by the fixture's real local
 * daemon (which runs the check and reports quiet/fired/error).
 *
 * Needs a daemon advertising `triggers-v1`: the fixture spawns the built
 * binary from dist/daemon-binaries, so run `bash scripts/build-daemon.sh` first.
 */
import { test, expect } from './shortcut-test-fixture'

const API = 'http://localhost:3457'

async function deleteRoutine(id: string): Promise<void> {
  await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
}

async function findRoutineByName(name: string): Promise<any | undefined> {
  const res = await fetch(`${API}/api/routines?includeDisabled=true`)
  const { jobs } = (await res.json()) as { jobs: any[] }
  return jobs.find((j) => j.name === name)
}

async function openRoutines(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const link = page.getByTestId('sidebar-core-app-routines')
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.locator('.page-title')).toContainText('Routines')
}

async function openBlankForm(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Build it myself' }).click()
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  return form
}

test('the Test button reports would-fire, quiet, and error without saving anything', async ({ page }) => {
  await openRoutines(page)
  const form = await openBlankForm(page)

  await form.getByRole('button', { name: /Add a check script/ }).click()
  // A check is a poll: opening the section moves the untouched trigger to an interval.
  await expect(form.locator('.routine-trigger-header')).toContainText('every 5 min')

  // Every script this test types carries one nonce, so the "nothing was saved"
  // check below can name its own scripts among a shared server's routines.
  const mark = `nosave-${Date.now()}`
  const run = form.locator('#routine-check-run')
  await run.fill(`echo '{"fire": true, "items": [{"id": "pw-1"}, {"id": "pw-2"}], "input": "${mark}"}'`)
  // The server answer is the diagnosis when the verdict never renders (a cold
  // or old fixture daemon answers 503/400 with the reason).
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/routines/check-test'), { timeout: 60_000 })
  await form.getByRole('button', { name: 'Test check' }).click()
  const res = await answer
  expect(res.status(), await res.text()).toBe(200)
  const verdict = form.locator('.routine-check-test-verdict')
  await expect(verdict).toContainText('Would fire now (2 new items)', { timeout: 30_000 })
  await expect(form.locator('.routine-check-test-output')).toContainText('"fire": true')

  await run.fill(`echo '{"fire": false, "state": {"cursor": "${mark}"}}'`)
  await form.getByRole('button', { name: 'Test check' }).click()
  await expect(verdict).toContainText('Would stay quiet now', { timeout: 30_000 })

  await run.fill(`echo nope ${mark} >&2; exit 3`)
  await form.getByRole('button', { name: 'Test check' }).click()
  await expect(verdict).toContainText('Check error: exit 3', { timeout: 30_000 })
  await expect(verdict).toContainText('nope')

  // Testing never creates a routine. Counted by THIS test's own check scripts,
  // not by the total: the fixture server is shared across workers, so a total
  // that grew proves only that some other spec created its trigger meanwhile.
  const jobs = (await (await fetch(`${API}/api/routines?includeDisabled=true`)).json()).jobs as Array<{ check?: { run?: string } }>
  expect(jobs.filter((j) => (j.check?.run ?? '').includes(mark))).toEqual([])
  await form.getByRole('button', { name: 'Cancel' }).click()
})

test('a check with a wall-clock trigger is refused in the form with the reason', async ({ page }) => {
  await openRoutines(page)
  const form = await openBlankForm(page)
  await form.locator('#routine-name').fill(`PW trigger clock ${Date.now()}`)
  // Main Agent needs no working directory, so the only refusal left is the schedule's.
  await form.locator('label.cron-form-radio', { hasText: 'Main Agent' }).locator('input').check()
  await form.locator('#routine-f-instructions').fill('Say hello.')
  await form.getByRole('button', { name: /Add a check script/ }).click()
  await form.locator('#routine-check-run').fill(`echo '{"fire": false}'`)
  await form.getByRole('tab', { name: 'Daily' }).click()
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form.locator('.cron-form-error')).toContainText('polls on an interval')
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Cancel' }).click()
})

test('a hand-built trigger stores its check, shows the badge, and the daemon reports the first quiet check', async ({ page }) => {
  const name = `PW trigger ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  let createdId: string | undefined
  try {
    await openRoutines(page)
    const form = await openBlankForm(page)
    await form.locator('#routine-name').fill(name)
    await form.locator('label.cron-form-radio', { hasText: 'Main Agent' }).locator('input').check()
    await form.locator('#routine-f-instructions').fill('Nothing new means do nothing.')
    await form.getByRole('button', { name: /Add a check script/ }).click()
    await form.locator('#routine-check-run').fill(`echo '{"fire": false, "state": {"cursor": "pw"}}'`)
    await form.locator('#routine-check-timeout').fill('20')
    await form.getByRole('button', { name: 'Create' }).click()
    await expect(form).toBeHidden()

    const card = page.locator('.routine-list .routine-card', { hasText: name }).first()
    await expect(card).toBeVisible()
    await expect(card.locator('.routine-trigger-badge')).toHaveText('Trigger')
    await expect(card.locator('.routine-check-run')).toContainText('$ echo')
    await expect(card.locator('.routine-check-run')).toContainText('@ local')

    const stored = await findRoutineByName(name)
    expect(stored).toBeTruthy()
    createdId = stored.id
    expect(stored.check).toMatchObject({ run: expect.stringContaining('"fire": false'), host: '__local__', timeoutSeconds: 20 })
    expect(stored.schedule).toMatchObject({ kind: 'every', everyMs: 300_000 })

    // The daemon runs the first check a few seconds after configure and reports
    // quiet; the card refreshes on the cron event without a reload.
    await expect(card.locator('.routine-check-status')).toContainText('quiet', { timeout: 30_000 })
    await expect(card.locator('.routine-check-status')).toHaveClass(/quiet/)

    // Edit round-trip: the section opens with the stored command; removing the
    // check turns the routine back into a plain scheduled one.
    await card.locator('.cron-menu-btn').click()
    await card.getByRole('button', { name: 'Edit' }).click()
    const edit = page.locator('.routine-modal')
    await expect(edit.locator('#routine-check-run')).toHaveValue(/fire.*false/)
    await edit.getByRole('button', { name: 'Remove check' }).click()
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit).toBeHidden()
    await expect(card.locator('.routine-trigger-badge')).toHaveCount(0)
    await expect.poll(async () => (await findRoutineByName(name))?.check ?? null).toBeNull()
  } finally {
    if (createdId) await deleteRoutine(createdId)
    else {
      const stray = await findRoutineByName(name)
      if (stray) await deleteRoutine(stray.id)
    }
  }
})

// The live-session palette lists what the CLI advertised, and the daemon links
// shipped skills into ~/.claude/skills only for the production daemon dir, so
// `/walnut-trigger` inside a live session is verified on the real install, not
// here. What the fixture CAN pin: the skill ships and is eligible.
test('walnut-trigger ships as an eligible skill', async () => {
  const res = await fetch(`${API}/api/skills`)
  const body = (await res.json()) as { skills?: Array<{ name: string; eligible?: boolean; enabled?: boolean }> } | Array<{ name: string }>
  const list = Array.isArray(body) ? body : body.skills ?? []
  const skill = list.find((s) => s.name === 'walnut-trigger') as { eligible?: boolean; enabled?: boolean } | undefined
  expect(skill).toBeTruthy()
  expect(skill?.eligible ?? true).toBe(true)
})

// ── The TRIGGER pill: the task row is where a trigger is seen and handled ──

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

async function createTriggerFor(taskId: string, name: string, run: string, everyMs = 300_000): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      schedule: { kind: 'every', everyMs },
      check: { run, host: '__local__' },
      executor: { type: 'session', config: { target: taskId, prompt: 'Read the new items.' } },
    }),
  })
  if (!res.ok) throw new Error(`trigger create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { job: { id: string } }).job
}

async function getRoutine(id: string): Promise<any | null> {
  const res = await fetch(`${API}/api/routines/${id}`)
  return res.ok ? ((await res.json()) as { job: any }).job : null
}

test('a task with an armed trigger shows the TRIGGER pill; the pill opens the trigger itself', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView, showEverything } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW trigger pill task')
  const routines: string[] = []
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await showEverything(page)
    const row = page.locator('.todo-panel-item', { hasText: task.title })
    await expect(row).toBeVisible()
    // No trigger yet: no pill. A plain task must not grow a badge.
    await expect(row.getByTestId('task-trigger-pill')).toHaveCount(0)

    // Armed AFTER the page loaded: the row learns it from the cron:job-added
    // broadcast, no reload.
    const name = `PW pill ${Date.now()}`
    const first = await createTriggerFor(task.id, name, `echo '{"fire": false, "state": {"n": 1}}'`)
    routines.push(first.id)
    const pill = row.getByTestId('task-trigger-pill')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await expect(pill).toHaveText('TRIGGER')
    await expect(pill).toHaveAttribute('title', new RegExp(`${name}: Every 5 min, \\$ echo`))

    // The pill opens the trigger, not a page: name, cadence, command, last check.
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    await expect(flyout).toBeVisible()
    await expect(flyout).toContainText('Trigger on this task')
    await expect(flyout.locator('.trigger-jobs-heading strong')).toHaveText(name)
    await expect(flyout.locator('.trigger-jobs-cadence')).toHaveText('Every 5 min')
    await expect(flyout.locator('.trigger-jobs-run')).toContainText('$ echo')
    await expect(flyout.locator('.trigger-jobs-run')).toContainText('@ local')
    // The fixture daemon runs the first check a few seconds after configure.
    await expect(flyout.locator('.trigger-jobs-last')).toContainText('quiet', { timeout: 30_000 })
    // It never leaves the viewport.
    const box = await flyout.boundingBox()
    const viewport = page.viewportSize()!
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)

    // Esc closes and returns focus to the pill; a second trigger counts on the pill.
    await page.keyboard.press('Escape')
    await expect(flyout).toBeHidden()
    await expect(pill).toBeFocused()
    const second = await createTriggerFor(task.id, `${name} b`, `echo '{"fire": false}'`)
    routines.push(second.id)
    await expect(pill).toHaveText('TRIGGER ×2', { timeout: 10_000 })
    await pill.click()
    await expect(flyout).toContainText('2 triggers on this task')
    await expect(flyout.locator('.trigger-jobs-row')).toHaveCount(2)

    // Disable from the flyout: that trigger leaves the list and the pill counts down;
    // disabling the last one takes the pill (and the flyout) away. Disabled means
    // disabled on the server, not hidden in the browser.
    await flyout.locator('.trigger-jobs-row', { hasText: `${name} b` }).getByRole('button', { name: 'Disable' }).click()
    await expect(flyout.locator('.trigger-jobs-row')).toHaveCount(1)
    await expect(pill).toHaveText('TRIGGER')
    await expect.poll(async () => (await getRoutine(second.id))?.enabled).toBe(false)
    await flyout.getByRole('button', { name: 'Disable' }).click()
    await expect(flyout).toBeHidden()
    await expect(row.getByTestId('task-trigger-pill')).toHaveCount(0)
    await expect.poll(async () => (await getRoutine(first.id))?.enabled).toBe(false)
    // The row itself is still there and untouched.
    await expect(row).toBeVisible()
  } finally {
    for (const id of routines) await deleteRoutine(id)
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
  }
})

test('the flyout audits the trigger: never-fired, then the checks, then what a fire injected', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView, showEverything } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW trigger audit task')
  const name = `PW audit ${Date.now()}`
  // A check that fires on every run, so the audit gets a real fire with a real
  // delivery — the fixture's own daemon runs it on its 10s floor.
  const created = await createTriggerFor(task.id, name, `echo '{"fire": true, "input": "AUDIT_INPUT_MARK"}'`, 10_000)
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await showEverything(page)
    const row = page.locator('.todo-panel-item', { hasText: task.title })
    const pill = row.getByTestId('task-trigger-pill')
    await expect(pill).toBeVisible({ timeout: 15_000 })
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    await expect(flyout).toBeVisible()

    // Before any check has been reported there is nothing to audit, and the
    // flyout says exactly that instead of looking broken.
    const tally = flyout.locator('.trigger-jobs-tally')
    const toggle = flyout.getByTestId('trigger-audit-toggle')
    if ((await tally.innerText()).startsWith('never fired')) {
      await expect(toggle).toContainText(/No checks recorded yet|History/)
    }

    // What it WILL inject is visible before anything happens.
    await flyout.getByRole('button', { name: /What it injects/ }).click()
    await expect(flyout.locator('.trigger-audit-injected').first()).toContainText('Read the new items.')

    // The daemon fires within ~15s (5s first-run delay + a 10s cadence).
    await expect(tally).toContainText('fired', { timeout: 60_000 })
    await expect(toggle).toContainText(/History \(\d+ recorded check/, { timeout: 10_000 })
    await toggle.click()
    const list = flyout.getByTestId('trigger-audit-list')
    await expect(list.locator('.trigger-audit-row')).not.toHaveCount(0)
    const fired = list.locator('.trigger-audit-row[data-outcome="fired"]').first()
    await expect(fired).toContainText('fired')
    await expect(fired.locator('.trigger-audit-clock')).toHaveText(/\d{2}:\d{2}/)

    // Opening the fire shows the exact text the session received — the answer to
    // "what is the injected context".
    await fired.locator('.trigger-audit-line').click()
    const injected = fired.locator('.trigger-audit-injected')
    await expect(injected).toContainText('<walnut-message kind="trigger"')
    await expect(injected).toContainText('AUDIT_INPUT_MARK')
    await expect(fired).toContainText(/Injected into the session \(\d+ chars\)/)
    // Where it went is always named. "Open that session" is there only when the
    // fire landed in an EXISTING session: this task had none, so the trigger
    // started one, and a launch that has not linked its session yet reports no id
    // rather than inventing one (the live-session path is pinned in
    // tests/e2e/trigger-routines.test.ts, which asserts delivery.sessionId).
    await expect(fired.locator('.trigger-audit-what')).toContainText(/session|task/)
    const openBtn = fired.getByRole('button', { name: 'Open that session' })
    if (await openBtn.count()) await expect(openBtn).toBeVisible()

    // The audit survives a reload: it is server state, not a browser accumulation.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await showEverything(page)
    const pill2 = page.locator('.todo-panel-item', { hasText: task.title }).getByTestId('task-trigger-pill')
    await pill2.click()
    await expect(page.getByTestId('trigger-jobs-flyout').locator('.trigger-jobs-tally')).toContainText('fired')
  } finally {
    await deleteRoutine(created.id)
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
  }
})

test('the flyout\'s Delete asks once, then removes the trigger; an outside click closes it', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView, showEverything } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW trigger delete task')
  const name = `PW delete ${Date.now()}`
  const created = await createTriggerFor(task.id, name, `echo '{"fire": false}'`)
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await showEverything(page)
    const row = page.locator('.todo-panel-item', { hasText: task.title })
    const pill = row.getByTestId('task-trigger-pill')
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    await expect(flyout).toBeVisible()
    // A click elsewhere (another task's row) closes it and nothing happens to the trigger.
    await page.locator('.todo-panel-item', { hasText: 'Playwright test task' }).first().click()
    await expect(flyout).toBeHidden()
    expect((await getRoutine(created.id))?.enabled).toBe(true)

    await pill.click()
    await expect(flyout).toBeVisible()
    await flyout.getByRole('button', { name: 'Delete', exact: true }).click()
    // Two-step: nothing is gone until the confirm.
    expect(await getRoutine(created.id)).toBeTruthy()
    await flyout.getByRole('button', { name: 'Confirm delete' }).click()
    await expect(flyout).toBeHidden()
    await expect(row.getByTestId('task-trigger-pill')).toHaveCount(0)
    await expect.poll(async () => await getRoutine(created.id)).toBeNull()
  } finally {
    await deleteRoutine(created.id)
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
  }
})
