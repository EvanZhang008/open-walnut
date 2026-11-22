/**
 * A tight task column draws every pill after a title as one letter, so titles keep room.
 *
 * User reports 2026-10-05: on a narrow column a row with a ticket tag, WORKER and
 * `TRIGGER ×2 · 1 PAUSED` squeezed the title down to "O…" or nothing; then, once crowded
 * rows folded, a row whose only pill kept "WORKER" or "TRIGGER" still cut its title and
 * the column read as a mix of words and letters. Rules pinned here:
 *   - the TRIGGER pill reads TRIGGER, never a count or PAUSED; it is dashed only when
 *     every trigger on the task is off, a plain label while any still polls;
 *   - in a tight column (< 420px) EVERY pill draws W / T / L / C and no Leader count,
 *     a lone one included;
 *   - a roomy column keeps every word (and the Leader count);
 *   - a pill that arrives after the row drew (the triggers load late) is a letter at once;
 *   - folding gives the title real room, and a card's pills never squeeze its title: they go under it;
 *   - widening or narrowing the column flips the rows live, no reload;
 *   - the Worker pill names its leader after the word or letter (2026-11-11: "W · leader"),
 *     in both column widths.
 * Both surfaces: the Focus/pinned card and the list row.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
// PILL_FIT_SHOTS keeps the pictures past the run (a container's /tmp ends with it).
const SHOT_DIR = process.env.PILL_FIT_SHOTS ?? '/tmp/task-row-pill-fit'
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
    // The Worker pill also carries its leader's title after the word.
    const parent = el.querySelector('[data-testid="worker-parent-title"]') as HTMLElement | null
    return {
      text: (el.textContent ?? '').replace(parent?.textContent ?? '', '').trim(),
      // Drawn: not hidden, and on the pill's one line (a title too narrow wraps out of sight).
      parent: parent && getComputedStyle(parent).display !== 'none'
        && parent.getBoundingClientRect().top < el.getBoundingClientRect().bottom - 2 ? parent.textContent?.trim() ?? '' : '',
      wordDrawn: getComputedStyle(long).display !== 'none',
      letter: letter === 'none' || letter === 'normal' ? '' : letter,
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
  leaderTitle: string
}

async function seed(project: string, stamp: string, pinned: boolean): Promise<Fixture> {
  const leaderTitle = `Fit leader ${stamp}`
  const leader = await createTask(leaderTitle, { project, pinned })
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
  return { lone, loneTrigger, tagWorker, workerTrigger, tagWorkerTrigger, leaderTrigger, allPaused, mixedPaused, leaderTitle }
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

  // A lone pill is a letter too: the whole column folds, never row by row.
  expect(await pillLook(row(f.lone), 'subtask-pill'), 'lone Worker @306').toMatchObject({ text: 'Worker', parent: f.leaderTitle, wordDrawn: false, letter: 'W' })
  expect(await pillLook(row(f.loneTrigger), 'task-trigger-pill'), 'lone TRIGGER @306').toMatchObject({ text: 'Trigger', wordDrawn: false, letter: 'T' })

  // Every pill the column draws, seeded or not, is a letter with its word hidden. A pull request
  // pill (PrPill.tsx) folds to its own parts instead ("#12 Failed"), drawn in place of the letter.
  const column = await page.locator('.home-navigation-scroll').first().evaluate((scroller) => {
    const pills = [...scroller.querySelectorAll('.task-row-pill[data-short]')]
    return pills.map((el) => {
      const parts = el.querySelector('.pr-pill-short')
      return {
        short: el.getAttribute('data-short'),
        letter: parts
          ? (getComputedStyle(parts).display !== 'none' && getComputedStyle(el, '::after').content === 'none' ? el.getAttribute('data-short') : 'parts hidden')
          : getComputedStyle(el, '::after').content.replace(/^"|"$/g, ''),
        wordHidden: getComputedStyle(el.querySelector('.task-pill-long')!).display === 'none',
      }
    })
  })
  expect(column.length, 'pills in the column').toBeGreaterThan(10)
  for (const p of column) expect(p, 'every pill in a tight column').toEqual({ short: p.short, letter: p.short, wordHidden: true })

  // Tag + Worker: letters, the title keeps room.
  expect(await pillLook(row(f.tagWorker), 'subtask-pill'), 'tag+Worker @306').toMatchObject({ wordDrawn: false, letter: 'W' })
  // Worker + TRIGGER: both letters.
  expect(await pillLook(row(f.workerTrigger), 'subtask-pill'), 'Worker @306 beside TRIGGER').toMatchObject({ wordDrawn: false, letter: 'W' })
  expect(await pillLook(row(f.workerTrigger), 'task-trigger-pill'), 'TRIGGER @306 beside Worker').toMatchObject({ wordDrawn: false, letter: 'T', text: 'Trigger' })
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
  if (shotName === 'row') {
    const available = await row(f.tagWorkerTrigger).locator('.todo-item-title-row').evaluate((el) => {
      const style = getComputedStyle(el)
      return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    })
    expect(foldedTitle, 'wrapped metadata leaves the whole content width for the title').toBeGreaterThanOrEqual(available - 2)
    expect(Math.abs(foldedTitle - wordyTitle), 'metadata labels never squeeze the title').toBeLessThan(2)
  } else {
    // A card follows the list row's rule (2026-11-22: its pills kept their room beside the title and
    // squeezed it to a 70 px column of five lines): the title takes its own width up to the whole
    // line, and the pills that do not fit beside it go under it, on the right edge where a one-line
    // card shows them.
    const fit = await row(f.tagWorkerTrigger).evaluate((card) => {
      const title = card.querySelector('.todo-pinned-title') as HTMLElement
      const cs = getComputedStyle(card)
      const available = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const contentRight = card.getBoundingClientRect().left + card.clientLeft + card.clientWidth - parseFloat(cs.paddingRight)
      const t = title.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(title)
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size
      const pills = [...card.querySelectorAll(':scope > .task-row-pill, :scope > .task-tag-pills')].map((e) => e.getBoundingClientRect())
      const under = pills.filter((p) => p.top >= t.bottom - 2)
      return {
        available, width: t.width, lines,
        besideOverTitle: pills.filter((p) => p.top < t.bottom - 2 && p.left < t.right - 1).length,
        under: under.length,
        underRight: under.length ? Math.max(...under.map((p) => p.right)) - contentRight : 0,
      }
    })
    expect(fit.lines === 1 || fit.width >= fit.available - 2, `the title keeps its own width or the whole line (${JSON.stringify(fit)})`).toBe(true)
    expect(fit.besideOverTitle, 'no pill sits inside the title\'s line box').toBe(0)
    expect(fit.under, 'at 306px the pills go under the title').toBeGreaterThan(0)
    expect(Math.abs(fit.underRight), 'the pills under the title keep to the right edge').toBeLessThan(1.5)
    expect(Math.abs(foldedTitle - wordyTitle), 'metadata labels never squeeze the title').toBeLessThan(2)
  }

  // Dashed only when EVERY trigger is off; a plain filled label (no dashes) while any polls;
  // never a count or PAUSED.
  const paused = await pillLook(row(f.allPaused), 'task-trigger-pill')
  expect(paused, 'all-paused TRIGGER').toMatchObject({ text: 'Trigger', borderStyle: 'dashed' })
  await expect(row(f.allPaused).getByTestId('task-trigger-pill')).toHaveAttribute('data-paused', 'true')
  const mixed = await pillLook(row(f.mixedPaused), 'task-trigger-pill')
  expect(mixed, 'one armed, one paused: not dashed').toMatchObject({ text: 'Trigger' })
  expect(mixed.borderStyle, 'one armed, one paused: not dashed').not.toBe('dashed')
  await expect(row(f.mixedPaused).getByTestId('task-trigger-pill')).not.toHaveAttribute('data-paused', 'true')
  await expect(row(f.mixedPaused).getByTestId('task-trigger-pill')).toHaveAttribute('data-trigger-count', '2')

  await fs.mkdir(SHOT_DIR, { recursive: true })
  await row(f.tagWorkerTrigger).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-tight.png` })
  await row(f.allPaused).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-paused-tight.png` })
  await row(f.leaderTrigger).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-leader-tight.png` })
  await page.locator('.home-navigation-scroll').first().screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-column-tight.png` })

  // ── Widening flips the rows live: every word is back, the Leader count too.
  await setColumnWidth(page, 640)
  await expect(page.locator('.home-navigation-scroll').first()).toHaveAttribute('data-row-fit', 'roomy')
  expect(await pillLook(row(f.tagWorkerTrigger), 'subtask-pill'), 'Worker @640').toMatchObject({ text: 'Worker', parent: f.leaderTitle, wordDrawn: true, letter: '' })
  expect(await pillLook(row(f.tagWorkerTrigger), 'task-trigger-pill'), 'TRIGGER @640').toMatchObject({ text: 'Trigger', wordDrawn: true, letter: '' })
  expect(await pillLook(row(f.leaderTrigger), 'leader-pill'), 'Leader @640').toMatchObject({ wordDrawn: true, letter: '' })
  expect((await pillLook(row(f.leaderTrigger), 'leader-pill')).text).toMatch(/^Leader · \d+$/)
  await row(f.tagWorkerTrigger).screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-roomy.png` })

  // ── And narrowing again folds them again.
  await setColumnWidth(page, 306)
  await expect(page.locator('.home-navigation-scroll').first()).toHaveAttribute('data-row-fit', 'tight')
  expect(await pillLook(row(f.tagWorkerTrigger), 'subtask-pill'), 'Worker back to W').toMatchObject({ wordDrawn: false, letter: 'W' })
  await setColumnWidth(page, null)
  await page.locator('.home-navigation-scroll').first().screenshot({ path: `${SHOT_DIR}/${browserName}-${shotName}-column-default.png` })
}

/** A trigger that arrives after the row drew is a letter at once; it leaves without touching its neighbour. */
async function seedLate(project: string, stamp: string, pinned: boolean): Promise<string> {
  const leader = await createTask(`Late leader ${stamp}`, { project, pinned })
  return createTask(`Late worker ${stamp}`, { project, pinned, parent_task_id: leader })
}

