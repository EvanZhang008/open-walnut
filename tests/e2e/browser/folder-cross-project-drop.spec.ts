/**
 * Playwright: dropping a task into a folder of ANOTHER project moves it there.
 *
 * User report (2026-09-28): dragging an Inbox task onto a task inside a folder of
 * a named project answered "Action failed: A folder belongs to one project … Move
 * the task first or pick same-project tasks", four drops in a row. A folder does
 * belong to one project, so the drop is a move: the task lands in that project
 * and in the folder, in one step.
 *
 * Every "into a folder" drop is driven with a real pointer drag (dnd-kit): in
 * the main list onto a folder member and onto an empty folder row (a loose card
 * there stays a plain move), and in a pinned tier onto a folder member (and onto
 * a loose card, a plain reorder there too). Each checks the lit drop target,
 * the server's record, and that no error toast appeared. A same-project drop is
 * still a plain join. Data is unique per run.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, openListProject, presetPanelView, selectSection } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/folder-cross-project-drop'

interface TaskRow { id: string; title: string; project?: string; group_id?: string }

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function createTask(title: string, project: string): Promise<TaskRow> {
  const { task } = await post<{ task: TaskRow }>('/api/tasks', { title, project, source: 'local', pinned: false })
  return task
}

async function serverTask(id: string): Promise<TaskRow> {
  const res = await fetch(`${API}/api/tasks/${id}`)
  return ((await res.json()) as { task: TaskRow }).task
}

function bucket(page: Page, project: string): Locator {
  const name = project || 'Inbox'
  return page.locator('.todo-group-project').filter({
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${name}$`) }),
  }).first()
}

function row(page: Page, project: string, id: string): Locator {
  return bucket(page, project).locator(`.todo-panel-item[data-task-id="${id}"]`).first()
}

/**
 * Press a row, pass the activation distance, and release over `target`'s LEFT
 * part (the "group" zone; the right third means "make it a subtask"). The target
 * rect is measured before the drag, since dnd-kit decides on the static layout.
 */
async function dragOnto(page: Page, from: Locator, target: Locator): Promise<string[]> {
  await from.scrollIntoViewIfNeeded()
  const fb = await from.boundingBox()
  const tb = await target.boundingBox()
  if (!fb || !tb) throw new Error('drag source or target not visible')
  // Both ends on screen, or the drag autoscrolls and lands on whatever row is
  // under the pointer by then (a plain move into a third project).
  const vh = page.viewportSize()?.height ?? 0
  for (const [what, b] of [['source', fb], ['target', tb]] as const) {
    if (b.y < 0 || b.y + b.height > vh) throw new Error(`drag ${what} is off screen (y=${b.y}, viewport ${vh})`)
  }
  const sx = fb.x + fb.width * 0.3
  const sy = fb.y + fb.height / 2
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx, sy + 10, { steps: 3 })
  const tx = tb.x + tb.width * 0.25
  const ty = tb.y + tb.height / 2
  await page.mouse.move(tx, ty, { steps: 14 })
  await page.waitForTimeout(350)
  // What a user waits for before letting go: the row lit as the drop target.
  // Like a user, nudge the pointer a little while nothing is lit yet.
  const litNow = () => page.locator('.todo-panel-item-group-target, .task-group-chip-drop')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-task-id') ?? el.getAttribute('data-group-id') ?? '?'))
  let lit = await litNow()
  for (let i = 0; i < 6 && lit.length === 0; i++) {
    await page.mouse.move(tx, ty + (i % 2 ? 2 : -2))
    await page.waitForTimeout(250)
    lit = await litNow()
  }
  await page.mouse.up()
  return lit
}

async function expectNoErrorToast(page: Page): Promise<void> {
  await page.waitForTimeout(800)
  await expect(page.getByText('Action failed')).toHaveCount(0)
  await expect(page.getByText(/A folder belongs to one project/)).toHaveCount(0)
}

