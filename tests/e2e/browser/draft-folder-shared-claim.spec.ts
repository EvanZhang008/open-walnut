/**
 * A folder INSIDE a declared folder, and a folder two projects declare
 * (2026-09-28). A team subfolder of a shared checkout was launched and landed in
 * the checkout's project, whose chip read "Tasks from this folder file under X"
 * for a folder that declared nothing; two projects declared the checkout and the
 * alphabetically first one won.
 *
 * Now: an inherited project says which PARENT set it; a folder two projects
 * share sets no project (the row stays Inbox and More says why), so what the
 * user types can decide. Real UI only; page.goto only loads the app. Folders live
 * in the fixture's own temp tree; project names are neutral and stamped.
 */
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import {
  basenameOf, captureDraftRequests, discoverFixtureRoot, draftComposer, draftMenuProject, draftMoreButton,
  draftProjectPill, draftTaskMenu, loadHome, mockQuickParse, nthRequest, openDraftOnCwd, patchClientConfig,
  pickDraftFolder,
} from './draft-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-folder-shared-claim/shots/spec'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })
test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

async function claimFolder(page: Page, project: string, cwd: string): Promise<void> {
  const res = await page.request.put(`/api/projects/${project}/metadata`, { data: { default_cwd: cwd } })
  expect(res.ok(), await res.text()).toBe(true)
}

/** A checkout with a team folder two levels down, like `hub/teams/<team>`. */
function checkoutWithTeam(stem: string): { checkout: string; team: string } {
  const stamp = Date.now().toString(36)
  const checkout = `${fixtureRoot}/projects/${stem}-${stamp}`
  const team = `${checkout}/teams/tide-${stamp}`
  fs.mkdirSync(team, { recursive: true })
  return { checkout, team }
}

async function projectOf(page: Page, taskId: string): Promise<string> {
  const res = await page.request.get(`/api/tasks/${taskId}`)
  return (((await res.json()) as { task: { project?: string } }).task.project) ?? ''
}

async function startDraft(page: Page, panel: ReturnType<Page['locator']>, text: string): Promise<string> {
  await draftComposer(page).fill(text)
  const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await panel.locator('.draft-start-btn').click()
  const body = (await (await res).json()) as { taskId?: string }
  expect(body.taskId).toBeTruthy()
  return body.taskId!
}

test('a subfolder of a declared checkout names the parent that set its project', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const { checkout, team } = checkoutWithTeam('hub-solo')
  const OWNER = `Hub${Date.now().toString(36)}`
  await claimFolder(page, OWNER, `${checkout}/`)
  const log = await captureDraftRequests(page)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, team)
  const chip = draftProjectPill(panel)
  await expect(chip).toHaveText(`Project: ${OWNER}`)
  await expect(chip).toHaveAttribute('title',
    `Tasks in ${basenameOf(checkout)} and the folders inside it file under ${OWNER}. Change it in More.`)
  await draftMoreButton(panel).click()
  await expect(draftMenuProject(page).locator('.draft-task-menu-project-why'))
    .toHaveText(`Set by the parent folder ${basenameOf(checkout)}`)
  await draftTaskMenu(page).screenshot({ path: `${SHOTS}/inherited-more.png` })
  await page.keyboard.press('Escape')

  // The launch still files under it (the organize pass that may refile it is
  // off on the fixture server); the body says the project came from the folder.
  const taskId = await startDraft(page, panel, `inherited folder launch ${Date.now()}`)
  const sent = await nthRequest(log, 'quickStart')
  expect(sent.project).toBe(OWNER)
  expect(sent.projectFromFolder).toBe(true)
  expect(await projectOf(page, taskId)).toBe(OWNER)
})

test('a folder two projects share sets no project, says why, and leaves the pick to the message', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const stamp = Date.now().toString(36)
  const { checkout, team } = checkoutWithTeam('hub-shared')
  const A = `Agent${stamp}`
  const B = `Review${stamp}`
  const MESSAGE_PICK = `Tidepool${stamp}`
  await claimFolder(page, A, `${checkout}/`)
  await claimFolder(page, B, checkout)
  // A folder with its own project first: its project must not follow the row
  // into the shared ground.
  const own = `${fixtureRoot}/projects/own-${stamp}`
  fs.mkdirSync(own, { recursive: true })
  await claimFolder(page, MESSAGE_PICK, own)
  // The typing parse is what may pick the project here; it is off by default.
  await patchClientConfig(page, { quickParse: true })
  const parse = await mockQuickParse(page, {})
  const log = await captureDraftRequests(page)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, own)
  await expect(draftProjectPill(panel)).toHaveText(`Project: ${MESSAGE_PICK}`)
  await pickDraftFolder(page, panel, team)
  await expect(draftProjectPill(panel)).toHaveCount(0)
  await draftMoreButton(panel).click()
  await expect(draftMenuProject(page)).toContainText('Inbox')
  await expect(draftMenuProject(page).locator('.draft-task-menu-project-why'))
    .toHaveText(`Inbox: 2 projects use the folder ${basenameOf(checkout)}`)
  await draftTaskMenu(page).screenshot({ path: `${SHOTS}/shared-more.png` })
  await page.keyboard.press('Escape')

  // The folder decided nothing, so the typed request may: the parse's pick lands.
  parse.set({ project: MESSAGE_PICK })
  await draftComposer(page).fill(`triage the tidepool team tickets ${stamp}`)
  // The ✦ mark: the AI decided it, visibly.
  await expect(draftProjectPill(panel)).toHaveText(`Project: ${MESSAGE_PICK}✦`, { timeout: 15_000 })
  await expect(draftProjectPill(panel)).toHaveAttribute('title', `Walnut picked ${MESSAGE_PICK} from what you typed. Change it in More.`)

  const res = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await panel.locator('.draft-start-btn').click()
  const taskId = ((await (await res).json()) as { taskId: string }).taskId
  const sent = await nthRequest(log, 'quickStart')
  expect(sent.project).toBe(MESSAGE_PICK)
  expect(sent.projectFromFolder).toBeFalsy()
  expect(await projectOf(page, taskId)).toBe(MESSAGE_PICK)
})

test('a shared folder with nothing typed that names a project launches into the Inbox', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const stamp = Date.now().toString(36)
  const { checkout, team } = checkoutWithTeam('hub-inbox')
  await claimFolder(page, `Agent${stamp}`, checkout)
  await claimFolder(page, `Review${stamp}`, checkout)
  await mockQuickParse(page, {})
  const log = await captureDraftRequests(page)
  await loadHome(page)

  const panel = await openDraftOnCwd(page, team)
  await expect(draftProjectPill(panel)).toHaveCount(0)
  const taskId = await startDraft(page, panel, `shared folder launch ${stamp}`)
  const sent = await nthRequest(log, 'quickStart')
  // Not the alphabetically first declarer, and not a new project named after the folder.
  expect(sent.project ?? '').toBe('')
  expect(await projectOf(page, taskId)).toBe('')
  const projects = await (await page.request.get('/api/projects')).json() as { projects?: Array<{ name: string }> }
  expect((projects.projects ?? []).map((p) => p.name)).not.toContain(basenameOf(team))
})