async function runLateArrival(page: Page, pick: (p: Page, id: string) => Locator, worker: string, stamp: string) {
  const row = pick(page, worker)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await setColumnWidth(page, 306)
  await expect(row.getByTestId('subtask-pill')).toBeVisible()
  expect(await pillLook(row, 'subtask-pill'), 'lone Worker before the trigger').toMatchObject({ wordDrawn: false, letter: 'W' })

  await armTrigger(worker, `fit ${stamp} late`)
  const routineId = litter.routines[litter.routines.length - 1]!
  await expect(row.getByTestId('task-trigger-pill')).toBeVisible({ timeout: 30_000 })
  expect(await pillLook(row, 'task-trigger-pill'), 'late TRIGGER').toMatchObject({ wordDrawn: false, letter: 'T' })
  expect(await pillLook(row, 'subtask-pill'), 'Worker beside the late trigger').toMatchObject({ wordDrawn: false, letter: 'W' })

  await fetch(`${API}/api/routines/${routineId}`, { method: 'DELETE' })
  litter.routines = litter.routines.filter((id) => id !== routineId)
  await expect(row.getByTestId('task-trigger-pill')).toHaveCount(0, { timeout: 30_000 })
  expect(await pillLook(row, 'subtask-pill'), 'Worker after the trigger left').toMatchObject({ wordDrawn: false, letter: 'W' })

  // Widen: the word comes back, with no reload.
  await setColumnWidth(page, 640)
  await expect.poll(async () => (await pillLook(row, 'subtask-pill')).wordDrawn, { message: 'Worker word in a roomy column' }).toBe(true)
  expect(await pillLook(row, 'subtask-pill')).toMatchObject({ letter: '' })
  await setColumnWidth(page, null)
}