async function seed() {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `DropProj${stamp}`
  const lead = await createTask(`Folder lead ${stamp}`, project)
  const second = await createTask(`Folder second ${stamp}`, project)
  const loose = await createTask(`Loose card ${stamp}`, project)
  const sibling = await createTask(`Same project ${stamp}`, project)
  const folder = await post<{ group_id: string }>('/api/tasks/groups', {
    task_ids: [lead.id, second.id], label: `Pipelines ${stamp}`,
  })
  const empty = await post<{ group_id: string }>('/api/tasks/folders', { label: `Empty ${stamp}`, project })
  const inbox = [
    await createTask(`Open pipeline ${stamp}`, ''),
    await createTask(`Second inbox ${stamp}`, ''),
    await createTask(`Third inbox ${stamp}`, ''),
  ]
  return { stamp, project, lead, loose, sibling, folder: folder.group_id, empty: empty.group_id, inbox }
}

// Tall enough that the destination project and Inbox (always last) are on
// screen together once every other project is folded (see openOnly).
test.use({ viewport: { width: 1280, height: 1100 } })

/** Open only `project` and Inbox in the list, so both fit on one screen. */
async function openOnly(page: Page, project: string): Promise<void> {
  await page.addInitScript((p) => {
    try { localStorage.setItem('walnut-todo-list-opened', JSON.stringify([p, ''])) } catch { /* storage off */ }
  }, project)
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ }
  })
})

test('an Inbox task dropped into another project’s folder moves there and joins it', async ({ page }) => {
  test.setTimeout(90_000) // four drags and a reload, on a loaded shared machine
  const s = await seed()
  await openOnly(page, s.project)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await openListProject(page, s.project)
  await openListProject(page, 'Inbox')

  // 1. Onto a folder member: the task moves to the project and joins that folder.
  const mover = s.inbox[0]
  await expect(row(page, '', mover.id)).toBeVisible()
  expect(await dragOnto(page, row(page, '', mover.id), row(page, s.project, s.lead.id))).toEqual([s.lead.id])
  await expect(row(page, s.project, mover.id)).toHaveAttribute('data-group-id', s.folder, { timeout: 10_000 })
  await expect(row(page, '', mover.id)).toHaveCount(0)
  await expectNoErrorToast(page)
  await expect.poll(async () => serverTask(mover.id)).toMatchObject({ project: s.project, group_id: s.folder })
  await bucket(page, s.project).screenshot({ path: `${SHOTS}/${test.info().project.name}-1-joined-folder.png` })

  // 2. Onto a LOOSE card: the main list keeps this a plain move (it has no
  // middle-band join test, so a loose card is never a folder target here). The
  // task lands in the card's project, beside it, with no error.
  const second = s.inbox[1]
  await dragOnto(page, row(page, '', second.id), row(page, s.project, s.loose.id))
  await expect.poll(async () => (await serverTask(second.id)).project, { timeout: 10_000 }).toBe(s.project)
  expect((await serverTask(second.id)).group_id).toBeUndefined()
  expect((await serverTask(s.loose.id)).group_id).toBeUndefined()
  await expect(row(page, s.project, second.id)).toBeVisible()
  await expectNoErrorToast(page)
  await bucket(page, s.project).screenshot({ path: `${SHOTS}/${test.info().project.name}-2-loose-card-plain-move.png` })

  // 3. Onto an empty folder row: the task is its first member.
  const third = s.inbox[2]
  const emptyRow = bucket(page, s.project).locator(`.task-group-chip-empty[data-group-id="${s.empty}"]`).first()
  await expect(emptyRow).toBeVisible()
  expect(await dragOnto(page, row(page, '', third.id), emptyRow)).toEqual([s.empty])
  await expect.poll(async () => serverTask(third.id), { timeout: 10_000 })
    .toMatchObject({ project: s.project, group_id: s.empty })
  await expect(row(page, s.project, third.id)).toHaveAttribute('data-group-id', s.empty, { timeout: 10_000 })
  await expectNoErrorToast(page)
  await bucket(page, s.project).screenshot({ path: `${SHOTS}/${test.info().project.name}-3-empty-folder.png` })

  // The moved rows survive a reload exactly where they were dropped.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await openListProject(page, s.project)
  await expect(row(page, s.project, mover.id)).toHaveAttribute('data-group-id', s.folder, { timeout: 15_000 })
  await expect(row(page, s.project, third.id)).toHaveAttribute('data-group-id', s.empty)
  await expect(row(page, s.project, second.id)).toBeVisible()
})

