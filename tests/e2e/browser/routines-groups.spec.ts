/**
 * The Routines page grouped by owner (2026-11-04, the user: "routine page should be
 * seperate by global routine and each peoject routine so messy and deault firsvpage
 * show min.info"): the global routines first, then one group per project (the
 * project of the task a routine delivers into), each folding on its header and
 * staying folded across a reload; one line per routine until it is opened; a failing
 * routine first in its group; a switch flipped by a click never moves its row.
 *
 * Real server (playwright.config.ts webServer); each test makes its own projects with
 * a unique suffix, so the parallel specs' routines (all global) do not disturb it.
 */
import { test, expect, type Page } from '@playwright/test'
import { openManualRoutineForm, openRoutineComposer } from './routines-page-helpers'

const API = 'http://localhost:3457'

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

const made: string[] = []
const madeTasks: string[] = []

async function task(title: string, project: string): Promise<string> {
  const { task } = await call('POST', '/api/tasks', { title, project })
  madeTasks.push(task.id)
  return task.id
}

async function routine(name: string, target: string, over: Record<string, unknown> = {}): Promise<string> {
  const { job } = await call('POST', '/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 3_600_000 },
    executor: { type: 'session', config: { target, prompt: `Look at ${name}.` } },
    ...over,
  })
  made.push(job.id)
  return job.id
}

test.afterAll(async () => {
  for (const id of made) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
  for (const id of madeTasks) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
})

const group = (page: Page, key: string) => page.locator(`section.routine-group[data-group="${key}"]`)
const rowIds = (page: Page, key: string) =>
  group(page, key).locator('li.routine-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-routine-id')))

test('groups by project, global first, failing routine first, one line until opened', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const alpha = `Alpha ${tag}`
  const beta = `Beta ${tag}`
  const alphaTask = await task('Alpha watcher', alpha)
  const betaTask = await task('Beta watcher', beta)
  const doneTask = await task('Beta finished work', beta)
  // A routine with no task of its own: global.
  const { job: global } = await call('POST', '/api/routines', {
    name: `Global one ${tag}`,
    schedule: { kind: 'every', everyMs: 3_600_000 },
    enabled: false,
    executor: { type: 'main-agent', config: { instructions: 'ping' } },
  })
  made.push(global.id)
  const a1 = await routine(`A one ${tag}`, alphaTask)
  const a2 = await routine(`A two ${tag}`, alphaTask)
  const b1 = await routine(`B calm ${tag}`, betaTask)
  const b2 = await routine(`B zz failing ${tag}`, doneTask)
  await call('POST', `/api/tasks/${doneTask}/complete`, {}).catch(() => call('PATCH', `/api/tasks/${doneTask}`, { phase: 'COMPLETE' }))
  await call('POST', `/api/routines/${b2}/run`).catch(() => {})
  await expect.poll(async () => (await call('GET', `/api/routines/${b2}`)).job.state.lastStatus, { timeout: 15_000 }).toBe('error')

  await page.goto('/routines')
  await expect(group(page, `project:${alpha}`)).toBeVisible({ timeout: 15_000 })

  // Global first, then projects by name: Alpha before Beta.
  const keys = await page.locator('section.routine-group').evaluateAll((els) => els.map((el) => el.getAttribute('data-group')))
  expect(keys[0]).toBe('global')
  await expect(group(page, 'global').locator(`li.routine-row[data-routine-id="${global.id}"]`)).toBeVisible()
  expect(keys.indexOf(`project:${alpha}`)).toBeLessThan(keys.indexOf(`project:${beta}`))
  expect(await rowIds(page, `project:${alpha}`)).toEqual([a1, a2])
  // The failing one leads Beta although its name sorts last; the header counts it.
  expect(await rowIds(page, `project:${beta}`)).toEqual([b2, b1])
  await expect(group(page, `project:${beta}`).locator('.routine-group-failing')).toHaveText('1 failing')
  const failingRow = page.locator(`li.routine-row[data-routine-id="${b2}"]`)
  await expect(failingRow).toHaveAttribute('data-health', 'error')
  await expect(failingRow.locator('.routine-row-flag')).toHaveText('Failed')

  // One line: no details, no actions until it is opened.
  await expect(failingRow.locator('.routine-detail')).toHaveCount(0)
  await failingRow.locator('.routine-row-main').click()
  await expect(failingRow.locator('.routine-detail')).toBeVisible()
  await expect(failingRow.locator('.routine-facts')).toContainText('Beta finished work')
  await expect(failingRow.locator('.cron-job-error')).toContainText('complete')
  for (const name of ['Run now', 'Edit', 'Open task', 'Delete']) {
    await expect(failingRow.getByRole('button', { name, exact: true })).toBeVisible()
  }
  // The error names the task, not its id, and says the way out.
  await expect(failingRow.locator('.cron-job-error')).toContainText('"Beta finished work"')
  await expect(failingRow.locator('.routine-row-error-next')).toHaveText('Point it at an open task with Edit, or turn it off.')
  // Opening another row closes this one; the clicked row stays on screen (held in
  // place when the page can scroll that far: routines-row-anchor below).
  const calm = page.locator(`li.routine-row[data-routine-id="${b1}"]`)
  await calm.locator('.routine-row-main').click()
  await expect(calm.locator('.routine-detail')).toBeVisible()
  await expect(failingRow.locator('.routine-detail')).toHaveCount(0)
  await expect(calm.locator('.routine-row-main')).toBeInViewport()

  // The switch pauses in place: the row keeps its spot and says Paused.
  const sw = page.getByTestId(`routine-switch-${a1}`)
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await expect(page.locator(`li.routine-row[data-routine-id="${a1}"] .cron-job-desc`)).toHaveText('Paused · Every hour')
  expect(await rowIds(page, `project:${alpha}`)).toEqual([a1, a2])
  await expect.poll(async () => (await call('GET', `/api/routines/${a1}`)).job.enabled).toBe(false)
})

