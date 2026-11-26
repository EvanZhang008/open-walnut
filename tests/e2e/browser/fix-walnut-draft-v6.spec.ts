/**
 * The v6 new task draft's Fix Walnut quick action (experiment project_first_start), the row under
 * Recent: it says where the session runs (Walnut's own source), one click turns the draft into the
 * repair draft, and Start opens a repair session there. Quick chat keeps the row's slot, hidden, so
 * the composer never moves; with no repair target there is no row at all.
 *
 * Real UI and server (it runs from this checkout, so this checkout is the source); only the Claude
 * CLI is mocked.
 */
import { expect, test, type Page } from '@playwright/test'
import { draftComposer, draftPanel, openDraft } from './draft-helpers'
import { expectSameGeometry, geometry, openHome, shot, tile, v6, watchErrors } from './project-first-start-helpers'

// Evan's window (1200 x 794), light theme.
test.use({ viewport: { width: 1200, height: 794 }, deviceScaleFactor: 1, colorScheme: 'light' })
// One after another: the experiment is a server-wide setting.
test.describe.configure({ mode: 'default' })

interface SelfRepair { available: boolean; source: { dir: string } | null; cloneDir: string; repoUrl: string }

const fixRow = (page: Page) => draftPanel(page).getByTestId('draft-v6-fix-walnut-row')
const fixKey = (page: Page) => draftPanel(page).getByTestId('draft-v6-fix-walnut')
const slot = (page: Page) => draftPanel(page).getByTestId('draft-v6-fix-walnut-slot')

async function sourceDir(page: Page): Promise<string> {
  const config = await (await page.request.get('/api/config')).json() as { selfRepair?: SelfRepair | null }
  const dir = config.selfRepair?.source?.dir ?? ''
  expect(dir, 'the fixture server reports no Walnut source').toBeTruthy()
  return dir
}

/**
 * The experiment on for this page only (its /api/config answer), never for the shared fixture server:
 * other specs run beside this one and read the server's own setting. `selfRepair` replaces where a
 * repair would run, when given.
 */
async function configAs(page: Page, selfRepair?: SelfRepair | null): Promise<void> {
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    try {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      const config = (body.config ?? {}) as { experimental?: Record<string, boolean> }
      const experimental = { ...config.experimental, project_first_start: true }
      await route.fulfill({ response, json: { ...body, config: { ...config, experimental }, ...(selfRepair !== undefined ? { selfRepair } : {}) } })
    } catch {
      // The page closed with this read in flight.
    }
  })
}

test.beforeEach(async ({ page }) => { await configAs(page) })