test('pinned cards draw every pill as W / T / L in a tight column and keep the title room', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Pill fit cards ${stamp}`
  const f = await seed(project, stamp, true)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await expect(card(page, f.tagWorkerTrigger)).toBeVisible({ timeout: 90_000 })
  await runSurface(page, card, f, 'card', browserName)
})

test('list rows draw every pill as W / T / L in a tight column and keep the title room', async ({ page, browserName }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Pill fit rows ${stamp}`
  const f = await seed(project, stamp, false)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript((ids) => { localStorage.setItem('walnut-todo-expanded-parents', JSON.stringify(ids)) }, [...litter.tasks])
  await openHome(page, `${API}/`)
  await expect(listRow(page, f.tagWorkerTrigger)).toBeVisible({ timeout: 90_000 })
  await runSurface(page, listRow, f, 'row', browserName)
})

test('a trigger arriving or leaving later is a letter at once on a card', async ({ page }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const worker = await seedLate(`Pill fit late cards ${stamp}`, stamp, true)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await runLateArrival(page, card, worker, stamp)
})

test('a trigger arriving or leaving later is a letter at once on a list row', async ({ page }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const worker = await seedLate(`Pill fit late rows ${stamp}`, stamp, false)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript((ids) => { localStorage.setItem('walnut-todo-expanded-parents', JSON.stringify(ids)) }, [...litter.tasks])
  await openHome(page, `${API}/`)
  await runLateArrival(page, listRow, worker, stamp)
})

