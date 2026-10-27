/**
 * Making a VP or a project inside the org chart, and a VP's name and instructions
 * (web/src/components/org/OrgNodeEditor.tsx, src/core/org/org-node-edit.ts; 2026-10-26, the user:
 * "in org chart should be able to create VP or Project, project has a VP automatically, Create vp
 * means a VP, don't have a project that is fine, I usually will drag, in org chart during regular
 * or creation, I can define VP name, some Instruction"):
 *   - "+ New VP" makes a VP with no project: its card says so, and a project dragged onto it is its one
 *   - "+ New project" makes a project with its own VP card
 *   - a VP card's ⋯ (or a right-click) edits its name and instructions; the CEO's sets the CEO's
 *   - a refused name keeps what was typed and says why; Escape closes the form before the sheet
 * The fixture is shared, so this file makes its own names and removes what it made.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const VP = `Growth ${STAMP}`
const PROJECT = `Pond ${STAMP}`
const OTHER = `Shed ${STAMP}`
const made: string[] = []

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

interface ApiTask { id: string; title: string; project?: string; phase: string; org_role?: string; org_leads?: string[]; org_vp_only?: boolean; org_name?: string; org_instructions?: { text: string } }
const allTasks = async (request: APIRequestContext): Promise<ApiTask[]> => ((await (await request.get('/api/tasks')).json()) as { tasks: ApiTask[] }).tasks
const leadOf = async (request: APIRequestContext, project: string) =>
  (await allTasks(request)).find((t) => t.org_role === 'lead' && t.project === project && t.phase !== 'COMPLETE')

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

const vp = (page: Page, project: string) => page.locator(`[data-testid="org-chart-vp"][data-project="${project}"]`)

test.beforeAll(async ({ request }) => {
  // A project with work of its own, to drag under the new VP.
  const res = await request.post('/api/tasks', { data: { title: `Paint the door ${STAMP}`, project: OTHER, source: 'local' } })
  expect(res.ok(), await res.text()).toBe(true)
  made.push(((await res.json()) as { task: { id: string } }).task.id)
})

test.afterAll(async ({ request }) => {
  const leads = (await allTasks(request)).filter((t) => t.org_role === 'lead' && [VP, PROJECT, OTHER].includes(t.project ?? '')).map((t) => t.id)
  for (const id of [...made, ...leads]) await removeTask(request, id)
  for (const p of [VP, PROJECT, OTHER]) await request.delete(`/api/v1/projects/${encodeURIComponent(p)}`).catch(() => undefined)
})

test('+ New VP makes a VP with no project, named and instructed as typed', async ({ page, request }) => {
  await openChart(page)
  await page.getByTestId('org-chart-new-vp').click()
  const form = page.getByTestId('org-node-editor')
  await expect(form).toContainText('New VP')
  await expect(form.getByTestId('org-node-name')).toBeFocused()
  await expect(form.getByTestId('org-node-save')).toBeDisabled()
  await form.getByTestId('org-node-name').fill(VP)
  await form.getByTestId('org-node-instructions').fill('Own the launch plan.\nAsk before spending money.')
  await form.getByTestId('org-node-save').click()
  await expect(form).toHaveCount(0)
  await expect(page.getByTestId('org-chart-done')).toHaveText(`Made the ${VP} VP. Drag projects onto it to put them under it.`)

  const card = vp(page, VP)
  await expect(card).toContainText(VP)
  await expect(card.getByTestId('org-chart-vp-empty')).toHaveText('No projects yet: drag one here')
  await expect(card.getByTestId('org-chart-project')).toHaveCount(0)
  const lead = await leadOf(request, VP)
  expect(lead).toMatchObject({ title: `${VP} lead`, org_vp_only: true, org_instructions: { text: 'Own the launch plan.\nAsk before spending money.' } })
  made.push(lead!.id)

  // The same name again is refused in the server's words, and what was typed stays.
  await page.getByTestId('org-chart-new-vp').click()
  await form.getByTestId('org-node-name').fill(VP.toLowerCase())
  await form.getByTestId('org-node-save').click()
  await expect(form.getByTestId('org-node-error')).toContainText('is already a project in the org')
  await expect(form.getByTestId('org-node-name')).toHaveValue(VP.toLowerCase())
  // Escape closes the form, not the sheet, and focus goes back to the button that opened it.
  await page.keyboard.press('Escape')
  await expect(form).toHaveCount(0)
  await expect(page.getByTestId('org-chart')).toBeVisible()
  await expect(page.getByTestId('org-chart-new-vp')).toBeFocused()
})

test('+ New project makes a project with its own VP card', async ({ page, request }) => {
  await openChart(page)
  await page.getByTestId('org-chart-new-project').click()
  const form = page.getByTestId('org-node-editor')
  await form.getByTestId('org-node-name').fill(PROJECT)
  await expect(form.getByTestId('org-node-vp-name')).toHaveAttribute('placeholder', PROJECT)
  await form.getByTestId('org-node-save').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`Made the project ${PROJECT} with its own VP.`)
  const card = vp(page, PROJECT)
  await expect(card).toContainText(PROJECT)
  await expect(card.getByTestId('org-chart-project')).toHaveCount(1)
  const lead = await leadOf(request, PROJECT)
  expect(lead?.org_vp_only).toBeUndefined()
  made.push(lead!.id)
})

test('a VP card edits its name and instructions; a project dragged onto a new VP is its one', async ({ page, request }) => {
  await openChart(page)
  // Right-click on the card head opens the same menu as its ⋯.
  await vp(page, VP).getByTestId('org-chart-vp-handle').click({ button: 'right' })
  const menu = page.getByTestId('org-chart-node-menu')
  await expect(menu.locator('[role^="menuitem"]')).toHaveText(['Open chat', 'Edit name and instructions…'])
  await menu.getByText('Edit name and instructions…').click()
  const form = page.getByTestId('org-node-editor')
  await expect(form.getByTestId('org-node-name')).toHaveValue(VP)
  await expect(form.getByTestId('org-node-instructions')).toHaveValue('Own the launch plan.\nAsk before spending money.')
  await form.getByTestId('org-node-name').fill(`${VP} team`)
  await form.getByTestId('org-node-instructions').fill('Own the launch plan.\nShip on Fridays only.')
  await form.getByTestId('org-node-save').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`Saved. The ${VP} team VP reads the new instructions with its next message.`)
  await expect(vp(page, VP)).toContainText(`${VP} team`)
  // The name is the user's own field; the title stays its session's.
  const lead = await leadOf(request, VP)
  expect(lead).toMatchObject({ title: `${VP} lead`, org_name: `${VP} team`, org_instructions: { text: 'Own the launch plan.\nShip on Fridays only.' } })

  // Saving with nothing changed writes nothing.
  await vp(page, VP).getByTestId('org-chart-vp-menu').click()
  await page.getByTestId('org-chart-node-menu').getByText('Edit name and instructions…').click()
  await expect(form.getByTestId('org-node-name')).toHaveValue(`${VP} team`)
  await form.getByTestId('org-node-save').click()
  await expect(form).toHaveCount(0)
  await expect(vp(page, VP).getByTestId('org-chart-vp-menu')).toBeFocused()
  expect((await leadOf(request, VP))?.org_instructions).toEqual(lead!.org_instructions)

  // Drag the other project onto it and confirm: it is the VP's one project.
  await vp(page, OTHER).getByTestId('org-chart-vp-handle').dragTo(vp(page, VP))
  await expect(page.getByTestId('org-chart-confirm')).toContainText(`Put ${OTHER} under the ${VP} team VP?`)
  await page.getByTestId('org-chart-apply').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText(`${OTHER} is now under the ${VP} team VP.`)
  await expect(vp(page, VP).getByTestId('org-chart-project')).toHaveCount(1)
  await expect(vp(page, VP).getByTestId('org-chart-project')).toContainText(OTHER)
  await expect(vp(page, VP).getByTestId('org-chart-vp-empty')).toHaveCount(0)
  expect((await leadOf(request, VP))?.org_leads).toEqual([OTHER])
})

test('the CEO\'s ⋯ sets the CEO\'s own instructions', async ({ page, request }) => {
  // The CEO is made on first use; the fixture may not have one yet.
  expect((await request.post('/api/v1/org/main')).ok()).toBe(true)
  await openChart(page)
  await page.getByTestId('org-chart-ceo-menu').click()
  await page.getByTestId('org-chart-node-menu').getByText('Edit instructions…').click()
  const form = page.getByTestId('org-node-editor')
  await expect(form).toContainText('The CEO\'s instructions')
  await expect(form.getByTestId('org-node-name')).toHaveCount(0)
  const main = (await allTasks(request)).find((t) => t.org_role === 'main')!
  const before = main.org_instructions?.text
  await form.getByTestId('org-node-instructions').fill(`Keep the weekly plan short. ${STAMP}`)
  await form.getByTestId('org-node-save').click()
  await expect(page.getByTestId('org-chart-done')).toHaveText('Saved. The CEO reads the new instructions with its next message.')
  // Put back what the shared fixture had.
  const res = await request.put(`/api/v1/org/nodes/${main.id}`, { data: { instructions: before ?? null } })
  expect(res.ok(), await res.text()).toBe(true)
})
