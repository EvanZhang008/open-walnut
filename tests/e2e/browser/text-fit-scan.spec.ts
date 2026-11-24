/**
 * No title is cut on the main screens (standard.md, "Text that does not fit"; text-fit.css).
 *
 * 2026-11-21, the UI audit on the user's own data: task titles in the task panel and search
 * results lost the part that tells tasks apart while the small icons and the time beside them kept
 * their room; Org names were cut at every tree level while right-edge counts stayed; notification
 * titles were cut above a smaller cut source line. This scan walks those screens (and Mail, on its
 * own fixture server with a long subject and a long sender) with long titles
 * at the user's window (1512), a laptop (1280), a small window (1024) and the Org list dragged to
 * its narrowest, and fails when a title, name, subject or summary is cut while metadata in its row
 * kept its room, or when any part of one is hidden (by its own ellipsis or clamp, or by an
 * ancestor that clips it). A new view that cuts its title fails here
 * (and its CSS fails cutTitle in tests/web/ui-standard-ratchet.test.ts).
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { findCutTitles, violations } from './text-fit-helpers'
import { openHome } from './home-navigation-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { deliver, mailRow, openMailAnyWidth, startGroupsFixture } from './mail-grouping-helpers'
import { showAllMail, smartRow, warmMail, type MailFixture, type MailFixtureServer } from './mail-review-helpers'

const STAMP = Date.now().toString(36)
// Its own project, so no other spec's tasks share (or fold) its group.
const PROJECT = `Textfit ${STAMP}`
// Long enough to wrap in every column; the end of each is what tells the tasks apart.
const LATIN = [
  `Garden watering watch leader (shed box): the pumps, the timers and the hose workers, north bed ${STAMP}`,
  `Resolver group ticket triage with the weekly report, the escalation list and the handover notes ${STAMP}`,
]
// Test data only (language rule): a long CJK title, as the user's own task titles are.
const CJK = `新任务按 project 开：选 project 不选文件夹，自动开新工作区、做完自己收尾并报告结果 ${STAMP}`
// A VP's name is at most 60 characters.
const VP = `Garden operations planning office ${STAMP}`
const LETTER = `A letter with a full-length subject: review the garden schedule, the tool inventory and the next steps ${STAMP}`
// A mail whose subject runs past one line of the list and of the reader at every width (the list
// takes the whole room while nothing is open), and a sender name about as long as one line.
const MAIL_SUBJECT = `Winter timetable for the north pier ferry: the new boarding gates, the parking rules, the late sailings, the bicycle racks, the season tickets and the shuttle that meets every boat ${STAMP}`
const MAIL_FROM = { name: 'Harbour district community garden volunteers, allotment coordination and tool library desk', address: 'coordination.desk.allotments@garden-volunteers.example.invalid' }

/** How many lines a box's text takes: more than one proves the text needed the room it got. */
async function lines(target: Locator): Promise<number> {
  return target.evaluate((el) => el.getBoundingClientRect().height / (Number.parseFloat(getComputedStyle(el).lineHeight) || 18))
}

const made: { tasks: string[]; letters: string[] } = { tasks: [], letters: [] }

// One seed for every width.
test.describe.configure({ mode: 'serial' })

async function createTask(request: APIRequestContext, title: string): Promise<void> {
  const res = await request.post('/api/tasks', { data: { title, source: 'local', project: PROJECT, pinned: false } })
  expect(res.ok(), await res.text()).toBe(true)
  made.tasks.push(((await res.json()) as { task: { id: string } }).task.id)
}

test.beforeAll(async ({ request }) => {
  for (const t of [...LATIN, CJK]) await createTask(request, t)
  const vp = await request.post('/api/v1/org/vps', { data: { name: VP } })
  expect(vp.ok(), await vp.text()).toBe(true)
  made.tasks.push(((await vp.json()) as { task: { id: string } }).task.id)
  const letter = await request.post('/api/v1/human-inbox', { data: { subject: LETTER, type: 'review', markdown: 'The garden group needs a reply about the whole schedule.' } })
  expect(letter.status()).toBe(201)
  made.letters.push((await letter.json()).id)
})

test.afterAll(async ({ request }) => {
  for (const id of made.letters) await request.post(`/api/v1/human-inbox/${id}/archive`, { data: { archived: true } })
  for (const id of made.tasks) await request.delete(`/api/tasks/${id}?force=true`)
})

/**
 * An Org list row is one line since 91214a493b (the user: the watch rows should be slim): its name
 * is metadata (.wn-meta) that cuts and shows whole in place on hover (truncation-peek-surfaces).
 * The list's own title and every other name there still never cut.
 */
const ORG_ROW_NAME = ['.org-channel > .org-channel-name.wn-meta']

async function expectNoCutTitle(page: Page, scopes: string[], where: string, skip: string[] = []): Promise<void> {
  // Rows draw after the list's first answer; give a late row its chance before measuring.
  await page.waitForTimeout(400)
  const bad = violations(await findCutTitles(page, scopes, skip))
  expect(bad.map((b) => `${where}: .${b.className.split(' ')[0]} hides ${Math.round(b.hidden * 100)}%${b.metaKeptRoom ? ' while metadata kept its room' : ''}: "${b.text}"`), 'A title is cut. Make it .wn-title (web/src/styles/text-fit.css) and cut metadata instead').toEqual([])
}

