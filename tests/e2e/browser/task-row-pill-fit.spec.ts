/**
 * A crowded task row folds its pills to one letter so the title keeps room.
 *
 * User report 2026-10-05: on a narrow column a row with a ticket tag, WORKER and
 * `TRIGGER ×2 · 1 PAUSED` squeezed the title down to "O…" or nothing. Rules pinned here:
 *   - the TRIGGER pill reads TRIGGER, never a count or PAUSED; it is dashed only when
 *     every trigger on the task is off, solid while any still polls;
 *   - in a tight column (< 420px) a row with two pills, or a tag beside a pill, draws
 *     W / T / L / C and no Leader count; a lone pill keeps its word;
 *   - a roomy column keeps every word (and the Leader count);
 *   - the crowded flag follows pills that arrive or leave after the row drew (WebKit
 *     restyled unreliably when it hung off `:has()`, see row-pill-fit.css);
 *   - the title keeps real room in the crowded row;
 *   - widening or narrowing the column flips the rows live, no reload.
 * Both surfaces: the Focus/pinned card and the list row.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOT_DIR = '/tmp/task-row-pill-fit'
const TAGS = ['ticket:V2393257840', 'sev:2']
const litter: { tasks: string[]; routines: string[] } = { tasks: [], routines: [] }

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', pinned: false, ...opts }),
  })
  if (!res.ok) throw new Error(`create ${title} failed: ${res.status} ${await res.text()}`)
  const { task } = await res.json() as { task: { id: string } }
  litter.tasks.push(task.id)
  return task.id
}

async function armTrigger(taskId: string, name: string, enabled = true): Promise<void> {
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: `echo '{"fire": false}'`, host: '__local__' },
      executor: { type: 'session', config: { target: taskId, prompt: 'Read the new items.' } },
      enabled,
    }),
  })
  if (!res.ok) throw new Error(`trigger create failed: ${res.status} ${await res.text()}`)
  litter.routines.push(((await res.json()) as { job: { id: string } }).job.id)
}

const card = (page: Page, id: string) =>
  page.locator(`.todo-pinned-card[data-task-id="${id}"], .todo-focus-card[data-task-id="${id}"]`).first()
const listRow = (page: Page, id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"]`).first()

async function setColumnWidth(page: Page, width: number | null) {
  await page.locator('#home-task-navigation').evaluate((el, w) => {
    (el as HTMLElement).style.width = w === null ? '' : `${w}px`
  }, width)
}

/** What one pill looks like: the word is drawn, or the letter is. */
async function pillLook(host: Locator, testId: string) {
  return host.getByTestId(testId).first().evaluate((el) => {
    const long = el.querySelector('.task-pill-long') as HTMLElement
    const letter = getComputedStyle(el, '::after').content.replace(/^"|"$/g, '')
    return {
      text: el.textContent?.trim() ?? '',
      wordDrawn: getComputedStyle(long).display !== 'none',
      letter: letter === 'none' || letter === 'normal' ? '' : letter,
      fontSize: getComputedStyle(el).fontSize,
      borderStyle: getComputedStyle(el).borderTopStyle,
      width: el.getBoundingClientRect().width,
    }
  })
}

/** Pins the fit the observer last set, to compare the same row drawn both ways in one column. */
async function forceFit(page: Page, fit: 'tight' | 'roomy') {
  await page.locator('.home-navigation-scroll').first().evaluate((el, v) => { (el as HTMLElement).dataset.rowFit = v }, fit)
}

async function titleWidth(host: Locator): Promise<number> {
  return host.locator('.todo-item-title, .todo-pinned-title').first().evaluate((el) => el.getBoundingClientRect().width)
}

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.routines = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.routines) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const id of [...litter.tasks].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

interface Fixture {
  lone: string; loneTrigger: string; tagWorker: string; workerTrigger: string
  tagWorkerTrigger: string; leaderTrigger: string; allPaused: string; mixedPaused: string
}

async function seed(project: string, stamp: string, pinned: boolean): Promise<Fixture> {
  const leader = await createTask(`Fit leader ${stamp}`, { project, pinned })
  const mk = (label: string, extra: Record<string, unknown> = {}) =>
    createTask(`Fit ${label} ${stamp}`, { project, pinned, ...extra })
  const lone = await mk('lone worker', { parent_task_id: leader })
  const loneTrigger = await mk('lone trigger')
  const tagWorker = await mk('tag worker', { parent_task_id: leader, tags: TAGS })
  const workerTrigger = await mk('worker trigger', { parent_task_id: leader })
  const tagWorkerTrigger = await mk('tag worker trigger', { parent_task_id: leader, tags: TAGS })
  const leaderTrigger = await mk('leader trigger')
  await createTask(`Fit sub of leaderTrigger ${stamp}`, { project, pinned, parent_task_id: leaderTrigger })
  await createTask(`Fit sub2 of leaderTrigger ${stamp}`, { project, pinned, parent_task_id: leaderTrigger })
  const allPaused = await mk('all paused', { parent_task_id: leader })
  const mixedPaused = await mk('mixed paused', { parent_task_id: leader })
  await armTrigger(loneTrigger, `fit ${stamp} lone`)
  await armTrigger(workerTrigger, `fit ${stamp} wt`)
  await armTrigger(tagWorkerTrigger, `fit ${stamp} twt`)
  await armTrigger(leaderTrigger, `fit ${stamp} lt`)
  await armTrigger(allPaused, `fit ${stamp} ap1`, false)
  await armTrigger(allPaused, `fit ${stamp} ap2`, false)
  await armTrigger(mixedPaused, `fit ${stamp} mp1`)
  await armTrigger(mixedPaused, `fit ${stamp} mp2`, false)
  return { lone, loneTrigger, tagWorker, workerTrigger, tagWorkerTrigger, leaderTrigger, allPaused, mixedPaused }
}

