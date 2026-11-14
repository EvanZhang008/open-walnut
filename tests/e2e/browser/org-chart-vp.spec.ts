/**
 * The org chart as a user meets it (web/src/components/org/OrgChartSheet.tsx, POST /api/v1/org/vp):
 *   - Main is the CEO; every project is a VP card with its own name, never a made-up "lead"
 *     name, and every card lists the projects its VP leads, its own included; closed, a card and
 *     its rows are their names alone; opened, a card says its news and counts and a project its
 *     counts and tasks, and both stay open across a reload
 *   - dragging one project onto another VP says what the drop does before it happens, asks
 *     first, and Cancel changes nothing; after Confirm that VP's card lists both projects,
 *     each still its own project (no task moved), and the VP that let go has stepped down
 *   - dragging it onto the drop zone creates a dedicated VP for it again; the move menu (in the
 *     opened project, or a right-click on it) does the same without a drag, and
 *     Escape closes the question before the sheet
 *   - a project opens to its tasks and where each stands; a task opens beside the Org page
 *   - a project under another VP is part of that VP's channel on the Org page, not one of its own
 *   - an opened card's Open chat opens its project on the Org page, on its chat (chat is the first tab)
 *   - a click outside the sheet closes it (the menu and the question close first)
 *   - a right-click on an Org row opens Walnut's menu, kept short: its tabs, "Move under another VP…"
 *     (a picker of VPs) and "Create a dedicated VP for X…", each asked in the chart first;
 *     "Archived" lists what moved
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

// Both browser projects load this file at about the same moment: the pid keeps them apart.
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const A = `Chart garden ${STAMP}`
const B = `Chart seeds ${STAMP}`
const made: string[] = []

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

interface OrgProject { project: string; vp?: string; lead?: { id: string; title: string }; contactId?: string }
const orgProjects = async (request: APIRequestContext): Promise<OrgProject[]> =>
  ((await (await request.get('/api/v1/org')).json()).tree as { projects: OrgProject[] }).projects
const project = async (request: APIRequestContext, name: string) => (await orgProjects(request)).find((p) => p.project === name)
const taskOf = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`/api/tasks/${id}`)).json()).task as { id: string; project?: string; phase: string; org_role?: string; org_leads?: string[] } | undefined

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function openChart(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await page.getByTestId('org-open-chart').click()
  const sheet = page.getByTestId('org-chart')
  await expect(sheet).toBeVisible()
  return sheet
}

const vp = (page: Page, name: string) => page.locator(`[data-testid="org-chart-vp"][data-project="${name}"]`)
const handle = (page: Page, name: string) => vp(page, name).getByTestId('org-chart-vp-handle')
const row = (page: Page, card: string, name: string) => vp(page, card).locator(`[data-testid="org-chart-project"][data-project="${name}"]`)

/** Open a card or a project row by its toggle (a click on its name). */
async function expand(toggle: Locator): Promise<void> {
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Drag with the mouse, so the card under the pointer can be read before the drop. */
async function dragOver(page: Page, from: Locator, to: Locator, { drags = true } = {}): Promise<void> {
  // The chart is the shared fixture's: another spec's new project adds a card while this one is
  // read (org-page.spec.ts makes its own), and the cards move. A press where `from` was a moment
  // before picked up the card that took its place (2026-11-10, CI: "takes over Org page beta"),
  // and a pointer sent where `to` was a moment before missed it (no hint). So the drag is checked
  // to be `from`'s, and the pointer to be over `to`, and each is tried again if not.
  const dragged = from.locator('xpath=ancestor-or-self::*[contains(concat(" ", normalize-space(@class), " "), " is-dragging ")]')
  for (let tries = 0; ; tries++) {
    await from.scrollIntoViewIfNeeded()
    const a = (await from.boundingBox())!
    await page.mouse.move(a.x + 20, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 4 })
    if (!drags) break
    // The chart draws the drag a task after it starts (OrgChartSheet onDragStart), and that render
    // moves the cards (the drop zone's words change): read the target's place once it is drawn as
    // a drop target.
    const started = await expect(dragged.first()).toBeAttached({ timeout: 5_000 }).then(() => true, () => false)
    if (started) break
    // Another card's drag, or none: let it go where it started (its own place drops nothing). A
    // drop that still landed on a VP asks first: that question is cancelled.
    await page.mouse.up()
    await expect(page.locator('.is-dragging')).toHaveCount(0)
    const asked = page.getByTestId('org-chart-confirm')
    if (await asked.isVisible()) {
      await asked.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(asked).toHaveCount(0)
    }
    if (tries >= 2) throw new Error('the drag never picked up the card it pressed')
  }
  if (!drags) {
    const b = (await to.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
    await page.mouse.move(b.x + b.width / 2 + 4, b.y + b.height / 2, { steps: 2 })
    return
  }
  await expect(to).toHaveClass(/\b(can-drop|is-active)\b/)
  await expect(async () => {
    const b = (await to.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
    await page.mouse.move(b.x + b.width / 2 + 4, b.y + b.height / 2, { steps: 2 })
    await expect(to).toHaveClass(/\bis-over\b/, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
}

test.beforeAll(async ({ request }) => {
  for (const [title, p] of [[`Water the beds ${STAMP}`, A], [`Fix the fence ${STAMP}`, A], [`Collect seeds ${STAMP}`, B], [`Label jars ${STAMP}`, B]] as const) {
    const res = await request.post('/api/tasks', { data: { title, project: p, source: 'local' } })
    expect(res.ok(), await res.text()).toBe(true)
    made.push(((await res.json()) as { task: { id: string } }).task.id)
  }
  // B's own VP exists already (never talked to); A's is made by the drop.
  const lead = await request.post('/api/v1/org/contact', { data: { to: B } })
  expect(lead.ok(), await lead.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  const leads: string[] = []
  for (const name of [A, B]) {
    const res = await request.get('/api/tasks')
    const all = ((await res.json()) as { tasks: { id: string; project?: string; org_role?: string }[] }).tasks
    leads.push(...all.filter((t) => t.org_role === 'lead' && t.project === name).map((t) => t.id))
  }
  for (const id of [...made, ...leads]) await removeTask(request, id)
})

test('Main is the CEO and each project a VP card: its avatar, name and count; a project opens to its tasks with status icons; opened stays open', async ({ page }) => {
  await openChart(page)
  await expect(page.getByTestId('org-chart-ceo')).toContainText('CEO')
  for (const name of [A, B]) {
    const card = vp(page, name)
    // Closed: the VP's avatar, name and role, then how many it has open (2026-11-06, the user:
    // "just show the name"; 2026-11-08: "after the name, how many it has, then what it is
    // doing"; nothing here is at work, so no doing line), and its one project's name and count.
    // No status words, asks, news, time, badge or menu.
    await expect(card.locator('.org-avatar')).toHaveCount(1)
    await expect(card.getByTestId('org-chart-vp-name')).toHaveText(name)
    await expect(card.locator('.oc-role')).toHaveText('VP')
    await expect(card.getByTestId('org-chart-vp-now')).toHaveText('2 open')
    await expect(card.getByTestId('org-chart-project-now')).toHaveText('2 open')
    await expect(card.getByTestId('org-chart-vp-doing')).toHaveCount(0)
    await expect(card.locator('.oc-badge, .oc-more, .oc-dot, [data-testid="org-chart-vp-detail"], [data-testid="org-chart-tasks"]')).toHaveCount(0)
    await expect(card).not.toContainText(/Waiting|Needs you|Working|threads/)
    // Opened, the card holds Open chat and nothing about asks (2026-11-08: the chart is "not for
    // making decisions").
    await expand(card.getByTestId('org-chart-vp-toggle'))
    await expect(card.getByTestId('org-chart-vp-open')).toBeVisible()
    await expect(card.getByTestId('org-chart-vp-detail')).not.toContainText(/Waiting|Needs you|threads/)
    await expect(card).not.toContainText('lead')
    // Its own project opens apart from the card (the card's key is that row's key too) to its
    // tasks: each one its title and its status as an icon, no status words, no counts line.
    const own = card.getByTestId('org-chart-project')
    await expect(own).toHaveCount(1)
    await expect(own.getByTestId('org-chart-project-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expand(own.getByTestId('org-chart-project-toggle'))
    const tasks = own.getByTestId('org-chart-task')
    await expect(tasks).toHaveCount(2)
    await expect(own.getByTestId('org-chart-project-now')).toHaveCount(0)
    await expect(own.getByTestId('org-chart-tasks')).not.toContainText(/Waiting|snoozed|Needs you/)
    for (const t of await tasks.all()) {
      await expect(t).toHaveAttribute('data-state', 'waiting')
      await expect(t.getByTestId('org-chart-task-icon')).toHaveAttribute('aria-label', 'Waiting')
      await expect(t.locator('svg')).toHaveCount(1)
    }
    await expect(own.locator('[data-testid="org-chart-project-line"], [data-testid="org-chart-project-menu"]')).toHaveCount(0)
  }
  // What was opened is opened again after a reload, and closes again on a click.
  await page.reload()
  await page.getByTestId('org-open-chart').click()
  for (const name of [A, B]) {
    await expect(vp(page, name).getByTestId('org-chart-vp-toggle')).toHaveAttribute('aria-expanded', 'true')
    await expect(row(page, name, name).getByTestId('org-chart-project-toggle')).toHaveAttribute('aria-expanded', 'true')
    await row(page, name, name).getByTestId('org-chart-project-toggle').click()
    await vp(page, name).getByTestId('org-chart-vp-toggle').click()
    await expect(vp(page, name).locator('[data-testid="org-chart-vp-detail"], [data-testid="org-chart-tasks"]')).toHaveCount(0)
  }
})

test('a drag onto another VP says what it does, asks first, and puts the project under that VP', async ({ page, request }) => {
  await openChart(page)
  const bLead = (await project(request, B))!.lead!.id

  // While over A, the card says what the drop would do.
  await dragOver(page, handle(page, B), vp(page, A))
  await expect(page.getByTestId('org-chart-hint')).toHaveText(`Drop: the ${A} VP takes over ${B}`)
  await page.mouse.up()
  const confirm = page.getByTestId('org-chart-confirm')
  await expect(confirm).toContainText(`Put ${B} under the ${A} VP?`)
  await expect(confirm).toContainText('no task changes project')
  await expect(confirm).toContainText('steps down')

  // Tab stays in the question: Cancel, Confirm, Cancel again, never the chart's × behind it.
  await expect(page.getByTestId('org-chart-apply')).toBeFocused()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Tab')
    await expect(page.locator(':focus')).toHaveCount(1)
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="org-chart-confirm"]'))).toBe(true)
  }
  // Cancel changes nothing, and the focus is back on the project it asked about.
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(row(page, B, B).getByTestId('org-chart-project-toggle')).toBeFocused()
  expect((await project(request, B))?.vp).toBeUndefined()

  // Right after a drag, a click outside closes the question too (WebKit sends no pointerdown
  // for that first press), and nothing moves.
  await dragOver(page, handle(page, B), vp(page, A))
  await page.mouse.up()
  await expect(confirm).toBeVisible()
  const sheetBox = (await page.locator('.org-sheet').boundingBox())!
  await page.mouse.click(sheetBox.x + sheetBox.width / 2, sheetBox.y + sheetBox.height + 12)
  await expect(confirm).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()
  expect((await project(request, B))?.vp).toBeUndefined()

  // The same drop again, confirmed.
  await handle(page, B).dragTo(vp(page, A))
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} is now under the ${A} VP.`)
  const card = vp(page, A)
  await expect(card.getByTestId('org-chart-project')).toHaveCount(2)
  await expect(card.getByTestId('org-chart-project').nth(1)).toContainText(B)
  await expect(vp(page, B)).toHaveCount(0)

  // Both stay projects with their own tasks; B is talked to through A's VP, and B's own
  // VP (it never talked, so it had nothing to hand over) has stepped down.
  const b = (await project(request, B))!
  const aLead = (await project(request, A))!.lead!
  expect(b).toMatchObject({ vp: A, contactId: aLead.id })
  for (const id of made) expect((await taskOf(request, id))?.project).toMatch(/^Chart (garden|seeds) /)
  expect((await taskOf(request, bLead))?.phase).toBe('COMPLETE')
  expect((await taskOf(request, aLead.id))?.org_leads).toEqual([B])

  // A project on the card opens to its tasks, each with where it stands as its icon.
  const seeds = row(page, A, B)
  await expect(seeds.getByTestId('org-chart-tasks')).toHaveCount(0)
  await expand(seeds.getByTestId('org-chart-project-toggle'))
  const tasks = seeds.getByTestId('org-chart-task')
  await expect(tasks).toHaveCount(2)
  await expect(seeds.getByTestId('org-chart-tasks')).toContainText(`Collect seeds ${STAMP}`)
  await expect(seeds.getByTestId('org-chart-tasks')).toContainText(`Label jars ${STAMP}`)
  await expect(tasks.first().getByTestId('org-chart-task-icon')).toHaveAttribute('aria-label', 'Waiting')
  await expect(card.locator(`[data-testid="org-chart-project"][data-project="${A}"]`).getByTestId('org-chart-tasks')).toHaveCount(0)

  // A press on a task that moves a little drags no project: the press is the task's.
  await dragOver(page, tasks.first(), page.getByTestId('org-chart-own'), { drags: false })
  await page.mouse.up()
  await expect(page.getByTestId('org-chart-confirm')).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()

  // A task opens beside the Org page, and the sheet closes.
  const label = seeds.locator('[data-testid="org-chart-task"]', { hasText: `Label jars ${STAMP}` })
  const labelId = await label.getAttribute('data-task-id')
  await label.click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(page.getByTestId('org-side')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`open=[^&]*${labelId}`))

  // On the Org page, B is part of A's channel now: no channel of its own, and A's says it leads one more.
  const channel = (name: string) => page.locator(`[data-testid="org-channel"][data-key="project:${name.toLowerCase()}"]`)
  await expect(channel(A)).toBeVisible()
  await expect(channel(B)).toHaveCount(0)
  await expect(channel(A).getByTestId('org-channel-led')).toHaveText('+1')
  // B is under "Archived" at the bottom, folded, saying where it went; it came in live.
  const moved = page.getByTestId('org-moved-toggle')
  await expect(moved).toHaveText(/^.?Archived · \d+$/)
  await expect(moved).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('org-moved-row')).toHaveCount(0)
  await moved.click()
  const movedB = page.locator(`[data-testid="org-moved-row"][data-key="project:${B.toLowerCase()}"]`)
  await expect(movedB.getByTestId('org-moved-line')).toHaveText(new RegExp(`^Moved to the ${A} VP`))
  // A click opens the VP that has it now.
  await movedB.click()
  await expect(channel(A)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('org-detail-led')).toHaveText(`Leads ${A}, ${B}`)
})

test('a drag onto the drop zone creates a dedicated VP again; the menu asks the same without a drag', async ({ page, request }) => {
  await openChart(page)
  await dragOver(page, row(page, A, B), page.getByTestId('org-chart-own'))
  await expect(page.getByTestId('org-chart-own')).toHaveText(`Drop: ${B} gets a dedicated VP`)
  await page.mouse.up()
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Create a dedicated VP for ${B}?`)
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} has a dedicated VP again.`)
  await expect(vp(page, B)).toBeVisible()
  await expect(vp(page, A).getByTestId('org-chart-project')).toHaveCount(1)
  const b = (await project(request, B))!
  expect(b.vp).toBeUndefined()
  expect((await taskOf(request, b.lead!.id))?.phase).not.toBe('COMPLETE')

  // The move menu: the same question, no drag, by a right-click on the project (or, on the
  // keyboard, Shift+F10 on its name). Escape closes the question first, then the sheet.
  await row(page, B, B).click({ button: 'right' })
  await expect(page.getByTestId('org-chart-move-menu')).toContainText(`Move ${B} under`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('org-chart-move-menu')).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()
  await row(page, B, B).getByTestId('org-chart-project-toggle').focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByTestId('org-chart-move-menu')
  await expect(menu).toContainText(`Move ${B} under`)
  await menu.getByText(`${A} VP`, { exact: true }).click()
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Put ${B} under the ${A} VP?`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('org-chart-confirm')).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()
  expect((await project(request, B))?.vp).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
})

test('a click outside the sheet closes it; inside, or with the menu or the question open, it does not', async ({ page }) => {
  const sheet = await openChart(page)
  const panel = sheet.locator('.org-sheet')
  const box = (await panel.boundingBox())!
  // Inside the sheet, on its title: nothing closes.
  await sheet.locator('.org-sheet-title').click()
  await expect(sheet).toBeVisible()
  // The move menu open: the click outside closes only the menu.
  await row(page, B, B).getByTestId('org-chart-project-toggle').click({ button: 'right' })
  await expect(page.getByTestId('org-chart-move-menu')).toBeVisible()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 12)
  await expect(page.getByTestId('org-chart-move-menu')).toHaveCount(0)
  await expect(sheet).toBeVisible()
  // The question open: the click outside closes only the question.
  await row(page, B, B).getByTestId('org-chart-project-toggle').click({ button: 'right' })
  await page.getByTestId('org-chart-move-menu').getByText(`${A} VP`, { exact: true }).click()
  await expect(page.getByTestId('org-chart-confirm')).toBeVisible()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 12)
  await expect(page.getByTestId('org-chart-confirm')).toHaveCount(0)
  await expect(sheet).toBeVisible()
  // A press inside that ends outside is not a click outside.
  const title = (await sheet.locator('.org-sheet-title').boundingBox())!
  await page.mouse.move(title.x + 4, title.y + 4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 12, { steps: 4 })
  await page.mouse.up()
  await expect(sheet).toBeVisible()
  // Nothing open: the click outside closes the sheet.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 12)
  await expect(sheet).toHaveCount(0)
})