for (const [width, height] of [[1512, 920], [1280, 800], [1024, 768]] as const) {
  test(`no title is cut on Home, search, Org and Notifications at ${width}`, async ({ page, baseURL }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height })
    await isolateUiPrefs(page)
    await openHome(page, baseURL!)
    const panel = '.home-navigation-scroll'
    // The fixture's Home groups by project: open this spec's own group, where the long titles are.
    const group = page.locator(panel).getByText(PROJECT, { exact: true }).first()
    if (!(await page.locator(panel).getByText(LATIN[0]).isVisible())) await group.click()
    await expect(page.locator(panel).getByText(LATIN[0])).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, [panel], `Home list ${width}`)

    const search = page.locator('input[placeholder^="Search tasks"]').first()
    await search.click()
    await search.fill(STAMP)
    await expect(page.locator(panel).getByText(CJK)).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, [panel], `Search ${width}`)
    await search.fill('')

    await page.getByTestId('sidebar-org').click()
    await expect(page.getByTestId('org-page')).toBeVisible()
    await expect(page.getByTestId('org-page').getByText(VP).first()).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, ['[data-testid="org-page"] .org-list'], `Org list ${width}`, ORG_ROW_NAME)

    // The Org chart's cards: names, current task and project rows.
    await page.getByTestId('org-open-chart').click()
    await expect(page.getByTestId('org-chart-vps').getByText(VP).first()).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, ['[data-testid="org-chart-vps"]'], `Org chart ${width}`)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: /^Notifications/ }).first().click()
    const drawer = page.locator('.notification-panel')
    await drawer.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    await expect(drawer.getByText(LETTER).first()).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, ['.notification-panel'], `Notifications ${width}`)
    await page.keyboard.press('Escape')
  })
}

// Mail runs on its own fixture server (the shared one has no mail provider), seeded once.
test.describe('Mail', () => {
  let server: MailFixtureServer | undefined
  let fixture: MailFixture
  let message: { accountId: string; messageId: string }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000)
    ;({ server, fixture } = await startGroupsFixture())
    const made = await deliver(fixture, 1, { people: 1, subject: MAIL_SUBJECT, from: MAIL_FROM })
    message = made.delivered[0]!
    await warmMail(browser, fixture.port)
  })

  test.afterAll(async () => { await server?.stop() })

  for (const [width, height] of [[1512, 920], [1280, 800], [1024, 768]] as const) {
    test(`no subject or sender is cut in Mail's list and reader at ${width}`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.setViewportSize({ width, height })
      // The flat list, where the delivered mail is its own row (Grouped folds rows into groups).
      await showAllMail(page)
      await openMailAnyWidth(page, fixture.port)
      await smartRow(page, 'inbox').click()
      const row = mailRow(page, message.accountId, message.messageId)
      await expect(row).toBeVisible({ timeout: 60_000 })
      await expect(row).toContainText(MAIL_FROM.name)
      // The subject is longer than the row: it wraps, so the scan below measures a real fit.
      expect(await lines(row.locator('.mail-row-subject'))).toBeGreaterThan(1.5)
      await expectNoCutTitle(page, ['.mail-app'], `Mail list ${width}`)

      await row.click()
      const subject = page.getByTestId('mail-reader-subject')
      await expect(subject).toContainText(MAIL_SUBJECT, { timeout: 30_000 })
      expect(await lines(subject)).toBeGreaterThan(1.5)
      await expectNoCutTitle(page, ['.mail-app'], `Mail reader ${width}`)
    })
  }
})

test('the Org list dragged to its narrowest still cuts no name', async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await page.getByTestId('sidebar-org').click()
  const list = page.locator('[data-testid="org-page"] .org-list')
  await expect(list.getByText(VP).first()).toBeVisible({ timeout: 20_000 })
  const handle = page.locator('.org-list-handle').first()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 600, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
  const width = (await list.boundingBox())!.width
  expect(width).toBeLessThan(260)
  await expectNoCutTitle(page, ['[data-testid="org-page"] .org-list'], `Org list at ${Math.round(width)} px`, ORG_ROW_NAME)
})

// The Tasks page: the project rail and the table's rows (they wrap, and the window measures them).
for (const [width, height] of [[1512, 920], [1024, 768]] as const) {
  test(`no title is cut on the Tasks page at ${width}`, async ({ page, baseURL }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height })
    await isolateUiPrefs(page)
    await openHome(page, baseURL!)
    await page.locator('.sidebar a[href="/tasks"]').click()
    // This spec's own project in the rail: the table then holds only its rows.
    await page.locator('[data-testid="tasks-rail"] .tp-rail-item', { hasText: PROJECT }).click()
    await expect(page.getByTestId('tasks-table').getByText(LATIN[0])).toBeVisible({ timeout: 20_000 })
    await expectNoCutTitle(page, ['[data-testid="tasks-rail"]', '[data-testid="tasks-table"]'], `Tasks page ${width}`)
  })
}

test('the scan finds a cut title beside metadata that kept its room, and passes a wrapped one', async ({ page }) => {
  test.setTimeout(30_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.setContent(`<div id="scope" style="width:240px;font:13px sans-serif">
    <div data-peek-row="" style="display:flex;gap:8px"><span class="demo-title" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${LATIN[0]}</span><span>2h ago</span></div>
    <div style="display:flex;gap:8px"><span class="demo-title wn-title" style="flex:1;min-width:0;white-space:normal">${LATIN[1]}</span><span>2h ago</span></div>
  </div>`)
  const found = violations(await findCutTitles(page, ['#scope']))
  expect(found.map((f) => f.text.slice(0, 20))).toEqual([LATIN[0].slice(0, 20)])
  expect(found[0].metaKeptRoom).toBe(true)
})
