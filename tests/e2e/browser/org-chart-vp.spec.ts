/**
 * The org chart as a user meets it (web/src/components/org/OrgChartSheet.tsx, POST /api/v1/org/vp):
 *   - Main is the CEO; every project is a VP card with its own name, one line and a needs-you
 *     count, never a made-up "lead" name
 *   - dragging one project onto another VP says what the drop does before it happens, asks
 *     first, and Cancel changes nothing; after Confirm that VP's card lists both projects,
 *     each still its own project (no task moved), and the VP that let go has stepped down
 *   - dragging it onto "own VP" gives it back; the ⋯ menu does the same without a drag, and
 *     Escape closes the question before the sheet
 *   - a card opens its project on the Org page, on its chat (chat is the first tab)
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
  await expect(page.getByTestId('org-chart-ceo')).toContainText('Main')
  await expect(page.getByTestId('org-chart-ceo')).toContainText('CEO')
  for (const name of [A, B]) {
    await expect(vp(page, name)).toContainText(name)
    await expect(vp(page, name)).toContainText('VP')
    await expect(vp(page, name)).not.toContainText('lead')
    // Two tasks not started: Waiting, by the one user status (src/core/user-status.ts); with no
    // words of their own, the card's news says so too.
    await expect(vp(page, name).getByTestId('org-chart-vp-line')).toHaveText('2 waiting')
    await expect(vp(page, name).getByTestId('org-chart-vp-news')).toContainText('Waiting: ')
  }
})

test('a drag onto another VP says what it does, asks first, and puts the project under that VP', async ({ page, request }) => {
  await openChart(page)
  const bLead = (await project(request, B))!.lead!.id

  // While over A, the card says what the drop would do.
  await dragOver(page, handle(page, B), vp(page, A))
  await expect(page.getByTestId('org-chart-hint')).toHaveText(`Drop: ${A}'s VP takes over ${B}`)
  await page.mouse.up()
  const confirm = page.getByTestId('org-chart-confirm')
  await expect(confirm).toContainText(`Put ${B} under ${A}'s VP?`)
  await expect(confirm).toContainText('no task changes project')
  await expect(confirm).toContainText('steps down')

  // Cancel changes nothing.
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect((await project(request, B))?.vp).toBeUndefined()

  // The same drop again, confirmed.
  await handle(page, B).dragTo(vp(page, A))
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} is now under ${A}'s VP.`)
  const card = vp(page, A)
  await expect(card.getByTestId('org-chart-project')).toHaveCount(2)
  await expect(card.getByTestId('org-chart-project').nth(1)).toContainText(B)
  await expect(card.getByTestId('org-chart-vp-line')).toHaveText(/^2 projects · \d+ waiting$/)
  await expect(vp(page, B)).toHaveCount(0)

  // Both stay projects with their own tasks; B is talked to through A's VP, and B's own
  // VP (it never talked, so it had nothing to hand over) has stepped down.
  const b = (await project(request, B))!
  const aLead = (await project(request, A))!.lead!
  expect(b).toMatchObject({ vp: A, contactId: aLead.id })
  for (const id of made) expect((await taskOf(request, id))?.project).toMatch(/^Chart (garden|seeds) /)
  expect((await taskOf(request, bLead))?.phase).toBe('COMPLETE')
  expect((await taskOf(request, aLead.id))?.org_leads).toEqual([B])

  // A project on the card opens on the Org page, on its chat.
  await card.getByTestId('org-chart-project').nth(1).locator('.oc-project-btn').click()
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', `project:${B.toLowerCase()}`)
  await expect(detail.getByTestId('org-tab-chat')).toHaveAttribute('aria-selected', 'true')
})

test('a drag onto "own VP" gives it back; the menu asks the same without a drag', async ({ page, request }) => {
  await openChart(page)
  const row = vp(page, A).locator(`[data-testid="org-chart-project"][data-project="${B}"]`)
  await dragOver(page, row, page.getByTestId('org-chart-own'))
  await expect(page.getByTestId('org-chart-own')).toHaveText(`Drop: ${B} gets its own VP`)
  await page.mouse.up()
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Give ${B} its own VP?`)
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${B} has its own VP again.`)
  await expect(vp(page, B)).toBeVisible()
  await expect(vp(page, A).getByTestId('org-chart-project')).toHaveCount(0)
  const b = (await project(request, B))!
  expect(b.vp).toBeUndefined()
  expect((await taskOf(request, b.lead!.id))?.phase).not.toBe('COMPLETE')

  // The ⋯ menu: the same question, no drag. Escape closes the question first, then the sheet.
  await vp(page, B).getByTestId('org-chart-project-menu').click()
  const menu = page.getByTestId('org-chart-move-menu')
  await expect(menu).toContainText(`Move ${B} under`)
  await menu.getByText(`${A}'s VP`).click()
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Put ${B} under ${A}'s VP?`)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('org-chart-confirm')).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()
  expect((await project(request, B))?.vp).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('org-chart')).toHaveCount(0)
})
