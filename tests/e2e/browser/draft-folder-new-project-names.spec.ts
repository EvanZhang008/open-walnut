/**
 * "A folder is a project" (2026-09-28). A team folder inside a shared checkout
 * was launched and landed in the checkout's project. Now a folder pick sets the
 * project that declares EXACTLY that folder, else a new project named after the
 * folder; when another project already has the name, the parent folder goes in
 * front (then the host, then a number). The launch stamps the new project with
 * the folder, so the next pick finds it.
 *
 * Real UI only; page.goto only loads the app. Folders live in the fixture's own
 * temp tree; names are neutral and stamped.
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  basenameOf, captureDraftRequests, discoverFixtureRoot, draftComposer, draftPanel, draftPanels,
  draftProjectPill, loadHome, nthRequest, openDraft, openDraftOnCwd, pickDraftFolder, draftSend,
} from './draft-helpers'
import { createTaskForLater } from './draft-outcome-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-folder-new-project-names/shots/spec'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })
test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

async function claimFolder(page: Page, project: string, cwd: string): Promise<void> {
  const res = await page.request.put(`/api/projects/${encodeURIComponent(project)}/metadata`, { data: { default_cwd: cwd } })
  expect(res.ok(), await res.text()).toBe(true)
}

function folder(...parts: string[]): string {
  const cwd = [`${fixtureRoot}/projects`, ...parts].join('/')
  fs.mkdirSync(cwd, { recursive: true })
  return cwd
}

async function projectOf(page: Page, taskId: string): Promise<string> {
  const res = await page.request.get(`/api/tasks/${taskId}`)
  return (((await res.json()) as { task: { project?: string } }).task.project) ?? ''
}

async function folderOf(page: Page, project: string): Promise<string | undefined> {
  const res = await page.request.get(`/api/projects/${encodeURIComponent(project)}/metadata`)
  expect(res.ok(), await res.text()).toBe(true)
  const body = (await res.json()) as { metadata?: { default_cwd?: string }; default_cwd?: string }
  return body.metadata?.default_cwd ?? body.default_cwd
}

async function startDraft(page: Page, panel: Locator, text: string): Promise<string> {
  await panel.locator('.chat-input-textarea').fill(text)
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftSend(panel).click()
  const body = (await (await res).json()) as { taskId?: string }
  expect(body.taskId, JSON.stringify(body)).toBeTruthy()
  return body.taskId!
}

test("a team folder inside a checkout with a project gets its own project, not the checkout's", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const stamp = Date.now().toString(36)
  const checkout = folder(`hub-${stamp}`)
  const team = folder(`hub-${stamp}`, 'teams', `marina-${stamp}`)
  const OWNER = `Hub Agent ${stamp}`
  await claimFolder(page, OWNER, `${checkout}/`)
  const log = await captureDraftRequests(page)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, checkout)
  await expect(draftProjectPill(panel)).toHaveText(`Project: ${OWNER}`)
  await pickDraftFolder(page, panel, team)
  const TEAM = basenameOf(team)
  await expect(draftProjectPill(panel)).toHaveText(`New project: ${TEAM}`)
  await panel.locator('.draft-composer-bar').screenshot({ path: `${SHOTS}/team-folder-new-project.png` })

  const taskId = await startDraft(page, panel, `triage the team tickets ${stamp}`)
  const sent = await nthRequest(log, 'quickStart')
  expect(sent.project).toBe(TEAM)
  expect(sent.projectFromFolder).toBe(true)
  expect(await projectOf(page, taskId)).toBe(TEAM)
  expect(await folderOf(page, TEAM)).toBe(team)
  expect((await folderOf(page, OWNER))?.replace(/\/+$/, '')).toBe(checkout)

  // The next pick of that folder finds the project the launch made.
  const again = await openDraftOnCwd(page, team)
  await expect(draftProjectPill(again)).toHaveText(`Project: ${TEAM}`)
  await expect(draftProjectPill(again)).not.toHaveClass(/draft-project-chip-new/)
})

test("a name another folder's project has grows by the parent folder", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const stamp = Date.now().toString(36)
  const NAME = `pool-${stamp}`
  const theirs = folder(`acme-${stamp}`, NAME)
  const ours = folder(`reef-${stamp}`, NAME)
  await claimFolder(page, NAME, theirs)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, ours)
  const GROWN = `reef-${stamp}-${NAME}`
  await expect(draftProjectPill(panel)).toHaveText(`New project: ${GROWN}`)
  await expect(draftProjectPill(panel)).toHaveAttribute('title', `Starting creates a new project named ${GROWN}. Change it in More.`)
  await panel.locator('.draft-composer-bar').screenshot({ path: `${SHOTS}/grown-name.png` })

  const taskId = await startDraft(page, panel, `work in the second pool ${stamp}`)
  expect(await projectOf(page, taskId)).toBe(GROWN)
  expect(await folderOf(page, GROWN)).toBe(ours)
  expect(await folderOf(page, NAME)).toBe(theirs)
})

test("two open drafts on two same-named folders: starting one renames the other's pill", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const stamp = Date.now().toString(36)
  const NAME = `kelp-${stamp}`
  const first = folder(`north-${stamp}`, NAME)
  const second = folder(`south-${stamp}`, NAME)
  await loadHome(page)

  const a = await openDraftOnCwd(page, first)
  await expect(draftProjectPill(a)).toHaveText(`New project: ${NAME}`)
  // "+" refocuses an EMPTY draft instead of stacking another: give this one text.
  await a.locator('.chat-input-textarea').fill(`north kelp ${stamp}`)
  await openDraft(page)
  // Drafts insert at the strip head: the new one is first, the older one next.
  const b = draftPanel(page)
  await pickDraftFolder(page, b, second)
  await expect(draftPanels(page)).toHaveCount(2)
  const older = draftPanels(page).nth(1)
  await expect(draftProjectPill(b)).toHaveText(`New project: ${NAME}`)
  await expect(draftProjectPill(older)).toHaveText(`New project: ${NAME}`)

  const firstTask = await startDraft(page, older, `north kelp ${stamp}`)
  expect(await projectOf(page, firstTask)).toBe(NAME)
  // The registry event reaches the other draft: its pill now says what Start will do.
  const remaining = draftPanel(page)
  await expect(draftProjectPill(remaining)).toHaveText(`New project: south-${stamp}-${NAME}`, { timeout: 15_000 })
  await remaining.locator('.draft-composer-bar').screenshot({ path: `${SHOTS}/pill-follows-registry.png` })
  const secondTask = await startDraft(page, remaining, `south kelp ${stamp}`)
  expect(await projectOf(page, secondTask)).toBe(`south-${stamp}-${NAME}`)
  expect(await folderOf(page, `south-${stamp}-${NAME}`)).toBe(second)
})

test('a placeholder task from a new folder makes that folder its project', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const stamp = Date.now().toString(36)
  const cwd = folder(`later-${stamp}`, `notes-${stamp}`)
  const NAME = basenameOf(cwd)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, cwd)
  await expect(draftProjectPill(panel)).toHaveText(`New project: ${NAME}`)
  await draftComposer(page).fill(`write the notes later ${stamp}`)
  const taskId = await createTaskForLater(page, panel)
  expect(await projectOf(page, taskId)).toBe(NAME)
  await expect.poll(() => folderOf(page, NAME), { timeout: 10_000 }).toBe(cwd)

  const again = await openDraftOnCwd(page, cwd)
  await expect(draftProjectPill(again)).toHaveText(`Project: ${NAME}`)
})