test('a right-click on an Org row opens Walnut\'s menu, kept short: open it, move its project, create a dedicated VP', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  const channel = (name: string) => page.locator(`[data-testid="org-channel"][data-key="project:${name.toLowerCase()}"]`)
  const menu = page.getByTestId('org-channel-menu')

  // Main: its tabs and the chart; Escape closes it, and no word is left selected under it.
  await page.getByTestId('org-channel-main').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('Open chat')
  await expect(menu).toContainText('Open tasks')
  await expect(menu).not.toContainText('Open VPs')
  await expect(menu).toContainText('Open the org chart')
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // A VP row: open it on its tasks (All tasks). The VPs it could move under are one row, not a row each.
  await channel(B).click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Open chat', 'Open tasks', 'Move under another VP…'])
  await expect(menu).not.toContainText(`${A} VP`)
  await menu.getByText('Open tasks', { exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(channel(B)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await expect(page.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')

  // Move it: the row opens the VPs at the cursor, a pick opens the chart on the same question as
  // a drag, and nothing moves before Confirm.
  await channel(B).click({ button: 'right' })
  await menu.getByText('Move under another VP…', { exact: true }).click()
  await expect(menu).toHaveCount(0)
  const picker = page.locator(`.task-kebab-project-flyout[aria-label="Move ${B} under"]`)
  await expect(picker).toBeVisible()
  const pbox = (await picker.boundingBox())!
  const vpSize = page.viewportSize()!
  expect(pbox.x + pbox.width).toBeLessThanOrEqual(vpSize.width + 0.5)
  expect(pbox.y + pbox.height).toBeLessThanOrEqual(vpSize.height + 0.5)
  await page.screenshot({ path: `test-results/org-row-move-picker-${test.info().project.name}.png` })
  // A pane that scrolls on its own (a chat following its tail) leaves it open; Escape puts the
  // focus back on the row it was opened from.
  await page.evaluate(async () => {
    const pane = document.createElement('div')
    pane.dataset.testid = 'other-pane'
    pane.style.cssText = 'position:fixed;left:0;bottom:0;width:40px;height:40px;overflow:auto'
    pane.innerHTML = '<div style="height:400px"></div>'
    document.body.appendChild(pane)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    pane.scrollTop = 200
    await new Promise((r) => setTimeout(r, 300))
    pane.remove()
  })
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(channel(B)).toBeFocused()
  await channel(B).click({ button: 'right' })
  await menu.getByText('Move under another VP…', { exact: true }).click()
  await expect(picker).toBeVisible()
  await picker.getByRole('option', { name: `${A} VP`, exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Put ${B} under the ${A} VP?`)
  expect((await project(request, B))?.vp).toBeUndefined()
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} is now under the ${A} VP.`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  await expect(channel(B)).toHaveCount(0)
  // The VP that took it over offers a dedicated VP for it, by name.
  await channel(A).click({ button: 'right' })
  await expect(menu).toContainText(`Create a dedicated VP for ${B}…`)
  await page.keyboard.press('Escape')

  // Under "Archived", the moved project's menu gives it back.
  await page.getByTestId('org-moved-toggle').click()
  const movedB = page.locator(`[data-testid="org-moved-row"][data-key="project:${B.toLowerCase()}"]`)
  await movedB.click({ button: 'right' })
  await expect(menu).toContainText(`Open the ${A} VP`)
  await menu.getByText(`Create a dedicated VP for ${B}…`, { exact: true }).click()
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Create a dedicated VP for ${B}?`)
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} has a dedicated VP again.`)
  await page.keyboard.press('Escape')
  await expect(channel(B)).toBeVisible()
  await expect(movedB).toHaveCount(0)
  expect((await project(request, B))?.vp).toBeUndefined()
})
