/**
 * The first screen of a brand-new install: an empty board.
 *
 * Reported on a fresh install: the task panel's ONLY visible control was a big
 * dashed "New Project" button, next to a right-hand "Ask Walnut" chat with
 * suggestion chips that looked like a generic chatbot, and users could not tell
 * whether they had to make a project (or talk to the chat) first. The first screen
 * is now: the chat hidden until asked for, ONE "New task" draft column already
 * open, and a task panel that says "No tasks yet" and what to do. Projects are
 * made from the Projects heading's menu instead of a permanent button.
 *
 * The board is empty by construction, not by deleting the shared fixture's tasks:
 * the list, folder, pin and tier reads answer empty for THIS page only, the
 * project registry answers with nothing but what this page created, and the live
 * socket is dead-ended so another spec's task broadcast cannot land on the board
 * mid-assertion (same reasoning as notification-bell-badge.spec.ts). ui-prefs is
 * isolated: the chat key is mirrored to the shared server, and a value another
 * spec left there would decide this spec's first screen.
 *
 * Runs on chromium AND webkit (`PW_WEBKIT=1 … --project webkit`): the Mac app is a
 * WKWebView, and the caret landing in the draft is part of the claim.
 *
 * The quick-action row under the cards belongs to the tab that is up: Start Task
 * offers "Customize Walnut", which turns the draft into the repair draft and says
 * where Walnut's code lives; Ask Walnut offers Walnut's seeds. Line icons, never
 * emoji. The fixture server
 * runs from this checkout, so its `selfRepair.source` is that checkout; the npm
 * install shape (no source yet, a clone on the first Start) is the same server's
 * /api/config answer rewritten for this page. Start is answered by the spec, so no
 * repair session (and never a clone) runs on the shared fixture.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CHAT_VISIBLE_KEY, DRAFT_PANEL, draftComposer, openAskWalnutDrawer } from './draft-helpers'
import { openHome } from './home-navigation-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const SHOTS = '/tmp/onboarding-walk/home'

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true })
})

const slot = (page: Page) => page.locator('.ask-walnut-slot')
const drafts = (page: Page) => page.locator(DRAFT_PANEL)
const navigation = (page: Page) => page.locator('#home-task-navigation')
const emptyBoard = (page: Page) => navigation(page).getByTestId('todo-empty-board')
const sidebarAskWalnut = (page: Page) => page.locator('.sidebar-panel-toggle', { hasText: 'Ask Walnut' })
const projectsHeading = (page: Page) => navigation(page).locator('.navigation-heading[data-navigation-id="tasks"]')
const projectsMenu = (page: Page) => page.getByRole('menu', { name: 'Projects actions' })
/** The heading's ··· takes the pointer only while the heading is hovered
 *  (home-navigation.css), so hover first, the way a mouse gets there. */
async function openProjectsMenu(page: Page) {
  await expect(async () => {
    await projectsHeading(page).hover()
    await projectsHeading(page).getByRole('button', { name: 'Projects menu', exact: true }).click({ timeout: 2_000 })
    await expect(projectsMenu(page)).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  return projectsMenu(page)
}
const newProjectInput = (page: Page) => navigation(page).getByRole('textbox', { name: 'New project name' })
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })

interface Board {
  /** Registry rows this page created through POST /api/projects. */
  createdProjects: string[]
}

/** Answer every board read as a new install would, for this page only. */
async function emptyBoardFor(page: Page, tasks: Array<Record<string, unknown>> = []): Promise<Board> {
  const board: Board = { createdProjects: [] }
  await isolateUiPrefs(page)
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('**/api/tasks?*', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue()
    await route.fulfill({ json: { tasks, completedHidden: 0 } })
  })
  await page.route('**/api/tasks/groups', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ json: { groups: [] } })
  })
  await page.route('**/api/focus/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ json: { pinned_tasks: [], focus_tasks: [], satellite_tasks: [], backlog_tasks: [], wait_tasks: [], custom_tier_tasks: {} } })
  })
  // Other specs leave custom tiers on the shared fixture, and a custom tier draws
  // even when empty.
  await page.route('**/api/focus/tiers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ json: { tiers: [] } })
  })
  await page.route((url) => url.pathname === '/api/projects', async (route) => {
    const counts = { todo: 0, active: 0, done: 0 }
    if (route.request().method() === 'POST') {
      const name = String((route.request().postDataJSON() as { name?: unknown })?.name ?? '').trim()
      board.createdProjects.push(name)
      await route.fulfill({ json: { name, source: 'local', created: true } })
      return
    }
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ json: {
      projects: board.createdProjects.map((name) => ({ name, source: 'local', favorite: false, counts })),
      inbox: { counts },
    } })
  })
  return board
}

