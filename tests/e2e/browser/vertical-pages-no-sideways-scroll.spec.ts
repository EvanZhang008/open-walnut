/**
 * Pages that scroll up and down never scroll sideways (2026-11-20, the user on the phone: "pages
 * like this scroll up and down, why must they also move left and right? these are all bugs ...
 * it was fixed in the inbox, now Threads has the same problem"). One block wider than its column
 * turns a vertical scroller into a two-way one, because CSS gives `overflow-y: auto` an
 * `overflow-x: auto` too; the fix is always to lay the block out to the width, never to clip the
 * page.
 *
 * Seeds the longest kinds of text the user's own pages hold (a long absolute path followed by a
 * full-width semicolon, commit URLs joined by an ideographic comma, task pills inside CJK sentences,
 * a Markdown table, a 300-character code line, a 160-character token, a long title) into an Org
 * lead's Threads with answers, its Brief, its Tasks and the task opened beside it, its chat, Home
 * with the task's session, the Inbox list and an opened letter, Notes (list and the note) and
 * Settings. Each is visited by real clicks at 390x844 (the phone layout) and 1280x800, and every
 * vertical scroller on screen must be no wider inside than its box (sideways-scroll-helpers.ts).
 * Failures are collected per page so one run names every page that is too wide.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openAllSections, showTasks, taskOpener } from './org-view-helpers'
import { PHONE, backButton, menuButton, openDrawer } from './phone-helpers'
import { describeSideways, sidewaysScrollers } from './sideways-scroll-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Wide pages ${STAMP}`
const NOTE = `wide-pages-${STAMP}`
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/vertical-pages`
const made: string[] = []
const ids = { work: '', lead: '', letter: '' }

// Both sizes share one seed (one worker), and a failure at one size still lets the other run.
test.describe.configure({ mode: 'default' })
test.setTimeout(300_000)
// A step that cannot reach its page fails in seconds and the walk goes on to the next page.
test.use({ actionTimeout: 15_000 })

// "this is a long sentence about the task" and friends, in CJK (test data only).
const CJK = '\u8fd9\u662f\u4e00\u4e2a\u5173\u4e8e\u4efb\u52a1\u7684\u5f88\u957f\u7684\u53e5\u5b50'
const SEMI = '\uff1b'
const COMMA = '\u3001'
const UUID = '0b6f2c1e-4d8a-4c3b-9f1e-7a2d5c8e9b10'
const LONG_PATH = `/Users/someone/.local/state/open-walnut/tasks/${UUID}/videos/top-thread.mp4`
const COMMITS = ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2', '0a1b2c3d', '4e5f6a7b']
  .map((h) => `https://github.com/someone/open-walnut/commit/${h.repeat(5)}`).join(COMMA)
const TOKEN = `wn${'a1b2c3d4e5'.repeat(16)}`
const CODE_LINE = `const wide = "${'abcdefghij'.repeat(29)}"`
const HEAD = `Long title ${STAMP}`
// Not the project's name: a contact named by the project would resolve to this task.
const TITLE = `${HEAD} ${CJK}${LONG_PATH}${SEMI}${TOKEN.slice(0, 90)}`

function longMarkdown(taskId: string): string {
  const pill = `<task-ref id="${taskId}" label="Wide pages work"/>`
  return [
    `${CJK}${LONG_PATH}${SEMI}${CJK}${LONG_PATH.replace('top-thread', 'second-take')}${SEMI}${CJK}`,
    `${CJK}${COMMA}${COMMITS}`,
    `${CJK}${pill}${CJK}${pill}${CJK}`,
    ['| Path | Commit | Token |', '| --- | --- | --- |', `| ${LONG_PATH} | ${COMMITS.split(COMMA)[0]} | ${TOKEN} |`].join('\n'),
    ['```text', CODE_LINE, '```'].join('\n'),
    TOKEN,
  ].join('\n\n')
}

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function startSession(request: APIRequestContext, cwd: string, taskId: string, text: string): Promise<void> {
  await post(request, '/api/sessions/quick-start', { cwd, message: `snapshot-clean-turn:${text}`, taskId })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(200_000)
  const { fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  ids.work = (await post<{ task: { id: string } }>(request, '/api/v1/tasks', { title: TITLE, project: PROJECT, description: longMarkdown('') })).task.id
  made.push(ids.work)
  const md = longMarkdown(ids.work)
  // Two tasks: a project with one names that task its contact, with more it gets a lead.
  made.push((await post<{ task: { id: string } }>(request, '/api/v1/tasks', { title: `Other ${STAMP}`, project: PROJECT })).task.id)
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  await startSession(request, cwd, ids.work, md)
  await startSession(request, cwd, ids.lead, md)
  // It waits on the user, so a phone's Home leads with it in Needs you (its title at full length).
  const parked = await request.patch(`/api/tasks/${ids.work}`, { data: { phase: 'NEED_ACTION' } })
  expect(parked.ok(), await parked.text()).toBe(true)
  const at = new Date(Date.now() - 60_000).toISOString()
  const threads = [0, 1, 2].map((n) => ({
    id: `th-${(0xa00 + n).toString(16).padStart(12, '0')}`,
    title: n === 0 ? TITLE : `Wide thread ${n} ${CJK}${LONG_PATH}`, titled: true,
    state: ['needs', 'answered', 'working'][n], createdAt: at, updatedAt: at,
    messages: [{ id: `tm-wide-${n}`, at, text: md, via: 'chat', answer: { at: new Date(Date.parse(at) + 1000 + n).toISOString(), text: md } }],
  }))
  fs.mkdirSync(`${walnutHome}/org/threads`, { recursive: true })
  fs.writeFileSync(`${walnutHome}/org/threads/${ids.lead}.json`, JSON.stringify({ version: 1, taskId: ids.lead, threads }))
  const brief = await request.put(`/api/v1/tasks/${ids.lead}/brief`, { data: { content: `### Needs you\n\n${md}\n\n### Working\n\n${md}\n\n### Waiting\n\n${TOKEN}` } })
  expect(brief.ok(), await brief.text()).toBe(true)
  // An info letter enters the inbox only as a report the user asked for (520fd93f76); unmarked it
  // becomes a notice, and the inbox pages below would have no letter to show.
  const letter = await request.post('/api/v1/human-inbox', { data: { subject: TITLE, type: 'info', markdown: md, user_asked: true } })
  expect(letter.status(), await letter.text()).toBe(201)
  ids.letter = (await letter.json()).id
  const note = await request.put(`/api/notes-v2/content/${NOTE}.md`, { data: { content: `# ${TITLE}\n\n${md}` } })
  expect(note.ok(), await note.text()).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
  if (ids.letter) await request.delete(`/api/v1/human-inbox/${ids.letter}`)
  await request.delete(`/api/notes-v2/content/${NOTE}.md`)
})

/** A page of the side bar: on a phone the drawer opens first. */
async function nav(page: Page, target: string): Promise<void> {
  // A layer the last page opened (the notification center, a task's session) closes first.
  await closeLayers(page)
  if (await menuButton(page).isVisible()) await openDrawer(page)
  await page.locator('#primary-sidebar').locator(target).filter({ visible: true }).first().click()
}