/**
 * Every row on the page, seeded or not: no Worker pill shows its leader's title cut to a sliver
 * ("W H…" read as initials), and no line of words starts with a lone "·" where it wrapped
 * (2026-11-22 UI audit at 820 px). Checks the whole column, so a new pill or label is held too.
 */
async function slivers(page: Page) {
  return page.locator('.home-navigation-scroll').first().evaluate((scroller) => {
    const cut: string[] = []
    for (const e of scroller.querySelectorAll<HTMLElement>('[data-testid="worker-parent-title"]')) {
      const pill = e.parentElement!.getBoundingClientRect(), b = e.getBoundingClientRect()
      const shown = Math.min(b.right, pill.right) - b.left
      // Squeezed to nothing is a sliver too: the label's gap still shows ("W  · L").
      const drawn = getComputedStyle(e).display !== 'none' && b.top < pill.bottom - 2
      const sixLetters = parseFloat(getComputedStyle(e).fontSize) * 3
      if (drawn && shown < sixLetters && e.scrollWidth > e.clientWidth + 1) cut.push(`${Math.round(shown)}px ${e.textContent}`)
    }
    const strayDots: string[] = [], offEdge: string[] = []
    for (const row of scroller.querySelectorAll<HTMLElement>('.todo-item-content[data-search-meta]')) {
      const items = [...row.querySelectorAll<HTMLElement>(':scope > .todo-search-meta-row, :scope > .todo-item-title-row > :is(.badge, .task-tag-pills, .todo-item-limit-pill)')]
        .map((e) => { const b = e.getBoundingClientRect(); return { e, mid: b.top + b.height / 2, left: b.left, w: b.width } })
        .filter((x) => x.w > 0)
        .sort((a, b) => (Math.abs(a.mid - b.mid) > 8 ? a.mid - b.mid : a.left - b.left))
      for (let k = 1; k < items.length; k++) {
        if (items[k].mid <= items[k - 1].mid + 8) continue
        const dot = getComputedStyle(items[k].e, '::before')
        if (dot.content.includes('\u00b7') && dot.visibility !== 'hidden') strayDots.push(items[k].e.textContent ?? '')
        // The wrapped line's words start at the line above's edge: the hidden dot's room is taken back.
        const room = dot.content.includes('\u00b7') ? parseFloat(dot.width) + parseFloat(dot.marginRight) + (parseFloat(getComputedStyle(items[k].e).columnGap) || 0) : 0
        if (Math.abs(items[k].left + room - items[0].left) > 3) offEdge.push(`${Math.round(items[k].left + room - items[0].left)}px ${items[k].e.textContent}`)
      }
    }
    // Only names give up letters (the project, a Worker's leader title): a kind, a tag, a state and
    // a time on the line are whole.
    const cutWords: string[] = []
    for (const el of scroller.querySelectorAll<HTMLElement>('.todo-item-content[data-search-meta] > .todo-item-title-row > :is(.badge, .task-tag-pills, .todo-item-limit-pill):not(.todo-item-subtask-pill)')) {
      const inner = [el, ...el.querySelectorAll<HTMLElement>('*')]
      if (el.getBoundingClientRect().width > 0 && inner.some((x) => x.scrollWidth > x.clientWidth + 1)) cutWords.push(el.textContent ?? '')
    }
    // A kind on this line reads as its word, never its letter ("T, W, L" read as nothing; 2026-11-22
    // audit at 1280 px): every pill that folds elsewhere (data-short), seeded or not.
    const letters: string[] = []
    for (const el of scroller.querySelectorAll<HTMLElement>('.todo-item-content[data-search-meta] .task-row-pill[data-short]:not(.pr-pill)')) {
      const word = el.querySelector<HTMLElement>(':scope > .task-pill-long')
      const after = getComputedStyle(el, '::after').content
      if (!word || getComputedStyle(word).display === 'none' || (after !== 'none' && after !== 'normal')) letters.push(`${el.dataset.short} ${el.textContent}`)
    }
    return { cut, strayDots, offEdge, cutWords, letters, rows: scroller.querySelectorAll('.todo-item-content[data-search-meta]').length }
  })
}