async function runSurface(page: Page, pick: (p: Page, id: string) => Locator, f: Fixture, shotName: string, browserName: string) {
  const row = (id: string) => pick(page, id)
  await expect(row(f.mixedPaused).getByTestId('task-trigger-pill')).toBeVisible({ timeout: 30_000 })
  await expect(row(f.leaderTrigger).getByTestId('leader-pill')).toBeVisible({ timeout: 30_000 })
  await expect(row(f.allPaused).getByTestId('task-trigger-pill')).toBeVisible({ timeout: 30_000 })
  for (const id of [f.loneTrigger, f.workerTrigger, f.tagWorkerTrigger]) {
    await expect(row(id).getByTestId('task-trigger-pill')).toBeVisible({ timeout: 30_000 })
  }

  // ── Tight column: 306px, the default narrow Home column.
  await setColumnWidth(page, 306)
  await expect(page.locator('.home-navigation-scroll').first()).toHaveAttribute('data-row-fit', 'tight')

  // A lone pill keeps its word.
  expect(await pillLook(row(f.lone), 'subtask-pill'), 'lone Worker @306').toMatchObject({ text: 'Worker', wordDrawn: true, letter: '', fontSize: '10px' })
  expect(await pillLook(row(f.loneTrigger), 'task-trigger-pill'), 'lone TRIGGER @306').toMatchObject({ text: 'TRIGGER', wordDrawn: true, letter: '' })

  // Tag + Worker: letters, the title keeps room.
  expect(await pillLook(row(f.tagWorker), 'subtask-pill'), 'tag+Worker @306').toMatchObject({ wordDrawn: false, letter: 'W' })
  // Worker + TRIGGER: both letters.
  expect(await pillLook(row(f.workerTrigger), 'subtask-pill'), 'Worker @306 beside TRIGGER').toMatchObject({ wordDrawn: false, letter: 'W' })
  expect(await pillLook(row(f.workerTrigger), 'task-trigger-pill'), 'TRIGGER @306 beside Worker').toMatchObject({ wordDrawn: false, letter: 'T', text: 'TRIGGER' })
  // Tag + Worker + TRIGGER: the row from the report.
  expect(await pillLook(row(f.tagWorkerTrigger), 'task-trigger-pill')).toMatchObject({ wordDrawn: false, letter: 'T' })
  expect(await pillLook(row(f.tagWorkerTrigger), 'subtask-pill')).toMatchObject({ wordDrawn: false, letter: 'W' })
  // Leader + TRIGGER: L with no count, the count stays in the DOM text and the hover text.
  const leaderLook = await pillLook(row(f.leaderTrigger), 'leader-pill')
  expect(leaderLook, 'Leader @306 beside TRIGGER').toMatchObject({ wordDrawn: false, letter: 'L' })
  expect(leaderLook.text).toMatch(/^Leader · \d+$/)
  expect(leaderLook.width, 'a letter pill is small').toBeLessThan(30)

  // The title gets the room the words used to take (it was squeezed to nothing).
  const foldedTitle = await titleWidth(row(f.tagWorkerTrigger))
  await forceFit(page, 'roomy')
  const wordyTitle = await titleWidth(row(f.tagWorkerTrigger))
  await forceFit(page, 'tight')
  console.log(`[pill-fit] ${shotName} title width on tag+Worker+TRIGGER @306: folded ${foldedTitle}, words ${wordyTitle}`)
  expect(foldedTitle - wordyTitle, 'folding the pills gives the title room').toBeGreaterThan(25)

  // Dashed only when EVERY trigger is off; solid while any polls; never a count or PAUSED.
  const paused = await pillLook(row(f.allPaused), 'task-trigger-pill')
  expect(paused, 'all-paused TRIGGER').toMatchObject({ text: 'TRIGGER', borderStyle: 'dashed' })
  await expect(row(f.allPaused).getByTestId('task-trigger-pill')).toHaveAttribute('data-paused', 'true')
  const mixed = await pillLook(row(f.mixedPaused), 'task-trigger-pill')
  expect(mixed, 'one armed, one paused: solid').toMatchObject({ text: 'TRIGGER', borderStyle: 'solid' })
  await expect(row(f.mixedPaused).getByTestId('task-trigger-pill')).not.toHaveAttribute('data-paused', 'true')
  await expect(row(f.mixedPaused).getByTestId('task-trigger-pill')).toHaveAttribute('data-trigger-count', '2')

  await fs.mkdir(SHOT_DIR, { recursive: true })
  await row(f.tagWorkerTrigger).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-tight.png` })
  await row(f.allPaused).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-paused-tight.png` })
  await row(f.leaderTrigger).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-leader-tight.png` })

  // ── Widening flips the rows live: every word is back, the Leader count too.
  await setColumnWidth(page, 640)
  await expect(page.locator('.home-navigation-scroll').first()).toHaveAttribute('data-row-fit', 'roomy')
  expect(await pillLook(row(f.tagWorkerTrigger), 'subtask-pill'), 'Worker @640').toMatchObject({ text: 'Worker', wordDrawn: true, letter: '' })
  expect(await pillLook(row(f.tagWorkerTrigger), 'task-trigger-pill'), 'TRIGGER @640').toMatchObject({ text: 'TRIGGER', wordDrawn: true, letter: '' })
  expect(await pillLook(row(f.leaderTrigger), 'leader-pill'), 'Leader @640').toMatchObject({ wordDrawn: true, letter: '' })
  expect((await pillLook(row(f.leaderTrigger), 'leader-pill')).text).toMatch(/^Leader · \d+$/)
  await row(f.tagWorkerTrigger).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-roomy.png` })

  // ── And narrowing again folds them again.
  await setColumnWidth(page, 306)
  await expect(page.locator('.home-navigation-scroll').first()).toHaveAttribute('data-row-fit', 'tight')
  expect(await pillLook(row(f.tagWorkerTrigger), 'subtask-pill'), 'Worker back to W').toMatchObject({ wordDrawn: false, letter: 'W' })
  await setColumnWidth(page, null)
}