interface SelfRepair {
  available: boolean
  source: { dir: string; kind: string } | null
  cloneDir: string
  repoUrl: string
  reason?: string
}

/** GET /api/config for THIS page with `selfRepair` (and `installDir`) replaced.
 *  A path predicate, not a glob: `**\/api/config**` also matches Vite's own
 *  /src/api/config.ts module and breaks the boot. */
async function selfRepairAs(page: Page, selfRepair: SelfRepair, installDir: string | null): Promise<void> {
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    try {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      await route.fulfill({ response, json: { ...body, selfRepair, installDir } })
    } catch {
      // The page closed with this read in flight (a late config refresh).
    }
  })
}

/** Record Start's quick-start body and answer it here, so nothing launches. */
async function captureQuickStart(page: Page): Promise<Array<Record<string, unknown>>> {
  const bodies: Array<Record<string, unknown>> = []
  await page.route((url) => url.pathname === '/api/sessions/quick-start', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 400, json: { error: 'Answered by the spec: nothing was started' } })
  })
  return bodies
}

const customizeChip = (page: Page) => drafts(page).getByTestId('draft-customize-walnut')
const quickActions = (page: Page) => drafts(page).locator('.draft-walnut-suggests[aria-label="Quick actions"]')
const draftHint = (page: Page) => drafts(page).locator('.draft-quick-hint')
const folderPill = (page: Page) => drafts(page).getByRole('button', { name: /^Folder and host: / })

/** The first screen, settled: the task panel is up and has answered "empty". */
async function openFirstScreen(page: Page, baseURL: string): Promise<void> {
  await openHome(page, baseURL)
  await expect(emptyBoard(page)).toBeVisible({ timeout: 30_000 })
}