test('Fix Walnut sits under Recent, says where, and Quick chat keeps its slot', async ({ page }) => {
  const errors = watchErrors(page)
  const source = await sourceDir(page)
  await openHome(page)
  const panel = await openDraft(page)
  await expect(v6(panel)).toBeVisible()
  await expect(fixKey(page)).toHaveText('Fix Walnut')
  await expect(fixKey(page).locator('svg')).toHaveCount(1)
  const where = fixRow(page).locator('.draft-v6-fix-where')
  await expect(where).toHaveAttribute('title', source)
  await expect(where).toHaveText(/^in (~|\/)/)
  expect(source.endsWith((await where.innerText()).replace(/^in ~?/, ''))).toBe(true)
  // Under the Recent row, left-aligned with it, inside the draft's column.
  const lower = (await panel.getByTestId('draft-v6-lower').boundingBox())!
  const row = (await fixRow(page).boundingBox())!
  expect(row.y).toBeGreaterThanOrEqual(lower.y + lower.height - 0.5)
  expect(Math.abs(row.x - lower.x)).toBeLessThan(1)
  expect(row.x + row.width).toBeLessThanOrEqual(lower.x + lower.width + 0.5)
  await shot(page, 'fix-walnut-row')

  // Quick chat: hidden and unreachable, and the composer stands still.
  const base = await geometry(panel)
  await tile(panel, 'chat').click()
  await expect(fixRow(page)).toBeHidden()
  await expect(fixRow(page)).toHaveAttribute('inert', '')
  await expectSameGeometry(panel, base, 'Quick chat')
  await tile(panel, 'task').click()
  await expect(fixKey(page)).toBeVisible()
  await expectSameGeometry(panel, base, 'back to Start task')
  // A narrow draft (about 515 px, Evan's column): the key stays whole, only the folder words cut.
  await page.setViewportSize({ width: 860, height: 794 })
  await expect(fixKey(page)).toBeVisible()
  const key = (await fixKey(page).boundingBox())!
  const narrow = (await panel.getByTestId('draft-v6-lower').boundingBox())!
  expect(key.x + key.width).toBeLessThanOrEqual(narrow.x + narrow.width)
  expect(await fixKey(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await shot(page, 'fix-walnut-row-narrow')
  expect(errors).toEqual([])
})

test('a click makes this draft the repair draft in place, and Start opens a session in Walnut\'s source', async ({ page }) => {
  const errors = watchErrors(page)
  const source = await sourceDir(page)
  await openHome(page)
  const panel = await openDraft(page)
  const base = await geometry(panel)
  await draftComposer(page).fill('the inbox badge stays after reading')
  await fixKey(page).click()
  // The same layout and the same composer: the words stay, the focus stays, nothing moves.
  await expect(panel.locator('.session-panel-title')).toHaveText('Fix Walnut')
  await expect(v6(panel)).toBeVisible()
  await expect(slot(page)).toBeVisible()
  await expect(panel.getByTestId('draft-v6-where')).toHaveCount(0)
  await expect(slot(page).locator('.draft-v6-fix-target')).toHaveAttribute('title', source)
  await expect(slot(page).getByTestId('draft-v6-fix-walnut-dir')).toHaveText(/walnut/i)
  await expect(fixKey(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(draftComposer(page)).toBeFocused()
  await expect(draftComposer(page)).toHaveValue('the inbox badge stays after reading')
  await expectSameGeometry(panel, base, 'repair draft')
  // The target sits in the row's slot, over the composer, its \u00d7 inside the field.
  const field = (await slot(page).locator('.draft-v6-fix-target').boundingBox())!
  const leave = (await slot(page).getByTestId('draft-v6-fix-walnut-leave').boundingBox())!
  const composer = (await panel.locator('.draft-v6-input').boundingBox())!
  expect(field.height).toBe(48)
  expect(field.y + field.height).toBeLessThanOrEqual(composer.y)
  expect(leave.x).toBeGreaterThan(field.x + field.width / 2)
  expect(leave.y).toBeGreaterThanOrEqual(field.y)
  expect(leave.y + leave.height).toBeLessThanOrEqual(field.y + field.height)
  await shot(page, 'fix-walnut-repair-draft')
  // Start sends what is there: a repair launch at the source, on this computer.
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await draftComposer(page).press('Enter')
  const res = await response
  expect(res.status(), await res.text()).toBe(200)
  const sent = res.request().postDataJSON() as Record<string, unknown>
  const answer = await res.json() as { taskId?: string }
  expect(sent.intent).toBe('fix-walnut')
  expect(sent.cwd).toBe(source)
  expect(sent.host ?? null).toBeNull()
  expect(sent.message).toBe('the inbox badge stays after reading')
  const task = await (await page.request.get(`/api/tasks/${answer.taskId!}`)).json() as { task: { title: string; project: string } }
  expect(task.task.title).toBe('Fix Walnut: the inbox badge stays after reading')
  expect(task.task.project).toBe('Walnut')
  // The session opens in its own column, under that title.
  const session = page.locator('.main-page-session-column .session-panel:not(.draft-session-panel)').filter({ hasText: 'Fix Walnut: the inbox badge stays after reading' })
  await expect(session.first()).toBeVisible({ timeout: 60_000 })
  await shot(page, 'fix-walnut-session')
  expect(errors).toEqual([])
})

test('every way back gives the draft its place again: the pressed key, the \u00d7, a Recent place, Quick chat', async ({ page }) => {
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const title = panel.locator('.session-panel-title')
  const whereText = () => panel.getByTestId('draft-v6-where').innerText()
  const plain = async (step: string) => {
    await expect(title, step).toHaveText('New task')
    await expect(slot(page), step).toHaveCount(0)
    await expect(fixKey(page), step).toHaveAttribute('aria-pressed', 'false')
  }
  // The places used before are the list under the row (e6b38437d8 turned the Recent chips into
  // DraftRecentList rows). Folder rows only: a folder row's title ends with the folder it picks.
  const places = panel.getByTestId('draft-v6-recent-list').locator('[data-testid="draft-v6-recent-row"][data-kind="folder"]')
  // The list fills in when the page's working-dirs answer lands: wait for it, never read it once.
  await expect.poll(() => places.count(), { message: 'the fixture has Recent folders' }).toBeGreaterThan(1)
  // Stand on a Recent folder first: that is where each way back must land.
  await places.first().click()
  await expect(places.first()).toHaveAttribute('aria-selected', 'true')
  const before = await whereText()
  // The key again.
  await fixKey(page).click()
  await expect(title).toHaveText('Fix Walnut')
  await fixKey(page).click()
  await plain('the key')
  expect(await whereText()).toBe(before)
  // The \u00d7 on the target, from the keyboard: the focus goes back to the composer.
  await fixKey(page).click()
  await slot(page).getByTestId('draft-v6-fix-walnut-leave').focus()
  await page.keyboard.press('Enter')
  await plain('the \u00d7')
  expect(await whereText()).toBe(before)
  await expect(draftComposer(page)).toBeFocused()
  // Another Recent place: the pick lands on the plain draft, and Start is a plain start there.
  await fixKey(page).click()
  await expect(title).toHaveText('Fix Walnut')
  const other = places.nth(1)
  // "Use: <name> (<machine>: <folder>)": the folder, home folded to ~.
  const otherDir = /: ([^:()]+)\)$/.exec(String(await other.getAttribute('title')))?.[1]
  expect(otherDir, 'a folder row names its folder').toBeTruthy()
  await other.click()
  await plain('a Recent place')
  await expect(other).toHaveAttribute('aria-selected', 'true')
  const bodies: Array<Record<string, unknown>> = []
  await page.route((url) => url.pathname === '/api/sessions/quick-start', async (route) => {
    bodies.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 400, json: { error: 'Answered by the spec: nothing was started' } })
  })
  await draftComposer(page).fill('a plain task after all')
  await draftComposer(page).press('Enter')
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0].intent).toBeUndefined()
  expect(String(bodies[0].cwd)).toContain(otherDir!.replace(/^~/, ''))
  expect(errors).toEqual([])
})

