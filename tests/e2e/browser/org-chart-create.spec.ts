/**
 * Making a VP or a project inside the org chart, and a VP's name and instructions
 * (web/src/components/org/OrgNodeEditor.tsx, src/core/org/org-node-edit.ts; 2026-10-26, the user:
 * "in org chart should be able to create VP or Project, project has a VP automatically, Create vp
 * means a VP, don't have a project that is fine, I usually will drag, in org chart during regular
 * or creation, I can define VP name, some Instruction"):
 *   - "+ New VP" makes a VP with no project: its card says so, and a project dragged onto it is its one
 *   - "+ New project" makes a project with its own VP card
 *   - a VP card's ⋯ (or a right-click) edits its name and instructions; a new VP's form opens on
 *     Walnut's default core instructions for a VP
 *   - a refused name keeps what was typed and says why; Escape closes the form before the sheet
 *   - an agent writes a VP's instructions as the user does (2026-10-27, the user: "all human action
 *     can be done by agent also"); the form says who wrote them and when, and the user writes back
 * The CEO's form lives in org-main-and-chart.spec.ts, the one file that may touch Main.
 * The fixture is shared, so this file makes its own names and removes what it made.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { DEFAULT_ORG_INSTRUCTIONS } from '../../../src/core/org/core-instructions'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const VP = `Growth ${STAMP}`
const PROJECT = `Pond ${STAMP}`
const OTHER = `Shed ${STAMP}`
const GATE = `Gate ${STAMP}`
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
  const leads = (await allTasks(request)).filter((t) => t.org_role === 'lead' && [VP, PROJECT, OTHER, GATE].includes(t.project ?? '')).map((t) => t.id)
  for (const id of [...made, ...leads]) await removeTask(request, id)
  for (const p of [VP, PROJECT, OTHER, GATE]) await request.delete(`/api/v1/projects/${encodeURIComponent(p)}`).catch(() => undefined)
})

test('+ New VP makes a VP with no project, named and instructed as typed', async ({ page, request }) => {
  await openChart(page)
  await page.getByTestId('org-chart-new-vp').click()
  const form = page.getByTestId('org-node-editor')
  await expect(form).toContainText('New VP')
  await expect(form.getByTestId('org-node-name')).toBeFocused()
  await expect(form.getByTestId('org-node-save')).toBeDisabled()
  await expect(form.getByTestId('org-node-instructions')).toHaveValue(DEFAULT_ORG_INSTRUCTIONS.lead)
  await expect(form.getByTestId('org-node-instructions-source')).toHaveText('Walnut\'s default')
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

test('an agent writes a VP\'s instructions; the form says who and when, and the user writes them back', async ({ page, request }) => {
  test.setTimeout(240_000)
  // An agent: a task with a session, calling the API with its caller id as the org ops do.
  const port = Number(process.env.PW_TEST_PORT ?? 3457)
  const { fixtureRoot } = await discoverBrowserFixture(port)
  const writer = `Agent writer ${STAMP}`
  const made1 = await request.post('/api/tasks', { data: { title: writer, project: GATE, source: 'local' } })
  expect(made1.ok(), await made1.text()).toBe(true)
  const writerId = ((await made1.json()) as { task: { id: string } }).task.id
  made.push(writerId)
  const started = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: `snapshot-clean-turn:writer ready ${STAMP}`, taskId: writerId } })
  expect(started.ok(), await started.text()).toBe(true)
  const sid = ((await started.json()) as { sessionId: string }).sessionId
  const words = `Answer the launch questions first. ${STAMP}`
  const put = await request.put(`/api/v1/org/projects/${encodeURIComponent(GATE)}/vp`, { headers: { 'x-walnut-caller-sid': sid }, data: { instructions: words } })
  expect(put.ok(), await put.text()).toBe(true)
  expect(((await put.json()) as { task: { org_instructions?: unknown } }).task.org_instructions).toMatchObject({ text: words, by: `task:${writerId}`, by_name: `the task "${writer}"` })

  await openChart(page)
  await vp(page, GATE).getByTestId('org-chart-vp-menu').click()
  await page.getByTestId('org-chart-node-menu').getByText('Edit name and instructions…').click()
  const form = page.getByTestId('org-node-editor')
  const box = form.getByTestId('org-node-instructions')
  const source = form.getByTestId('org-node-instructions-source')
  // An agent's lines follow Walnut's default, and the box shows both: that is what the VP reads.
  const shown = `${DEFAULT_ORG_INSTRUCTIONS.lead}\n\n${words}`
  await expect(box).toHaveValue(shown)
  await expect(source).toHaveText(`Walnut's default and lines by the task "${writer}", just now`)
  // The user fixes the agent's line: their own words now, the default still in them.
  await box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length) })
  await box.pressSequentially(' Then the rest.')
  await expect(source).toHaveText('yours')
  await form.getByTestId('org-node-save').click()
  await expect(form).toHaveCount(0)
  expect((await leadOf(request, GATE))?.org_instructions).toMatchObject({ text: `${shown} Then the rest.`, by: 'human' })
  await vp(page, GATE).getByTestId('org-chart-vp-menu').click()
  await page.getByTestId('org-chart-node-menu').getByText('Edit name and instructions…').click()
  await expect(source).toHaveText('by you, just now')
  await page.keyboard.press('Escape')
  await expect(form).toHaveCount(0)
  await request.post(`/api/v1/sessions/${sid}/terminate`, { data: { force: true } }).catch(() => undefined)
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