test('a folded group stays folded after a reload, and unfolds again', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const project = `Gamma ${tag}`
  const t = await task('Gamma watcher', project)
  const id = await routine(`G one ${tag}`, t)

  await page.goto('/routines')
  const header = group(page, `project:${project}`).locator('.routine-group-header')
  await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })
  await expect(group(page, `project:${project}`).locator('.routine-group-count')).toHaveText('1')
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator(`li.routine-row[data-routine-id="${id}"]`)).toHaveCount(0)

  await page.reload()
  await expect(header).toHaveAttribute('aria-expanded', 'false', { timeout: 15_000 })
  await expect(page.locator(`li.routine-row[data-routine-id="${id}"]`)).toHaveCount(0)
  await header.click()
  await expect(page.locator(`li.routine-row[data-routine-id="${id}"]`)).toBeVisible()
})

test('the composer is behind New routine while routines exist', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task('Delta watcher', `Delta ${tag}`)
  await routine(`D one ${tag}`, t)
  await page.goto('/routines')
  const button = page.locator('.routines-new-btn')
  await expect(button).toHaveText('New routine', { timeout: 15_000 })
  await expect(page.locator('.routine-composer')).toHaveCount(0)
  await button.click()
  await expect(page.locator('.routine-composer')).toBeVisible()
  await expect(button).toHaveText('New routine')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await button.click()
  await expect(page.locator('.routine-composer')).toHaveCount(0)
})

// The home page stays mounted under every other route; its chat's phone layer used
// to stay registered there, so the phone's top bar named Routines (and every other
// page) "Walnut" with a Back button that closed a chat nobody could see.
test('on a phone the top bar names the page, with the home chat left open', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await ctx.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'true'))
  const page = await ctx.newPage()
  try {
    await page.goto('/')
    await expect(page.locator('.phone-topbar')).toHaveAttribute('data-layer', 'chat', { timeout: 15_000 })
    // (/tasks is the home list on a phone and goes home, so it is not one of them.)
    for (const [path, title] of [['/routines', 'Routines'], ['/settings', 'Settings']] as const) {
      await page.goto(path)
      await expect(page.locator('.phone-topbar-title-text')).toHaveText(title, { timeout: 15_000 })
      await expect(page.locator('.phone-topbar').getByRole('button', { name: 'Back' })).toHaveCount(0)
      await expect(page.locator('.phone-topbar').getByRole('button', { name: 'Menu' })).toBeVisible()
    }
    // Back home, the chat is the screen again and owns the bar.
    await page.goto('/')
    await expect(page.locator('.phone-topbar')).toHaveAttribute('data-layer', 'chat', { timeout: 15_000 })
  } finally {
    await ctx.close()
  }
})

