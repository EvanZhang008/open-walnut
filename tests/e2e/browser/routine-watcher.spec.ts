/**
 * Watcher routines in the real UI: reach the form without a model call, build a
 * watcher by hand, and prove the values the form sends are the values stored.
 *
 * The manual entry point matters as much as the form: before this feature the
 * only way to open a blank routine form was to make the AI drafter FAIL, so a
 * box with no provider configured could not create a routine at all.
 */
import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

async function deleteRoutine(id: string): Promise<void> {
  await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
}

async function findRoutineByName(name: string): Promise<any | undefined> {
  const res = await fetch(`${API}/api/routines?includeDisabled=true`)
  const { jobs } = (await res.json()) as { jobs: any[] }
  return jobs.find((j) => j.name === name)
}

/** Real clicks only: land on the app, then navigate through the sidebar. */
async function openRoutines(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  // testid, not the label: a collapsed sidebar hides the text.
  const link = page.getByTestId('sidebar-core-app-routines')
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.locator('.page-title')).toContainText('Routines')
}

test('builds a watcher routine by hand and stores exactly what the form showed', async ({ page }) => {
  const name = `PW watcher ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  let createdId: string | undefined
  try {
    await openRoutines(page)

    // The manual path — no model call, so this works with no provider configured.
    await page.getByRole('button', { name: 'Build it myself' }).click()
    const form = page.locator('.routine-modal')
    await expect(form).toBeVisible()

    await form.locator('#routine-name').fill(name)

    // Watcher is not the default executor; pick it and watch the form change.
    await expect(form.locator('#routine-f-tools')).toHaveCount(0)
    await form.locator('label.cron-form-radio', { hasText: 'Watcher' }).locator('input').check()
    await expect(form.locator('#routine-f-tools')).toBeVisible()
    await expect(form.locator('#routine-f-maxOutcomesPerRun')).toBeVisible()
    await expect(form.locator('#routine-f-sessionCwd')).toBeVisible()

    await form.locator('#routine-f-instructions').fill(
      'Check my unread mail. Task anything needing a reply. Ignore newsletters. Nothing new means do nothing.',
    )

    // Polling is an interval, so exercise Custom → Interval rather than a clock.
    await form.getByRole('tab', { name: 'Custom' }).click()
    await form.locator('input[type="radio"][name="routine-custom-kind"]').nth(1).check()
    await form.getByLabel('Interval minutes').fill('10')

    // 0 is a REAL setting here ("never start a session"). The number input used
    // to hard-code min=1, which silently refused it.
    const sessionCap = form.locator('#routine-f-maxSessionsPerDay')
    await expect(sessionCap).toHaveAttribute('min', '0')
    await sessionCap.fill('0')
    await expect(sessionCap).toHaveValue('0')
    await form.locator('#routine-f-maxOutcomesPerRun').fill('2')

    await form.getByRole('button', { name: 'Create' }).click()
    await expect(form).toBeHidden()

    // The card is in the list, badged as a Watcher.
    const card = page.locator('.routine-list .routine-card', { hasText: name }).first()
    await expect(card).toBeVisible()
    await expect(card.locator('.routine-executor-badge')).toContainText('Watcher')

    // And what the server stored matches what the form showed.
    const stored = await findRoutineByName(name)
    expect(stored).toBeTruthy()
    createdId = stored.id
    expect(stored.executor.type).toBe('watcher')
    expect(stored.executor.config.maxSessionsPerDay).toBe(0)
    expect(stored.executor.config.maxOutcomesPerRun).toBe(2)
    expect(stored.executor.config.instructions).toContain('Ignore newsletters')
    expect(stored.schedule).toMatchObject({ kind: 'every', everyMs: 600_000 })
  } finally {
    if (createdId) await deleteRoutine(createdId)
    else {
      const stray = await findRoutineByName(name)
      if (stray) await deleteRoutine(stray.id)
    }
  }
})

test('a watcher with no instructions is refused in the form, not on the server', async ({ page }) => {
  await openRoutines(page)
  await page.getByRole('button', { name: 'Build it myself' }).click()
  const form = page.locator('.routine-modal')
  await form.locator('#routine-name').fill(`PW watcher blank ${Date.now()}`)
  await form.locator('label.cron-form-radio', { hasText: 'Watcher' }).locator('input').check()
  await form.getByRole('button', { name: 'Create' }).click()
  await expect(form.locator('.cron-form-error')).toContainText('What to watch is required')
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Cancel' }).click()
})

test('every watcher field the server advertises is one the form can draw', async ({ page }) => {
  await openRoutines(page)
  await page.getByRole('button', { name: 'Build it myself' }).click()
  const form = page.locator('.routine-modal')
  await form.locator('label.cron-form-radio', { hasText: 'Watcher' }).locator('input').check()

  const res = await fetch(`${API}/api/routines/executors`)
  const { executors } = (await res.json()) as { executors: any[] }
  const watcher = executors.find((e) => e.type === 'watcher')
  expect(watcher).toBeTruthy()
  for (const field of watcher.configSchema) {
    // `model` is hoisted into the instructions box with its own select, so it
    // has no #routine-f-model input; every other field gets one.
    if (field.name === 'model') {
      await expect(form.locator('.routine-model-select')).toBeVisible()
      continue
    }
    await expect(form.locator(`#routine-f-${field.name}`)).toBeVisible()
  }
  await form.getByRole('button', { name: 'Cancel' }).click()
})