/** A chat hidden means UNMOUNTED, not a zero-width live panel. */
async function expectChatHidden(page: Page): Promise<void> {
  await expect(slot(page)).toHaveCount(0)
  await expect.poll(async () => (await page.locator('.main-page-chat').boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
}

test('a new install opens on an empty board with one New task draft and no chat', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await emptyBoardFor(page)
  await openFirstScreen(page, baseURL!)

  // Nothing was chosen yet, so nothing is stored: the hidden chat is the default,
  // and so is its toggle: no second "Ask Walnut" entry beside New task, in the
  // sidebar or the Focus Dock, until the spot has been opened once.
  expect(await page.evaluate((key) => localStorage.getItem(key), CHAT_VISIBLE_KEY)).toBeNull()
  await expectChatHidden(page)
  await expect(page.locator('.sidebar-home-panels')).toBeVisible()
  await expect(sidebarAskWalnut(page)).toHaveCount(0)
  await expect(page.locator('.dock-chat-item')).toHaveCount(0)

  // ONE draft column, titled for what it makes, with the caret already in it.
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  const draft = drafts(page)
  await expect(draft).toBeVisible()
  await expect(draft.locator('.session-panel-title')).toHaveText('New task')
  await expect(draftComposer(page)).toBeFocused()

  // The task panel says what to do first, and no project is asked for.
  await expect(emptyBoard(page)).toContainText('No tasks yet')
  await expect(emptyBoard(page)).toContainText('Start with New task above. Projects are created for you as you go.')
  await expect(navigation(page).locator('.new-launcher-btn')).toBeVisible()
  await expect(page.getByRole('button', { name: /new project/i })).toHaveCount(0)
  await expect(page.locator('.todo-new-project-btn')).toHaveCount(0)
  await expect(page.getByText('No tasks found')).toHaveCount(0)
  // The Pinned section is there to be learned, with nothing pinned and no tier under it;
  // the tab bar is a choice, not a default.
  await expect(navigation(page).locator('.navigation-heading[data-navigation-id="pinned"]')).toBeVisible()
  await expect(navigation(page).getByTestId('todo-pinned-empty')).toHaveText(/Nothing pinned yet/)
  await expect(navigation(page).locator('.todo-pinned-subgroup-heading')).toHaveCount(0)
  await expect(page.locator('.todo-section-tabs')).toHaveCount(0)
  await shot(page, 'first-screen')

  // A reload is a new page load: the draft does not survive it, the page opens
  // exactly one again, never two.
  await page.reload()
  await expect(emptyBoard(page)).toBeVisible({ timeout: 30_000 })
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(1_000)
  await expect(drafts(page)).toHaveCount(1)
  await expectChatHidden(page)

  // Closing it is respected for the rest of this page load.
  await drafts(page).locator('.session-panel-close').first().click()
  await expect(drafts(page)).toHaveCount(0)
  await page.waitForTimeout(1_000)
  await expect(drafts(page)).toHaveCount(0)
  // The toolbar's New task is the same column.
  await navigation(page).locator('.new-launcher-btn').click()
  await expect(drafts(page)).toHaveCount(1)
  await expect(drafts(page).locator('.session-panel-title')).toHaveText('New task')

  expect(errors).toEqual([])
})

test('the Projects menu makes a project through the inline name row', async ({ page, baseURL }) => {
  const board = await emptyBoardFor(page)
  await openFirstScreen(page, baseURL!)
  await expect(newProjectInput(page)).toHaveCount(0)

  // The heading's menu carries the item, last, under a divider.
  const menu = await openProjectsMenu(page)
  const item = menu.getByRole('menuitem', { name: 'New project\u2026' })
  await expect(item).toBeVisible()
  await shot(page, 'projects-menu')

  // Esc on the empty row ends it, and the board is as it was.
  await item.click()
  await expect(menu).toHaveCount(0)
  await expect(newProjectInput(page)).toBeVisible()
  await expect(newProjectInput(page)).toBeFocused()
  await shot(page, 'new-project-row')
  await newProjectInput(page).press('Escape')
  await expect(newProjectInput(page)).toHaveCount(0)

  // An empty blur ends it too.
  await (await openProjectsMenu(page)).getByRole('menuitem', { name: 'New project\u2026' }).click()
  await expect(newProjectInput(page)).toBeFocused()
  await emptyBoard(page).click()
  await expect(newProjectInput(page)).toHaveCount(0)

  // A name + Enter creates it: the row closes and the new empty project opens its
  // add row, so the next keystroke is the first task's title.
  const name = `Garden ${Date.now().toString(36)}`
  await (await openProjectsMenu(page)).getByRole('menuitem', { name: 'New project\u2026' }).click()
  await newProjectInput(page).fill(name)
  await newProjectInput(page).press('Enter')
  await expect(newProjectInput(page)).toHaveCount(0)
  await expect.poll(() => board.createdProjects).toEqual([name])
  const group = navigation(page).locator('.todo-group-project-header').filter({ hasText: name })
  await expect(group).toBeVisible()
  await expect(group.locator('xpath=..').locator('.focus-inline-add input')).toBeFocused()
  // The group stands on its own: no "No tasks yet" above an empty project.
  await expect(emptyBoard(page)).toHaveCount(0)
  await shot(page, 'project-created')
})

test('a board with tasks, or an open chat, opens no draft by itself', async ({ page, baseURL }) => {
  const now = new Date().toISOString()
  await emptyBoardFor(page, [{
    id: 'first-open-one-task', title: 'Water the plants', status: 'todo', phase: 'TODO', priority: 'none',
    project: 'Garden', source: 'local', created_at: now, updated_at: now,
    description: '', summary: '', note: '', subtasks: [],
  }])
  await openHome(page, baseURL!)
  // Projects start folded on a fresh browser, so the project row is what shows.
  await expect(navigation(page).locator('.todo-group-project-header').filter({ hasText: 'Garden' })).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(drafts(page)).toHaveCount(0)
  await expect(emptyBoard(page)).toHaveCount(0)
  await expectChatHidden(page)
})

test('a user who opened the chat keeps it, and the empty board then opens no draft', async ({ page, baseURL }) => {
  await emptyBoardFor(page)
  await page.addInitScript((key) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, 'true') }, CHAT_VISIBLE_KEY)
  await openFirstScreen(page, baseURL!)
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_500)
  await expect(drafts(page)).toHaveCount(0)
  // The spot is open, so its toggle is there to close it with.
  await expect(sidebarAskWalnut(page)).toBeVisible()
  await expect(sidebarAskWalnut(page)).toHaveAttribute('aria-label', 'Ask Walnut')
  await expect(sidebarAskWalnut(page)).toHaveClass(/active/)

  // Closing it from the sidebar stores the choice, and a reload keeps it closed.
  await sidebarAskWalnut(page).click()
  await expectChatHidden(page)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), CHAT_VISIBLE_KEY)).toBe('false')
  await page.reload()
  await expect(emptyBoard(page)).toBeVisible({ timeout: 30_000 })
  await expectChatHidden(page)
  // A user who closed it knows it exists: the toggle stays, inactive.
  await expect(sidebarAskWalnut(page)).toBeVisible()
  await expect(sidebarAskWalnut(page)).not.toHaveClass(/active/)
  // (The Focus Dock's cell follows the same rule; home-panel-visibility-relaunch covers it.)
  // Hidden again means a new-install screen again: the draft opens.
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })

  // And an explicit open survives a reload.
  await sidebarAskWalnut(page).click()
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), CHAT_VISIBLE_KEY)).toBe('true')
  await page.reload()
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
})