test('a same-project drop onto a folder member is still a plain join', async ({ page }) => {
  const s = await seed()
  await openOnly(page, s.project)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await openListProject(page, s.project)

  expect(await dragOnto(page, row(page, s.project, s.sibling.id), row(page, s.project, s.lead.id))).toEqual([s.lead.id])
  await expect.poll(async () => serverTask(s.sibling.id), { timeout: 10_000 })
    .toMatchObject({ project: s.project, group_id: s.folder })
  await expect(row(page, s.project, s.sibling.id)).toHaveAttribute('data-group-id', s.folder)
  await expectNoErrorToast(page)
})

// ── Pinned tiers ── The path behind three of the four refused drops in the
// report. Since 2026-10-01 a pinned card goes where its gap is: a gap inside a
// folder files it there (moving it into the folder's project), and a drop on a
// loose card is a plain reorder (a folder is made with Group, not by a drop).

const TIER_SCOPE = '.todo-pinned-section:not(.todo-pinned-section-recent)'

function tierCard(page: Page, id: string): Locator {
  return page.locator(`${TIER_SCOPE} [data-task-id="${id}"]`).first()
}

async function pinToFocus(id: string): Promise<void> {
  const p = await fetch(`${API}/api/focus/tasks/${id}`, { method: 'POST' })
  if (!p.ok) throw new Error(`pin failed: ${p.status}`)
  const t = await fetch(`${API}/api/focus/tasks/${id}/tier`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier: 'focus' }),
  })
  if (!t.ok) throw new Error(`tier failed: ${t.status}`)
}

/** Unpin everything first (as separator-group-and-unpin does): cards piled up by
 *  earlier specs push the targets into dnd-kit's autoscroll band. */
async function clearFocus(): Promise<void> {
  const split = await fetch(`${API}/api/focus/tasks`).then((r) => r.json())
  const ids = new Set<string>()
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v && typeof v === 'object') {
      const id = (v as { id?: unknown }).id
      if (typeof id === 'string') { ids.add(id); return }
      for (const val of Object.values(v)) walk(val)
      return
    }
    if (typeof v === 'string') ids.add(v)
  }
  walk(split)
  await Promise.all([...ids].map((id) => fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' })))
}

test('pinned tier: an Inbox card joins another project’s folder at its gap; on a loose card it only reorders', async ({ page }) => {
  test.setTimeout(90_000)
  await clearFocus()
  const s = await seed()
  const [first, second] = s.inbox
  for (const id of [s.loose.id, s.lead.id, first.id, second.id]) await pinToFocus(id)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await selectSection(page, 'Focus')
  await expect(tierCard(page, first.id)).toBeVisible({ timeout: 15_000 })

  // Onto the folder's card from below: the gap opens at the top of the folder, the
  // folder's row lights, and the card moves into that project and folder, first.
  expect(await dragOnto(page, tierCard(page, first.id), tierCard(page, s.lead.id))).toEqual([s.folder])
  await expect.poll(async () => serverTask(first.id), { timeout: 10_000 })
    .toMatchObject({ project: s.project, group_id: s.folder })
  await expect(tierCard(page, first.id)).toHaveAttribute('data-group-id', s.folder, { timeout: 10_000 })
  const drawn = () => page.locator(`${TIER_SCOPE} [data-task-id]`).evaluateAll((els, ids) =>
    els.map((e) => e.getAttribute('data-task-id')).filter((id) => ids.includes(id!)), [first.id, s.lead.id])
  await expect.poll(drawn, { timeout: 10_000 }).toEqual([first.id, s.lead.id])
  await expectNoErrorToast(page)
  await page.locator(TIER_SCOPE).first().screenshot({ path: `${SHOTS}/${test.info().project.name}-4-pinned-joined-folder.png` })

  // Onto a loose card of another project: nothing lights and no folder is made.
  expect(await dragOnto(page, tierCard(page, second.id), tierCard(page, s.loose.id))).toEqual([])
  await page.waitForTimeout(1000)
  expect((await serverTask(second.id)).group_id).toBeUndefined()
  expect((await serverTask(s.loose.id)).group_id).toBeUndefined()
  await expectNoErrorToast(page)
  await page.locator(TIER_SCOPE).first().screenshot({ path: `${SHOTS}/${test.info().project.name}-5-pinned-loose-reorder.png` })

  await Promise.all([s.loose.id, s.lead.id, first.id, second.id].map((id) => fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' })))
})