test('Quick chat from the repair draft, then Start task: a plain draft again', async ({ page }) => {
  const errors = watchErrors(page)
  await openHome(page)
  const panel = await openDraft(page)
  const title = panel.locator('.session-panel-title')
  await fixKey(page).click()
  await expect(title).toHaveText('Fix Walnut')
  await tile(panel, 'chat').click()
  await expect(title).not.toHaveText('Fix Walnut')
  await expect(fixRow(page)).toBeHidden()
  await tile(panel, 'task').click()
  await expect(title).toHaveText('New task')
  await expect(slot(page)).toHaveCount(0)
  await expect(panel.getByTestId('draft-v6-where')).toContainText('~')
  expect(errors).toEqual([])
})

test('an npm install: the row says Start clones the source first', async ({ page }) => {
  await configAs(page, { available: true, source: null, cloneDir: '/tmp/pw-npm-home/open-walnut', repoUrl: 'https://example.invalid/open-walnut.git' })
  await openHome(page)
  await openDraft(page)
  await expect(fixRow(page).locator('.draft-v6-fix-where')).toHaveText("Start clones Walnut's source into /tmp/pw-npm-home/open-walnut first")
  await fixKey(page).click()
  await expect(slot(page)).toContainText("Walnut's source is not here yet: Start clones it first")
  await expect(slot(page).getByTestId('draft-v6-fix-walnut-dir')).toHaveText('/tmp/pw-npm-home/open-walnut')
  await shot(page, 'fix-walnut-clone')
})

test('no repair possible: no Fix Walnut row', async ({ page }) => {
  await configAs(page, { available: false, source: null, cloneDir: '', repoUrl: '' })
  await openHome(page)
  const panel = await openDraft(page)
  await expect(v6(panel)).toBeVisible()
  await expect(fixRow(page)).toHaveCount(0)
})