// ── "Customize Walnut": the way into Walnut's own source ─────────────────────

const FIX_TITLE = 'Customize Walnut'
const NPM_CLONE_DIR = '/tmp/pw-npm-home/open-walnut'
const NPM_REPO_URL = 'https://example.invalid/open-walnut.git'
const npmInstall: SelfRepair = { available: true, source: null, cloneDir: NPM_CLONE_DIR, repoUrl: NPM_REPO_URL }

test('Customize Walnut turns the first draft into a repair draft in Walnut\'s own source', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The fixture server runs from this checkout: that checkout is the source.
  const config = await (await page.request.get('/api/config')).json() as { selfRepair?: SelfRepair | null }
  const source = config.selfRepair?.source?.dir ?? ''
  expect(source, 'the fixture server reports no Walnut source').toBeTruthy()
  await emptyBoardFor(page)
  const starts = await captureQuickStart(page)
  await openFirstScreen(page, baseURL!)

  // The new user's first draft (Start Task tab) offers it as that tab's quick
  // action under the two cards; the Walnut seeds belong to the other tab. Every
  // chip and card carries a line icon.
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  await expect(customizeChip(page)).toHaveText('Customize Walnut', { timeout: 15_000 })
  await expect(quickActions(page).locator('.session-action-chip')).toHaveText(['Customize Walnut'])
  await expect(quickActions(page).locator('.session-action-chip .session-action-chip-ic svg')).toHaveCount(1)
  expect(await quickActions(page).innerText()).not.toMatch(/\p{Extended_Pictographic}/u)
  expect(await drafts(page).locator('.draft-intent-cards').innerText()).not.toMatch(/\p{Extended_Pictographic}/u)
  await expect(drafts(page).locator('.draft-intent-cards .draft-intent-ic svg, .draft-intent-cards .draft-intent-ic img')).toHaveCount(2)
  await shot(page, 'customize-walnut-chip')
  // Taking it rewrites THIS draft, so it never sits beside typed text.
  await draftComposer(page).fill('half a thought')
  await expect(customizeChip(page)).toHaveCount(0)
  await draftComposer(page).fill('')
  await expect(customizeChip(page)).toBeVisible()

  await customizeChip(page).click()
  // The same column, now the repair draft: no cards, no chip, and it says where.
  await expect(drafts(page)).toHaveCount(1)
  await expect(drafts(page).locator('.session-panel-title')).toHaveText(FIX_TITLE)
  await expect(customizeChip(page)).toHaveCount(0)
  await expect(drafts(page).locator('.draft-intent-cards')).toHaveCount(0)
  await expect(draftHint(page)).toHaveText(
    `Opens a session in Walnut's own source at ${source}. Describe what to change or fix; paste a screenshot (\u2318V) if you have one.`,
  )
  await expect(folderPill(page).locator('.draft-pill-name')).toHaveText(path.basename(source))
  await expect(folderPill(page)).toHaveAttribute('aria-label', new RegExp(`^Folder and host: ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on `))
  await expect(draftComposer(page)).toBeFocused()
  await shot(page, 'customize-walnut-repair-draft')

  // Start is a repair launch at that folder, on this computer.
  await draftComposer(page).fill('make the header calmer')
  await draftComposer(page).press('Enter')
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0].intent).toBe('fix-walnut')
  expect(starts[0].cwd).toBe(source)
  expect(starts[0].host ?? null).toBeNull()
  expect(starts[0].walnutAgent).toBeUndefined()
  expect(errors).toEqual([])
})

