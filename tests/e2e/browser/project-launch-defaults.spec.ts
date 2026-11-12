/**
 * A project's launch defaults (server: src/core/sessions/project-launch-defaults.ts; web:
 * components/tasks/ProjectLaunchDefaults.tsx, utils/launch-source.ts): the project's details set
 * the engine, model and permission mode its new tasks start on; each row says where its value
 * comes from; a new task's draft in that project shows them on its pills and in its model picker,
 * and its Start leaves them to the server; the task's own pick wins; "Use global defaults" clears
 * all three. Real UI only; page.goto only loads the app.
 */
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { discoverFixtureRoot, draftPanel, loadHome, openDraftOnCwd } from './draft-helpers'
import { isolateUiPrefs, openProjectDetails, presetPanelView } from './todo-panel-helpers'
import { pickMode } from './permission-mode-helpers'

const SHOTS = process.env.PLD_SHOT_DIR ?? '/tmp/project-launch-defaults/shots'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })
test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36)
const PROJECT = `Defaults Lab ${stamp}`

function freshFolder(stem: string): string {
  const cwd = `${fixtureRoot}/projects/${stem}-${stamp}`
  fs.mkdirSync(cwd, { recursive: true })
  return cwd
}

async function metaOf(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(PROJECT)}/metadata`)
  return ((await res.json()) as { metadata?: Record<string, unknown> }).metadata ?? {}
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
})

test('the project details set its launch defaults, say where each comes from, and clear them in one click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const cwd = freshFolder('pld-settings')
  // The project exists with a folder and one task, none of the three set.
  expect((await page.request.post('/api/tasks', { data: { title: `Seed ${stamp}`, project: PROJECT, pinned: false } })).ok()).toBe(true)
  expect((await page.request.put(`/api/projects/${encodeURIComponent(PROJECT)}/metadata`, { data: { default_cwd: cwd } })).ok()).toBe(true)
  await page.goto('/')

  const pane = await openProjectDetails(page, PROJECT)
  const block = pane.getByTestId('project-launch-defaults')
  await expect(block).toBeVisible()
  const engine = block.getByTestId('project-default-engine')
  const model = block.getByTestId('project-default-model')
  const mode = block.getByTestId('project-default-mode')
  // Nothing set: every row is the global default, named, and the model waits for an engine.
  await expect(engine.locator('option:checked')).toHaveText(/^Global: /)
  // The global mode is Claude Code's own default for the project's folder (its settings, else Auto).
  const launchMode = (await (await page.request.get(`/api/engines/claude/launch-mode?cwd=${encodeURIComponent(cwd)}`)).json() as { mode: string }).mode
  await expect(mode.locator('option:checked')).toHaveText(`Global: ${await mode.locator(`option[value="${launchMode}"]`).innerText()}`)
  await expect(model).toBeDisabled()
  await expect(block.locator('.launch-source-tag')).toHaveText(['Global', 'Global', 'Global'])
  await expect(block.getByTestId('project-launch-defaults-clear')).toBeDisabled()
  await block.screenshot({ path: `${SHOTS}/settings-global.png` })

  await engine.selectOption('claude')
  await expect(model).toBeEnabled()
  await expect.poll(async () => (await metaOf(page)).default_engine).toBe('claude')
  await model.selectOption({ index: 1 })
  const pickedModel = await model.inputValue()
  expect(pickedModel).not.toBe('')
  await mode.selectOption('accept')
  await expect.poll(async () => metaOf(page)).toMatchObject({ default_engine: 'claude', default_model: pickedModel, default_mode: 'accept' })
  await expect(block.locator('.launch-source-tag')).toHaveText(['Project', 'Project', 'Project'])
  await expect(block.locator('.launch-source-tag').first()).toHaveAttribute('title', `Default of project ${PROJECT}`)
  await block.screenshot({ path: `${SHOTS}/settings-project.png` })

  // One click back to the global defaults: all three go, on the server too.
  await block.getByTestId('project-launch-defaults-clear').click()
  await expect(block.locator('.launch-source-tag')).toHaveText(['Global', 'Global', 'Global'])
  await expect.poll(async () => {
    const m = await metaOf(page)
    return [m.default_engine, m.default_model, m.default_mode]
  }).toEqual([undefined, undefined, undefined])
  await expect(model).toBeDisabled()
  // The folder is still the project's: only the three launch values went.
  expect((await metaOf(page)).default_cwd).toBe(cwd)
})

test("a new task's draft in the project shows its defaults and where they come from; Start leaves them to the server", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const cwd = freshFolder('pld-draft')
  expect((await page.request.put(`/api/projects/${encodeURIComponent(PROJECT)}/metadata`, {
    data: { default_cwd: cwd, default_engine: 'claude', default_model: 'sonnet', default_mode: 'accept' },
  })).ok()).toBe(true)
  await loadHome(page)
  const panel = await openDraftOnCwd(page, cwd)
  await expect(panel.locator('.draft-project-chip')).toContainText(PROJECT)

  // The mode pill reads the project's mode and says so; the model pill its model.
  const modePill = panel.locator('.draft-mode-pill')
  await expect(modePill).toHaveAttribute('data-mode', 'accept')
  await expect(modePill).toHaveAttribute('data-source', 'project')
  await expect(modePill).toHaveAttribute('title', new RegExp(`default of project ${PROJECT}`))
  const modelPill = panel.locator('.draft-model-select')
  await expect(modelPill).toHaveAttribute('data-model', 'sonnet')
  await modelPill.click()
  const note = page.getByTestId('launch-source-note')
  await expect(note).toBeVisible()
  await expect(note.getByTestId('launch-source-project')).toHaveText(`Project defaults of ${PROJECT}`)
  await expect(note.locator('.launch-source-row .launch-source-tag')).toHaveText(['Project', 'Project', 'Project'])
  await expect(note.locator('.launch-source-row[data-key="engine"] .launch-source-tag')).toHaveAttribute('title', `Default of project ${PROJECT}`)
  await expect(note.locator('.launch-source-row[data-key="engine"] .launch-source-value')).toHaveText('Claude Code')
  await expect(note.locator('.launch-source-row[data-key="model"] .launch-source-value')).toHaveText('Sonnet')
  await expect(note.locator('.launch-source-row[data-key="mode"] .launch-source-value')).toHaveText('Accept')
  await page.locator('.model-picker').screenshot({ path: `${SHOTS}/draft-picker-project.png` })
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)

  // Start: the launch names none of the three (the server applies the project's and records it).
  const sent = page.waitForRequest((r) => r.url().includes('/api/sessions/quick-start') && r.method() === 'POST')
  const composer = panel.locator('textarea.chat-input-textarea')
  await composer.fill('hello from a project with defaults')
  await composer.press('Enter')
  const body = (await sent).postDataJSON() as Record<string, unknown>
  expect(body.engine).toBeUndefined()
  expect(body.model).toBeUndefined()
  expect(body.mode).toBeUndefined()
  expect(body.project).toBe(PROJECT)
  const res = await (await sent).response()
  const taskId = ((await res?.json()) as { taskId?: string }).taskId
  expect(taskId).toBeTruthy()
  await expect.poll(async () => {
    const t = await (await page.request.get(`/api/tasks/${taskId}`)).json() as { task?: { launch_source?: unknown }; launch_source?: unknown }
    return (t.task ?? t).launch_source
  }).toMatchObject({ engine: 'project', model: 'project', mode: 'project', project: PROJECT })

  // The running session's model picker says the same, from the task's record of its start.
  const live = page.locator('.main-page-session-column .session-panel:not(.pending-session-panel):not(.draft-session-panel)').first()
  await expect(live).toBeVisible({ timeout: 20_000 })
  await live.locator('.composer-model-pill').first().click()
  const liveNote = page.getByTestId('launch-source-note')
  await expect(liveNote).toBeVisible()
  await expect(liveNote.locator('.launch-source-row[data-key="mode"] .launch-source-tag')).toHaveText('Project')
  await expect(liveNote.getByTestId('launch-source-project')).toHaveText(`Project defaults of ${PROJECT}`)
  await expect(liveNote.locator('.launch-source-row[data-key="model"] .launch-source-tag')).toHaveText('Project')
  await page.locator('.model-picker').screenshot({ path: `${SHOTS}/session-picker-project.png` })
  // A switch in the session is the task's own model from then on, at once (no reload).
  await page.locator('.model-picker').getByText('Haiku', { exact: true }).first().click()
  await page.keyboard.press('Escape')
  await live.locator('.composer-model-pill').first().click()
  await expect(liveNote.locator('.launch-source-row[data-key="model"] .launch-source-value')).toHaveText('Haiku')
  await expect(liveNote.locator('.launch-source-row[data-key="model"] .launch-source-tag')).toHaveText('Task')
  await expect(liveNote.locator('.launch-source-row[data-key="mode"] .launch-source-tag')).toHaveText('Project')
  await page.keyboard.press('Escape')
})

test("the task's own pick wins over the project's, and the draft says so", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const cwd = freshFolder('pld-own')
  expect((await page.request.put(`/api/projects/${encodeURIComponent(PROJECT)}/metadata`, {
    data: { default_cwd: cwd, default_engine: 'claude', default_model: 'sonnet', default_mode: 'accept' },
  })).ok()).toBe(true)
  await loadHome(page)
  const panel = await openDraftOnCwd(page, cwd)
  const modePill = panel.locator('.draft-mode-pill')
  await expect(modePill).toHaveAttribute('data-mode', 'accept')
  // A pick from the pill's menu makes the mode this task's own.
  const own = 'plan'
  await pickMode(modePill, own)
  await expect(modePill).toHaveAttribute('data-mode', own)
  await expect(modePill).toHaveAttribute('data-source', 'task')

  // The picker's note offers the way back to the project's values, and it works.
  await panel.locator('.draft-model-select').click()
  const note = page.getByTestId('launch-source-note')
  await expect(note.locator('.launch-source-row[data-key="mode"] .launch-source-tag')).toHaveText('Task')
  await note.getByTestId('launch-source-reset').click()
  await expect(note.locator('.launch-source-row[data-key="mode"] .launch-source-tag')).toHaveText('Project')
  await expect(note.getByTestId('launch-source-reset')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(modePill).toHaveAttribute('data-mode', 'accept')
  await expect(modePill).toHaveAttribute('data-source', 'project')
  // Pick again: this task's own mode.
  await pickMode(modePill, own)
  await expect(modePill).toHaveAttribute('data-mode', own)

  const sent = page.waitForRequest((r) => r.url().includes('/api/sessions/quick-start') && r.method() === 'POST')
  const composer = draftPanel(page).locator('textarea.chat-input-textarea')
  await composer.fill('my own mode')
  await composer.press('Enter')
  const body = (await sent).postDataJSON() as Record<string, unknown>
  expect(body.mode).toBe(own)
  // The engine and model were not touched: still the project's, left to the server.
  expect(body.engine).toBeUndefined()
  expect(body.model).toBeUndefined()
})

test("a Codex project's session names the project's mode until one is picked in the session", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const cwd = freshFolder('pld-codex')
  const project = `Codex Lab ${stamp}`
  expect((await page.request.post('/api/tasks', { data: { title: `Seed codex ${stamp}`, project, pinned: false } })).ok()).toBe(true)
  expect((await page.request.put(`/api/projects/${encodeURIComponent(project)}/metadata`, {
    data: { default_cwd: cwd, default_engine: 'codex', default_mode: 'plan' },
  })).ok()).toBe(true)
  await loadHome(page)
  const panel = await openDraftOnCwd(page, cwd)
  const sent = page.waitForRequest((r) => r.url().includes('/api/sessions/quick-start') && r.method() === 'POST')
  const composer = panel.locator('textarea.chat-input-textarea')
  await composer.fill('hello from a Codex project')
  await composer.press('Enter')
  const taskId = ((await (await (await sent).response())?.json()) as { taskId?: string }).taskId
  const sessionOf = async () => {
    const t = await (await page.request.get(`/api/tasks/${taskId}`)).json() as { task?: { session_id?: string }; session_id?: string }
    return (t.task ?? t).session_id
  }
  await expect.poll(sessionOf, { timeout: 20_000 }).toBeTruthy()
  const sessionId = (await sessionOf())!

  const live = page.locator('.main-page-session-column .session-panel:not(.pending-session-panel):not(.draft-session-panel)').first()
  await expect(live).toBeVisible({ timeout: 20_000 })
  const modeRow = page.getByTestId('launch-source-note').locator('.launch-source-row[data-key="mode"]')
  // The start writes the adapter preset it ran on to the record: that is no pick.
  await expect.poll(async () => {
    await live.locator('.composer-model-pill').first().click()
    const text = await modeRow.innerText().catch(() => '')
    await page.keyboard.press('Escape')
    return text.replace(/\s+/g, ' ')
  }, { timeout: 15_000 }).toMatch(/Plan \(.+\) Project/)

  // The project's Plan is Codex's plan collaboration mode from the first prompt, not only a label.
  const controls = await (await page.request.get(`/api/sessions/${sessionId}/controls`)).json() as { controls: Array<{ id: string; currentValue: string; options: Array<{ value: string }> }> }
  expect(controls.controls.find((c) => c.id === 'collaboration_mode')?.currentValue).toBe('plan')

  // A model picked in the session is the task's own at once; the engine's default was no one's.
  await live.locator('.composer-model-pill').first().click()
  const modelRow = page.getByTestId('launch-source-note').locator('.launch-source-row[data-key="model"]')
  await expect(modelRow.locator('.launch-source-tag')).toHaveText('Default')
  await page.locator('.model-picker').getByText('Mock GPT Fast', { exact: true }).first().click()
  await page.keyboard.press('Escape')
  await live.locator('.composer-model-pill').first().click()
  await expect(modelRow.locator('.launch-source-value')).toHaveText('Mock GPT Fast')
  await expect(modelRow.locator('.launch-source-tag')).toHaveText('Task')
  await expect(modeRow.locator('.launch-source-tag')).toHaveText('Project')
  await page.keyboard.press('Escape')

  // A preset picked in the session's own mode control is the task's own, after a reload too.
  const mode = controls.controls.find((c) => c.id === 'mode')!
  const other = mode.options.find((o) => o.value !== mode.currentValue)!.value
  expect((await page.request.post(`/api/sessions/${sessionId}/controls`, { data: { id: 'mode', value: other } })).ok()).toBe(true)
  await page.reload()
  await expect(live).toBeVisible({ timeout: 20_000 })
  await live.locator('.composer-model-pill').first().click()
  await expect(modeRow.locator('.launch-source-tag')).toHaveText('Task')
  await page.keyboard.press('Escape')
  // Picked back to the start's preset: the project's again.
  expect((await page.request.post(`/api/sessions/${sessionId}/controls`, { data: { id: 'mode', value: mode.currentValue } })).ok()).toBe(true)
  await page.reload()
  await expect(live).toBeVisible({ timeout: 20_000 })
  await live.locator('.composer-model-pill').first().click()
  await expect(modeRow.locator('.launch-source-tag')).toHaveText('Project')
  await page.keyboard.press('Escape')
})