test('a narrow search column cuts only names, never to a sliver, keeps its kinds as words, and starts no line with "·"', async ({ page }) => {
  test.setTimeout(180_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const f = await seed(`Pill fit search ${stamp}`, stamp, false)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page, `${API}/`)
  await expect(listRow(page, f.tagWorkerTrigger)).toBeVisible({ timeout: 90_000 })
  await expect(listRow(page, f.tagWorkerTrigger).getByTestId('task-trigger-pill')).toBeVisible({ timeout: 30_000 })
  await page.locator('input[placeholder^="Search tasks"]').first().fill(stamp)
  await expect(page.locator(`.todo-search-results [data-task-id="${f.tagWorkerTrigger}"]`).first()).toBeVisible({ timeout: 30_000 })
  let wrappedSeen = false
  for (const width of [640, 306, 280, 260, 240, 220]) {
    await setColumnWidth(page, width)
    await page.waitForTimeout(250)
    const r = await slivers(page)
    expect(r.rows, `search rows @${width}`).toBeGreaterThan(5)
    expect(r.cut, `leader titles cut to a sliver @${width}`).toEqual([])
    expect(r.strayDots, `lines that start with "·" @${width}`).toEqual([])
    expect(r.offEdge, `wrapped lines off the line above's edge @${width}`).toEqual([])
    expect(r.cutWords, `kinds, tags, states or times cut @${width}`).toEqual([])
    expect(r.letters, `kinds drawn as letters @${width}`).toEqual([])
    wrappedSeen ||= await page.locator('.todo-search-results [data-line-start]').count() > 0
  }
  // The narrowest widths do wrap a crowded row: the check above judged real wrapped lines.
  expect(wrappedSeen, 'some row wrapped onto a third line').toBe(true)
  await page.locator('.home-navigation-scroll').first().screenshot({ path: `${SHOT_DIR}/search-narrow.png` })
  await setColumnWidth(page, null)
})