test('each tab has its own quick actions: Ask Walnut the seeds, Start Task Customize Walnut', async ({ page, baseURL }) => {
  await emptyBoardFor(page)
  await openFirstScreen(page, baseURL!)
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  await expect(customizeChip(page)).toBeVisible({ timeout: 15_000 })
  // Ask Walnut: the seeds, no Customize chip.
  await drafts(page).locator('.draft-intent-card-walnut').click()
  await expect(drafts(page)).toHaveClass(/draft-session-panel-walnut/)
  await expect(quickActions(page).locator('.session-action-chip')).toHaveText(['Which task is\u2026', 'Schedule my day', 'What ran today'])
  await expect(quickActions(page).locator('.session-action-chip .session-action-chip-ic svg')).toHaveCount(3)
  expect(await quickActions(page).innerText()).not.toMatch(/\p{Extended_Pictographic}/u)
  await expect(customizeChip(page)).toHaveCount(0)
  // A seed prefills the composer on this tab and sends nothing; typed text hides the row.
  await quickActions(page).getByRole('button', { name: 'Schedule my day' }).click()
  await expect(draftComposer(page)).toHaveValue('Schedule my day')
  await expect(drafts(page)).toHaveClass(/draft-session-panel-walnut/)
  await expect(quickActions(page)).toHaveCount(0)
  await draftComposer(page).fill('')
  await expect(quickActions(page)).toBeVisible()
  await shot(page, 'ask-walnut-tab-quick-actions')
  // Back on Start Task: Customize Walnut again, and taking it makes the repair draft.
  await drafts(page).locator('.draft-intent-card').first().click()
  await expect(quickActions(page).locator('.session-action-chip')).toHaveText(['Customize Walnut'])
  await customizeChip(page).click()
  await expect(drafts(page).locator('.session-panel-title')).toHaveText(FIX_TITLE)
  await expect(drafts(page)).not.toHaveClass(/draft-session-panel-walnut/)
  await expect(folderPill(page)).toBeVisible()
  await expect(drafts(page).locator('.draft-walnut-suggests')).toHaveCount(0)
})

test('an npm install sees where the clone will land, and Start targets it', async ({ page, baseURL }) => {
  await emptyBoardFor(page)
  await selfRepairAs(page, npmInstall, null)
  const starts = await captureQuickStart(page)
  await openFirstScreen(page, baseURL!)
  await expect(customizeChip(page)).toBeVisible({ timeout: 15_000 })
  await customizeChip(page).click()
  await expect(drafts(page).locator('.session-panel-title')).toHaveText(FIX_TITLE)
  await expect(draftHint(page)).toHaveText(
    `Walnut's source is not on this computer yet. Start clones ${NPM_REPO_URL} into ${NPM_CLONE_DIR} first, then opens a session there.`,
  )
  await expect(folderPill(page).locator('.draft-pill-name')).toHaveText('open-walnut')
  await shot(page, 'customize-walnut-clone-hint')

  await draftComposer(page).fill('first repair on an npm install')
  await draftComposer(page).press('Enter')
  await expect.poll(() => starts.length).toBe(1)
  expect(starts[0].intent).toBe('fix-walnut')
  expect(starts[0].cwd).toBe(NPM_CLONE_DIR)
})

test('an npm install also gets Customize Walnut in the Ask Walnut drawer', async ({ page, baseURL }) => {
  await emptyBoardFor(page)
  await selfRepairAs(page, npmInstall, null)
  await page.addInitScript((key) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, 'true') }, CHAT_VISIBLE_KEY)
  await openFirstScreen(page, baseURL!)
  const drawer = await openAskWalnutDrawer(page)
  const fix = drawer.getByTestId('ask-walnut-fix')
  await expect(fix).toBeVisible({ timeout: 15_000 })
  await fix.click()
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  await expect(drafts(page).locator('.session-panel-title')).toHaveText(FIX_TITLE)
  await expect(draftHint(page)).toContainText(`into ${NPM_CLONE_DIR} first`)
})

test('no repair possible here: no Customize Walnut chip and no drawer entry', async ({ page, baseURL }) => {
  await emptyBoardFor(page)
  const configRead = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/config' && r.request().method() === 'GET')
  await selfRepairAs(page, { ...npmInstall, available: false, reason: 'no-git' }, null)
  await openFirstScreen(page, baseURL!)
  await configRead
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  // The intent cards are up, so the chip row would be too by now; with no repair
  // target the Start Task tab has no quick-action row at all.
  await expect(drafts(page).locator('.draft-intent-cards')).toBeVisible()
  await page.waitForTimeout(1_000)
  await expect(customizeChip(page)).toHaveCount(0)
  await expect(quickActions(page)).toHaveCount(0)

  // The drawer's entry follows the same answer.
  await page.evaluate((key) => localStorage.setItem(key, 'true'), CHAT_VISIBLE_KEY)
  await page.reload()
  const drawer = await openAskWalnutDrawer(page)
  await expect(drawer.getByTestId('ask-walnut-inspector')).toBeVisible()
  await expect(drawer.getByTestId('ask-walnut-fix')).toHaveCount(0)
})