/** A trigger that arrives after the row drew folds the lone Worker to a letter, and its removal brings the word back. */
async function seedLate(project: string, stamp: string, pinned: boolean): Promise<string> {
  const leader = await createTask(`Late leader ${stamp}`, { project, pinned })
  return createTask(`Late worker ${stamp}`, { project, pinned, parent_task_id: leader })
}

async function runLateArrival(page: Page, pick: (p: Page, id: string) => Locator, worker: string, stamp: string) {
  const row = pick(page, worker)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await setColumnWidth(page, 306)
  await expect(row.getByTestId('subtask-pill')).toBeVisible()
  expect(await pillLook(row, 'subtask-pill'), 'lone Worker before the trigger').toMatchObject({ wordDrawn: true, letter: '' })

  await armTrigger(worker, `fit ${stamp} late`)
  const routineId = litter.routines[litter.routines.length - 1]!
  await expect(row.getByTestId('task-trigger-pill')).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await pillLook(row, 'subtask-pill')).letter, { message: 'Worker folds when the trigger arrives' }).toBe('W')
  expect(await pillLook(row, 'subtask-pill')).toMatchObject({ wordDrawn: false })
  expect(await pillLook(row, 'task-trigger-pill')).toMatchObject({ wordDrawn: false, letter: 'T' })

  await fetch(`${API}/api/routines/${routineId}`, { method: 'DELETE' })
  litter.routines = litter.routines.filter((id) => id !== routineId)
  await expect(row.getByTestId('task-trigger-pill')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => (await pillLook(row, 'subtask-pill')).wordDrawn, { message: 'Worker gets its word back' }).toBe(true)
  expect(await pillLook(row, 'subtask-pill')).toMatchObject({ letter: '' })
  await setColumnWidth(page, null)
}

test('pinned cards fold crowded pills to W / T / L and keep the title room', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Pill fit cards ${stamp}`
  const f = await seed(project, stamp, true)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await expect(card(page, f.tagWorkerTrigger)).toBeVisible({ timeout: 90_000 })
  await runSurface(page, card, f, 'card', browserName)
})

test('list rows fold crowded pills to W / T / L and keep the title room', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Pill fit rows ${stamp}`
  const f = await seed(project, stamp, false)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await expect(listRow(page, f.tagWorkerTrigger)).toBeVisible({ timeout: 90_000 })
  await runSurface(page, listRow, f, 'row', browserName)
})

test('a trigger arriving or leaving later folds and unfolds the Worker on a card', async ({ page }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const worker = await seedLate(`Pill fit late cards ${stamp}`, stamp, true)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await runLateArrival(page, card, worker, stamp)
})

test('a trigger arriving or leaving later folds and unfolds the Worker on a list row', async ({ page }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const worker = await seedLate(`Pill fit late rows ${stamp}`, stamp, false)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await runLateArrival(page, listRow, worker, stamp)
})