/** Closes the notification center (Escape closes its reader, then itself) and a task's session. */
async function closeLayers(page: Page): Promise<void> {
  for (let i = 0; i < 3 && await page.locator('.notification-panel').isVisible(); i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  const close = page.getByRole('button', { name: 'Close session panel' }).filter({ visible: true })
  if (await close.count()) await close.first().click()
  // A phone's pushed screen (a task, a letter) goes back to the page under it.
  for (let i = 0; i < 3 && await backButton(page).isVisible(); i++) {
    await backButton(page).click()
    await page.waitForTimeout(300)
  }
}

/** The lead's side bar on one view; a phone may start with the side bar folded away. */
async function railView(page: Page, view: 'threads' | 'brief' | 'task'): Promise<void> {
  const toggle = page.getByTestId('org-rail-toggle')
  if (await toggle.count() && await toggle.getAttribute('aria-pressed') === 'false') await toggle.click()
  await expect(async () => {
    await page.getByTestId(`org-top-${view}`).click()
    await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', view, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
}

async function openLead(page: Page): Promise<void> {
  await nav(page, '[data-testid="sidebar-org"]')
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  await page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.toLowerCase()}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', `project:${PROJECT.toLowerCase()}`)
}

for (const size of [{ width: 390, height: 844, phone: true }, { width: 1280, height: 800, phone: false }]) {
  test.describe(`at ${size.width}x${size.height}`, () => {
    test.use(size.phone
      ? { viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: PHONE.userAgent }
      : { viewport: { width: size.width, height: size.height } })

    test('no vertical page scrolls sideways with the longest real text', async ({ page }) => {
      const found: string[] = []
      const check = async (where: string) => {
        // A layout that settles after a fetch or a font: give it a frame, then judge.
        await page.waitForTimeout(400)
        const wide = describeSideways(where, await sidewaysScrollers(page))
        const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
        if (doc.sw > doc.iw + 1) wide.push(`${where}: documentElement.scrollWidth ${doc.sw} > innerWidth ${doc.iw}`)
        found.push(...wide)
        fs.mkdirSync(SHOTS, { recursive: true })
        if (wide.length) await page.screenshot({ path: `${SHOTS}/${size.width}-${where.replace(/\W+/g, '-')}.png` })
      }
      const step = async (where: string, run: () => Promise<void>) => {
        try { await run(); await check(where) } catch (e) {
          found.push(`${where}: could not reach the page: ${(e as Error).message.split('\n').filter((l) => l.trim()).slice(0, 8).join(' | ')}`)
          await page.screenshot({ path: `${SHOTS}/${size.width}-${where.replace(/\W+/g, '-')}-unreached.png` }).catch(() => {})
        }
      }
      await isolateUiPrefs(page)
      await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
      await loadHome(page)
      if (size.phone) await expect(page.locator('.phone-needs-you-row').filter({ hasText: HEAD }).first()).toBeVisible({ timeout: 30_000 })
      await check('home')
      await step('home task session', async () => {
        await page.locator('.todo-panel').getByText(HEAD).filter({ visible: true }).first().click()
        await expect(page.locator('.session-history').filter({ hasText: TOKEN.slice(0, 20) }).first()).toBeVisible({ timeout: 30_000 })
      })
      await step('org threads', async () => {
        await openLead(page)
        await railView(page, 'threads')
        await expect(page.getByTestId('org-thread').first()).toBeVisible({ timeout: 20_000 })
      })
      await step('org threads opened', async () => {
        const cards = page.getByTestId('org-thread')
        for (let i = 0; i < await cards.count(); i++) {
          const toggle = cards.nth(i).getByTestId('org-thread-unread-toggle')
          if (await toggle.count()) await toggle.click()
          const more = cards.nth(i).getByTestId('org-thread-answer-body-more')
          if (await more.count() && /Show more/.test(await more.innerText())) await more.click()
          // The whole conversation: every ask and every answer, the user's own long words too.
          const head = cards.nth(i).getByTestId('org-thread-head')
          if (await head.getAttribute('aria-expanded') === 'false') await head.click()
        }
        await expect(page.getByTestId('org-thread-messages').first()).toBeVisible()
      })
      await step('org brief', async () => {
        await railView(page, 'brief')
        await expect(page.getByTestId('org-brief')).toContainText(TOKEN.slice(0, 20), { timeout: 20_000 })
      })
      await step('org tasks', async () => {
        await railView(page, 'task')
        await showTasks(page)
        await openAllSections(page)
      })
      await step('org task opened beside', async () => {
        await taskOpener(page, ids.work).click()
        await expect(page.getByTestId('org-side').first()).toBeVisible({ timeout: 30_000 })
      })
      await step('org chat', async () => {
        await closeLayers(page)
        if (!(await page.getByTestId('org-detail').isVisible())) await openLead(page)
        const toggle = page.getByTestId('org-rail-toggle')
        if (size.phone && await toggle.count() && await toggle.getAttribute('aria-pressed') === 'true') await toggle.click()
        // Its last turn is the team note about the parked task: long pills, paths and all.
        await expect(page.locator('[data-testid="org-chat"]').filter({ hasText: HEAD }).first()).toBeVisible({ timeout: 30_000 })
      })
      await step('inbox list', async () => {
        await nav(page, 'a[href="/"]')
        await page.getByRole('button', { name: /^Notifications/ }).first().click()
        await page.locator('.notification-panel .nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
        await expect(page.locator('.notification-panel .hib-row').filter({ hasText: HEAD }).first()).toBeVisible({ timeout: 20_000 })
      })
      await step('inbox letter', async () => {
        await page.locator('.notification-panel .hib-row').filter({ hasText: HEAD }).locator('.hib-subject').first().click()
        await expect(page.locator('.hib-reader .hib-view')).toContainText(TOKEN.slice(0, 20), { timeout: 20_000 })
      })
      await step('notes list', async () => {
        await nav(page, 'a[href="/notes"]')
        await expect(page.locator('.notes-search-input').first()).toBeVisible({ timeout: 30_000 })
      })
      await step('note', async () => {
        await page.locator(`.notes-tree-body [data-node-path="${NOTE}.md"]`).first().click()
        await expect(page.locator('.notes-editor-pane .tiptap').first()).toContainText(TOKEN.slice(0, 20), { timeout: 20_000 })
      })
      await step('settings', async () => {
        await nav(page, 'a[href="/settings"]')
        await expect(page).toHaveURL(/\/settings/)
      })
      expect(found, found.join('\n')).toEqual([])
    })
  })
}
