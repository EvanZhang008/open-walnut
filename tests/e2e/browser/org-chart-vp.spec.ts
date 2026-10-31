/**
 * The org chart as a user meets it (web/src/components/org/OrgChartSheet.tsx, POST /api/v1/org/vp):
 *   - Main is the CEO; every project is a VP card with its own name, its news and a needs-you
 *     count, never a made-up "lead" name, and every card lists the projects its VP leads, its
 *     own included
 *   - dragging one project onto another VP says what the drop does before it happens, asks
 *     first, and Cancel changes nothing; after Confirm that VP's card lists both projects,
 *     each still its own project (no task moved), and the VP that let go has stepped down
 *   - dragging it onto the drop zone creates a dedicated VP for it again; the ⋯ menu does the same without a drag, and
 *     Escape closes the question before the sheet
 *   - a project opens to its tasks and where each stands; a task opens beside the Org page
 *   - a project under another VP is part of that VP's channel on the Org page, not one of its own
 *   - a card opens its project on the Org page, on its chat (chat is the first tab)
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
    const res = await request.delete(`/api/tasks/${id}`)
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

/** Drag with the mouse, so the card under the pointer can be read before the drop. */
async function dragOver(page: Page, from: Locator, to: Locator): Promise<void> {
  await from.scrollIntoViewIfNeeded()
  const a = (await from.boundingBox())!
  await page.mouse.move(a.x + 20, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 4 })
  const b = (await to.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
  await page.mouse.move(b.x + b.width / 2 + 4, b.y + b.height / 2, { steps: 2 })
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

test('Main is the CEO and each project a VP card with its own name', async ({ page }) => {
  await openChart(page)
  await expect(page.getByTestId('org-chart-ceo')).toContainText('CEO')
  await expect(page.getByTestId('org-chart-ceo')).toContainText('CEO')
  for (const name of [A, B]) {
    await expect(vp(page, name)).toContainText(name)
    await expect(vp(page, name)).toContainText('VP')
    await expect(vp(page, name)).not.toContainText('lead')
    // Two tasks not started: Waiting, by the one user status (src/core/user-status.ts); with no
    // words of their own, the card's news says so too. The card lists its one project with
    // its counts; the card itself has no counts line then.
    await expect(vp(page, name).getByTestId('org-chart-vp-news')).toContainText('Waiting: ')
    const own = vp(page, name).getByTestId('org-chart-project')
    await expect(own).toHaveCount(1)
    await expect(own).toContainText(name)
    await expect(own.getByTestId('org-chart-project-line')).toHaveText('2 Waiting / snoozed')
    await expect(vp(page, name).getByTestId('org-chart-vp-line')).toHaveCount(0)
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

  // Cancel changes nothing.
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect((await project(request, B))?.vp).toBeUndefined()

  // The same drop again, confirmed.
  await handle(page, B).dragTo(vp(page, A))
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} is now under the ${A} VP.`)
  const card = vp(page, A)
  await expect(card.getByTestId('org-chart-project')).toHaveCount(2)
  await expect(card.getByTestId('org-chart-project').nth(1)).toContainText(B)
  await expect(card.getByTestId('org-chart-vp-line')).toHaveText(/^2 projects · \d+ Waiting \/ snoozed$/)
  await expect(vp(page, B)).toHaveCount(0)

  // Both stay projects with their own tasks; B is talked to through A's VP, and B's own
  // VP (it never talked, so it had nothing to hand over) has stepped down.
  const b = (await project(request, B))!
  const aLead = (await project(request, A))!.lead!
  expect(b).toMatchObject({ vp: A, contactId: aLead.id })
  for (const id of made) expect((await taskOf(request, id))?.project).toMatch(/^Chart (garden|seeds) /)
  expect((await taskOf(request, bLead))?.phase).toBe('COMPLETE')
  expect((await taskOf(request, aLead.id))?.org_leads).toEqual([B])

  // A project on the card opens to its tasks, each with where it stands.
  const seeds = card.locator(`[data-testid="org-chart-project"][data-project="${B}"]`)
  await expect(seeds.getByTestId('org-chart-tasks')).toHaveCount(0)
  await seeds.getByTestId('org-chart-project-toggle').click()
  await expect(seeds.getByTestId('org-chart-project-toggle')).toHaveAttribute('aria-expanded', 'true')
  const tasks = seeds.getByTestId('org-chart-task')
  await expect(tasks).toHaveCount(2)
  await expect(seeds.getByTestId('org-chart-tasks')).toContainText(`Collect seeds ${STAMP}`)
  await expect(seeds.getByTestId('org-chart-tasks')).toContainText(`Label jars ${STAMP}`)
  await expect(tasks.first()).toContainText('Waiting')
  await expect(card.locator(`[data-testid="org-chart-project"][data-project="${A}"]`).getByTestId('org-chart-tasks')).toHaveCount(0)

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
  const row = vp(page, A).locator(`[data-testid="org-chart-project"][data-project="${B}"]`)
  await dragOver(page, row, page.getByTestId('org-chart-own'))
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

  // The ⋯ menu: the same question, no drag. Escape closes the question first, then the sheet.
  await vp(page, B).getByTestId('org-chart-project-menu').click()
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
  // The ⋯ menu open: the click outside closes only the menu.
  await vp(page, B).getByTestId('org-chart-project-menu').click()
  await expect(page.getByTestId('org-chart-move-menu')).toBeVisible()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 12)
  await expect(page.getByTestId('org-chart-move-menu')).toHaveCount(0)
  await expect(sheet).toBeVisible()
  // The question open: the click outside closes only the question.
  await vp(page, B).getByTestId('org-chart-project-menu').click()
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
  await expect(menu).toContainText('Open the org chart')
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // A VP row: open it on its team. The VPs it could move under are one row, not a row each.
  await channel(B).click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Open chat', 'Open team', 'Move under another VP…'])
  await expect(menu).not.toContainText(`${A} VP`)
  await menu.getByText('Open team', { exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(channel(B)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('org-tab-team')).toHaveAttribute('aria-selected', 'true')

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