// Opening a row closes the one open above it; the page scrolls by what that took away,
// so the row the person clicked does not jump out from under the pointer (2026-11-04,
// a review: the clicked row went 325 px up, off the screen).
test('routines-row-anchor: the clicked row holds its place when the open row above it closes', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const project = `Anchor ${tag}`
  const t = await task('Anchor watcher', project)
  const ids: string[] = []
  for (let i = 0; i < 20; i++) ids.push(await routine(`Anchor ${String(i).padStart(2, '0')} ${tag}`, t))
  // Tall enough that the clicked row's details fit below it (a row opened lower down
  // also scrolls its details into view: routines-row-reveal below).
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/routines')
  const first = page.locator(`li.routine-row[data-routine-id="${ids[0]}"]`)
  await expect(first).toBeVisible({ timeout: 15_000 })
  // Open the first row of the group, scroll it near the top, then click a row below it.
  await first.locator('.routine-row-main').click()
  await expect(first.locator('.routine-detail')).toBeVisible()
  await first.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const target = page.locator(`li.routine-row[data-routine-id="${ids[6]}"]`)
  await expect(target).toBeInViewport()
  const before = (await target.boundingBox())!.y
  await target.locator('.routine-row-main').click()
  await expect(target.locator('.routine-detail')).toBeVisible()
  await expect(first.locator('.routine-detail')).toHaveCount(0)
  expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThan(3)
})

// A row opened near the bottom edge brings its details on screen, its own line kept.
test('routines-row-reveal: a row opened at the bottom edge shows its details', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task('Reveal watcher', `Reveal ${tag}`)
  const ids: string[] = []
  for (let i = 0; i < 12; i++) ids.push(await routine(`Reveal ${String(i).padStart(2, '0')} ${tag}`, t))
  await page.setViewportSize({ width: 1280, height: 700 })
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${ids[11]}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  // Put the row's line just above the bottom edge, then open it.
  await row.evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await row.locator('.routine-row-main').click()
  await expect(row.locator('.routine-actions')).toBeInViewport({ ratio: 1, timeout: 5000 })
  await expect(row.locator('.routine-row-main')).toBeInViewport()
})

// Run now answers before the run delivers: a delivery that fails (here, into a task
// that is complete) is said as a failure, never as a green "Started".
test('Run now says a run that failed failed', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const done = await task('Run finished work', `Run ${tag}`)
  const id = await routine(`Run fails ${tag}`, done)
  await call('POST', `/api/tasks/${done}/complete`, {}).catch(() => call('PATCH', `/api/tasks/${done}`, { phase: 'COMPLETE' }))
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.routine-row-main').click()
  await row.getByRole('button', { name: 'Run now', exact: true }).click()
  // Refused at once (its task is complete) or failed once started: either way it says so.
  await expect(row.getByTestId('routine-run-outcome')).toHaveText(/^It (ran and failed|did not run): the reason is above\.$/, { timeout: 15_000 })
  await expect(row.getByTestId('routine-run-outcome')).toHaveClass(/error/)
  await expect(row.locator('.cron-job-error')).toContainText('"Run finished work"')
})

// A switch the server refuses is said on its own row, naming what failed, and the
// list does not move (2026-11-04, a review: a banner above the list pushed it down).
test('a refused pause is said on its row and moves nothing', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task('Refuse watcher', `Refuse ${tag}`)
  const id = await routine(`Refuse one ${tag}`, t)
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await page.route(`**/api/routines/${id}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'engine busy' }) })
  })
  // Measured inside its own group: parallel specs add routines to the groups above.
  await row.scrollIntoViewIfNeeded()
  const section = group(page, `project:Refuse ${tag}`)
  const inGroup = async () => (await row.boundingBox())!.y - (await section.boundingBox())!.y
  const top = await inGroup()
  await page.getByTestId(`routine-switch-${id}`).click()
  await expect(row.getByTestId('routine-action-error')).toHaveText(/Could not pause it: engine busy/, { timeout: 5000 })
  await expect(page.getByTestId(`routine-switch-${id}`)).toHaveAttribute('aria-checked', 'true')
  expect(Math.abs((await inGroup()) - top)).toBeLessThan(2)
  await expect(page.locator('.routines-view > .cron-form-error')).toHaveCount(0)
  await row.getByRole('button', { name: 'Dismiss' }).click()
  await expect(row.getByTestId('routine-action-error')).toHaveCount(0)
})

// The way out of "its task is complete" is Edit, which picks the task by its title.
test('Edit picks the task a routine runs in by its title', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const project = `Pick ${tag}`
  const done = await task(`Pick finished ${tag}`, project)
  const open = await task(`Pick open target ${tag}`, project)
  const id = await routine(`Pick one ${tag}`, done)
  await call('POST', `/api/tasks/${done}/complete`, {}).catch(() => call('PATCH', `/api/tasks/${done}`, { phase: 'COMPLETE' }))
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.routine-row-main').click()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  const current = page.getByTestId('routine-task-current')
  await expect(current).toContainText(`Pick finished ${tag}`)
  await expect(current).toContainText('complete: pick an open task with Change task')
  // The list stays closed until asked for, so the rest of the form is not pushed down.
  await expect(page.getByTestId('routine-task-hits')).toHaveCount(0)
  await page.getByRole('button', { name: 'Change task' }).click()
  await page.getByRole('searchbox', { name: 'Find an open task by its title' }).fill(`open target ${tag}`)
  const hit = page.getByTestId('routine-task-hits').getByRole('button', { name: new RegExp(`Pick open target ${tag}`) })
  await expect(hit).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('routine-task-hits')).not.toContainText(`Pick finished ${tag}`)
  await hit.click()
  await expect(current).toContainText(`Pick open target ${tag}`)
  await expect(current).not.toContainText('complete')
  await expect(page.getByTestId('routine-task-hits')).toHaveCount(0)
  await page.getByRole('button', { name: /^Save/ }).click()
  await expect.poll(async () => (await call('GET', `/api/routines/${id}`)).job.executor.config.target).toBe(open)
  await expect(row.locator('.routine-task-title')).toHaveText(`Pick open target ${tag}`)
  // After the save the edited row is open and in view.
  await expect(row.locator('.routine-row-main')).toBeInViewport()
})

// A changed form asks before it closes; an unchanged one just closes.
test('closing a changed Edit form asks first', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task('Discard watcher', `Discard ${tag}`)
  const id = await routine(`Discard one ${tag}`, t)
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.routine-row-main').click()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(form).toHaveCount(0)

  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  await form.locator('input').first().fill(`Discard renamed ${tag}`)
  await page.keyboard.press('Escape')
  const ask = page.getByRole('dialog', { name: 'Discard changes?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Keep editing' }).click()
  await expect(form.locator('input').first()).toHaveValue(`Discard renamed ${tag}`)
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard changes' }).click()
  await expect(form).toHaveCount(0)
  expect((await call('GET', `/api/routines/${id}`)).job.name).toBe(`Discard one ${tag}`)
  // Discarded means gone: the next Edit starts from the saved routine.
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(form.locator('input').first()).toHaveValue(`Discard one ${tag}`)
})

// Open task and Back: the row that was open is open again, in view, even far down a long list.
test('Back from a routine\'s task finds its row open again', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task('Back watcher', `Back ${tag}`)
  for (let i = 0; i < 14; i++) await routine(`Back filler ${String(i).padStart(2, '0')} ${tag}`, t)
  const id = await routine(`Back zz last ${tag}`, t)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.routine-row-main').click()
  await row.getByRole('button', { name: 'Open task', exact: true }).click()
  await expect(page).not.toHaveURL(/\/routines/)
  await page.goBack()
  await expect(row.locator('.routine-detail')).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.routine-row-main')).toBeInViewport()
})

// Another tab saved the routine after this form opened: the older form does not
// silently undo it; the person's edits stay, and a second Save replaces it on purpose.
test('an Edit form opened before another save says so instead of overwriting it', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task('Stale watcher', `Stale ${tag}`)
  const id = await routine(`Stale one ${tag}`, t)
  await page.goto('/routines')
  const row = page.locator(`li.routine-row[data-routine-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.locator('.routine-row-main').click()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  // Elsewhere: a new prompt is saved.
  await call('PATCH', `/api/routines/${id}`, { executor: { type: 'session', config: { target: t, prompt: `Saved elsewhere ${tag}` } } })
  await form.locator('#routine-name').fill(`Stale renamed ${tag}`)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  const said = form.locator('.routine-save-error')
  await expect(said).toContainText('changed elsewhere after you opened it')
  await expect(said).toContainText('what it runs')
  await expect(said).toBeInViewport()
  await expect(form.locator('#routine-name')).toHaveValue(`Stale renamed ${tag}`)
  expect((await call('GET', `/api/routines/${id}`)).job.name).toBe(`Stale one ${tag}`)
  // Saving again is the person's choice to replace it.
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect.poll(async () => (await call('GET', `/api/routines/${id}`)).job.name).toBe(`Stale renamed ${tag}`)
})

// Switching to Session keeps what was typed as its Prompt; an empty one is said under it.
test('switching to Session carries the instructions over and an empty Prompt is said under it', async ({ page }) => {
  const tag = Math.random().toString(36).slice(2, 7)
  const t = await task(`Carry target ${tag}`, `Carry ${tag}`)
  await page.goto('/routines')
  const form = await openManualRoutineForm(page)
  await form.locator('#routine-name').fill(`Carry one ${tag}`)
  await form.locator('#routine-f-instructions').fill(`Sum up ${tag}`)
  await form.locator('label.cron-form-radio', { hasText: /^Session$/ }).locator('input').check()
  const prompt = form.locator('#routine-f-prompt')
  await expect(prompt).toHaveValue(`Sum up ${tag}`)
  await form.getByRole('searchbox', { name: 'Find an open task by its title' }).fill(`Carry target ${tag}`)
  await form.getByTestId('routine-task-hits').getByRole('button', { name: new RegExp(`Carry target ${tag}`) }).click()
  await prompt.fill('')
  await form.getByRole('button', { name: 'Create', exact: true }).click()
  const said = form.locator('.routine-field-error')
  await expect(said).toContainText('Prompt is required')
  await expect(prompt).toBeFocused()
  await expect(prompt).toBeInViewport()
  await prompt.fill(`Sum up ${tag}`)
  await expect(said).toHaveCount(0)
  await form.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(form).toHaveCount(0)
  const { jobs } = await call('GET', '/api/routines?includeDisabled=true')
  const made1 = jobs.find((j: any) => j.name === `Carry one ${tag}`)
  made.push(made1.id)
  expect(made1.executor).toMatchObject({ type: 'session', config: { target: t, prompt: `Sum up ${tag}` } })
})

// A draft the model could not make leaves the typed words in the form, not only in the box.
test('a failed AI draft opens the form with the typed words as its instructions', async ({ page }) => {
  await page.route('**/api/routines/draft', (r) => r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'No model answered' }) }))
  await page.goto('/routines')
  const composer = await openRoutineComposer(page)
  await composer.locator('textarea').fill('Every Friday, list what moved this week')
  await composer.getByRole('button', { name: /Draft/ }).click()
  await expect(composer.locator('.cron-form-error')).toContainText('Your words are in the form')
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  await expect(form.locator('#routine-f-instructions')).toHaveValue('Every Friday, list what moved this week')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(form).toHaveCount(0)
})
