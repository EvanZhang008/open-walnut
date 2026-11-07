/**
 * The extension's first page (design option A, 2026-11-07; web/src/popout/ExtHome.tsx,
 * ExtHomeTasks.tsx, ExtRelay.tsx; packages/browser-extension/src/panel-ask.ts, panel-look-home.ts),
 * through the real extension in Chromium, with real mouse and keyboard input:
 *
 * - the side panel and the popup open on New task: ≡, Walnut, the relay pill, the key, settings;
 *   the composer with the page as a chip and Act in this tab; Home's task panel under it (tabs,
 *   search, Needs you, the rows), drawn by the extension the moment it opens;
 * - typing and Send make a task and a session that knows the page, shown in the panel with Back;
 *   Back returns to the list where it was; × leaves the page out; Act in this tab hands the tab over
 *   and the strip shows while the agent holds it, with Stop;
 * - Save as todo files the words as a todo without starting anything;
 * - the tabs and the search are Home's own, over a list of more than 100 tasks;
 * - a task with no conversation opens its detail in the panel, never a new tab;
 * - the relay pill opens the relay panel: agents on and off, the tab in use with Stop, Stop all;
 * - the asks stay one ≡ away;
 * - dark mode.
 *
 * Screenshots (EXT_FIRST_SHOTS, default test-results/extension-first-page) at 400 px, light and dark.
 * Fake data only.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, openPanel, selectText, startPanelLab, sw, type PanelLab } from './extension-panel-harness'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// The key reads the fixture's vault; nothing here locks it or ends an unlock.
holdVaultLock('shared', 'file')

const SHOTS = process.env.EXT_FIRST_SHOTS ?? 'test-results/extension-first-page'
let lab: PanelLab
let panel: Page
/** Every task this file makes (deleted after it). */
const made: string[] = []

const PROJECTS = ['Ops', 'Home', 'Travel', 'Garden']
/** A board as a person's holds them: more than 100 tasks over a few projects, a few that need them. */
const NEEDS = [
  { title: 'Rotate the expired API key on Lab Accounts', project: 'Ops', ask: 'Rotate now or wait for the release?' },
  { title: 'Renew the parking permit', project: 'Home', ask: 'The form is filled, submit it?' },
  { title: 'Book the Denver hotel for Dec 12', project: 'Travel', ask: 'Two rooms left under $180, pick one' },
]

async function shot(p: Page, name: string, dark = false): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  if (dark) await p.emulateMedia({ colorScheme: 'dark' })
  await p.mouse.move(2, 700)
  await p.waitForTimeout(300)
  await p.screenshot({ path: path.join(SHOTS, `${name}${dark ? '-dark' : ''}.png`) })
  if (dark) await p.emulateMedia({ colorScheme: 'light' })
}
async function shots(p: Page, name: string): Promise<void> {
  await shot(p, name)
  await shot(p, name, true)
}

async function openFirstPage(): Promise<Page> {
  const { panel: p } = await openPanel(lab, 'home')
  await p.setViewportSize({ width: 400, height: 760 })
  await expect(askView(p).getByTestId('ext-home')).toBeVisible({ timeout: 60_000 })
  return p
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(400_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'first-page')
  const post = async (data: Record<string, unknown>): Promise<string> => {
    const r = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data })
    expect(r.ok(), await r.text()).toBe(true)
    const j = await r.json() as Record<string, any>
    const id = String(j.task?.id ?? j.id)
    made.push(id)
    return id
  }
  for (const n of NEEDS) {
    const id = await post({ title: n.title, project: n.project })
    const rep = await lab.doc.request.put(`${lab.base}/api/v1/tasks/${id}/report`, { data: { state: 'needs', ask: n.ask } })
    expect(rep.ok(), await rep.text()).toBe(true)
  }
  for (let i = 0; i < 104; i++) await post({ title: `Board task ${String(i + 1).padStart(3, '0')} for the list`, project: PROJECTS[i % PROJECTS.length] })
  for (const t of ['Ship the extension first page', 'Draft the Q4 roadmap', 'Compare three internet plans']) await post({ title: t, project: 'Garden', pinned: true, focus_tier: 'focus' })
  await post({ title: 'Publish the October changelog', project: 'Ops' })
  await post({ title: 'Send the changelog copy to the docs team', project: 'Ops' })
})
test.afterAll(async () => {
  for (const id of made) await lab?.doc.request.delete(`${lab.base}/api/v1/tasks/${id}`).catch(() => undefined)
  await lab?.close()
})


type Kept = { home?: { rows: Array<{ title: string; needs: boolean }>; tabs: Array<{ label: string }> }; mode?: { mode: string; title?: string } }
const kept = () => sw(lab).evaluate(async () => (await chrome.storage.local.get('panelSnaps')).panelSnaps as Record<string, unknown> | undefined) as Promise<Kept | undefined>
const frame = (p: Page) => p.frames().find((f) => f.url().includes('view=ext-panel'))!
/** How far the task list is scrolled (its scroller is the first element in it that scrolls). */
const listTop = (p: Page) => frame(p).evaluate(() => {
  const els = Array.from(document.querySelectorAll('.ext-home-tasks *')) as HTMLElement[]
  const el = els.find((e) => e.scrollHeight > e.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
  return el ? el.scrollTop : -1
})
async function historyRows(sid: string): Promise<Array<{ role: string; text: string }>> {
  const r = await (await lab.doc.request.get(`${lab.base}/api/sessions/${sid}/history`)).json()
  return (Array.isArray(r) ? r : r.messages ?? []) as Array<{ role: string; text: string }>
}
async function getTask(id: string): Promise<Record<string, any>> {
  const j = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks/${id}`)).json() as Record<string, any>
  return (j.task ?? j) as Record<string, any>
}
async function taskOfSession(sid: string): Promise<string> {
  const rec = await (await lab.doc.request.get(`${lab.base}/api/v1/sessions/${sid}`)).json() as Record<string, any>
  return String(rec.taskId ?? rec.session?.taskId ?? '')
}
const agentOwners = () => sw(lab).evaluate(async () => Object.values(((await chrome.storage.session.get('agentTabs')).agentTabs ?? {}) as Record<string, { owner: string }>).map((r) => r.owner))

test('the side panel opens on New task over Home\'s task panel, and keeps its drawing', async () => {
  test.setTimeout(200_000)
  panel = await openFirstPage()
  const v = askView(panel)
  await expect(v.getByTestId('ext-home-head')).toBeVisible()
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Relay off')
  await expect(v.getByTestId('ext-ask-key')).toBeVisible()
  await expect(v.getByTestId('ext-key-locked')).toBeVisible({ timeout: 15_000 })
  await expect(v.getByTestId('ext-home-settings')).toBeVisible()
  const box = v.locator('[data-testid="ext-home-composer"] textarea')
  await expect(box).toHaveAttribute('placeholder', 'New task: what should Walnut do?')
  await expect(v.getByTestId('ext-panel-include')).toContainText('Release notes 4.2', { timeout: 30_000 })
  await expect(v.getByTestId('ext-panel-include')).toBeChecked()
  await expect(v.getByTestId('ext-home-act')).not.toBeChecked()
  // Home's task panel: its tabs and its Needs you rows.
  await expect(v.locator('.todo-section-tab').filter({ hasText: 'All' })).toHaveClass(/is-active/, { timeout: 60_000 })
  // Home's default bar: All and Pinned (the person's own choice of tabs in this browser, else these).
  await expect(v.locator('.todo-section-tab').filter({ hasText: 'Pinned' })).toBeVisible()
  for (const n of NEEDS) await expect(v.locator('.todo-pinned-card.todo-pinned-card-needs-action').filter({ hasText: n.title })).toBeVisible({ timeout: 30_000 })
  // Home's own "hide the task panel" control is not here.
  await expect(v.locator('.todo-panel-hide')).toBeHidden()
  // The drawing of the next open: the first page, its tabs and rows.
  await expect.poll(async () => {
    const k = await kept()
    return [k?.mode?.mode, (k?.home?.tabs ?? []).some((t) => t.label === 'All'), (k?.home?.rows ?? []).some((r) => r.needs)]
  }, { timeout: 20_000 }).toEqual(['home', true, true])
  await shots(panel, 'panel-first')
})

test('the panel opens on the drawing of the first page while Walnut loads', async () => {
  test.setTimeout(150_000)
  // Walnut's page answered by a blank one that never says it is up: the extension's own drawing
  // is what shows (until its 15 s backstop).
  await lab.ctx.route('**/popout?view=ext-panel*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>held</title>' }))
  const { panel: p } = await openPanel(lab, 'home')
  await p.setViewportSize({ width: 400, height: 760 })
  const look = p.getByTestId('panel-snap')
  await expect(look).toHaveAttribute('data-look', 'home', { timeout: 10_000 })
  await expect(look.getByTestId('panel-snap-placeholder')).toHaveText('New task: what should Walnut do?')
  await expect(look.getByTestId('panel-snap-relay')).toHaveText('Relay off')
  await expect(look.getByTestId('panel-snap-page')).toContainText('Release notes 4.2')
  await expect(look.getByTestId('panel-snap-tabs')).toContainText('All')
  await expect(look.getByTestId('panel-snap-rows')).toContainText(NEEDS[0].title)
  await shots(p, 'panel-look')
  await lab.ctx.unroute('**/popout?view=ext-panel*')
  await p.close()
})

test('the tabs and a list of more than 100 tasks are Home\'s own', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  const pinnedTab = v.locator('.todo-section-tab').filter({ hasText: 'Pinned' })
  await pinnedTab.click()
  await expect(pinnedTab).toHaveClass(/is-active/)
  // Pinned holds the tasks pinned to a tier, never an ask that is in no tier.
  await expect(v.locator('.todo-pinned-card').filter({ hasText: NEEDS[0].title })).toBeVisible({ timeout: 20_000 })
  await expect(v.getByTestId('status-section-waiting')).toBeVisible()
  await expect(v.locator('.ext-home-tasks').getByText('Which plants like shade?')).toHaveCount(0)
  await shots(panel, 'panel-tab-pinned')
  const allTab = v.locator('.todo-section-tab').filter({ hasText: 'All' })
  await allTab.click()
  await expect(allTab).toHaveClass(/is-active/)
  // The board's more than 100 open tasks, unfolded under Waiting / snoozed.
  const waiting = v.getByTestId('status-section-waiting').locator('.navigation-heading-open')
  if ((await waiting.getAttribute('aria-expanded')) !== 'true') await waiting.click()
  await expect(waiting).toHaveAttribute('aria-expanded', 'true')
  await expect(v.getByTestId('status-section-waiting-count')).toHaveText(/^1\d\d\+?$/)
  // The list scrolls with the wheel; the composer stays where it is.
  const tasks = v.getByTestId('ext-home-tasks')
  const tb = (await tasks.boundingBox())!
  const composerTop = (await v.getByTestId('ext-home-composer').boundingBox())!.y
  await panel.mouse.move(tb.x + tb.width / 2, tb.y + Math.min(tb.height - 20, 300))
  for (let i = 0; i < 12; i++) await panel.mouse.wheel(0, 400)
  await expect.poll(() => listTop(panel), { timeout: 10_000 }).toBeGreaterThan(1500)
  // Rows deep in the board are on screen now.
  await expect.poll(() => frame(panel).evaluate(() => Array.from(document.querySelectorAll('.todo-pinned-card')).filter((r) => {
    const b = r.getBoundingClientRect()
    return /Board task \d{3}/.test(r.textContent ?? '') && b.top >= 0 && b.bottom <= window.innerHeight
  }).length), { timeout: 10_000 }).toBeGreaterThan(4)
  expect((await v.getByTestId('ext-home-composer').boundingBox())!.y).toBe(composerTop)
  await shots(panel, 'panel-scrolled')
})

test('a search over the board finds tasks by their words', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  const search = v.locator('.ext-home-tasks .todo-search-input')
  await search.click()
  await panel.keyboard.type('changelog')
  await expect(v.locator('.ext-home-tasks').getByText('Publish the October changelog')).toBeVisible({ timeout: 30_000 })
  await expect(v.locator('.ext-home-tasks').getByText('Send the changelog copy to the docs team')).toBeVisible()
  await expect(v.locator('.ext-home-tasks').getByText(NEEDS[1].title)).toHaveCount(0)
  await shots(panel, 'panel-search')
  await panel.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(v.locator('.todo-pinned-card').filter({ hasText: NEEDS[1].title })).toBeVisible({ timeout: 20_000 })
})

test('typing and Send start a task that knows the page; it opens here, and Back returns to the list where it was', async () => {
  test.setTimeout(200_000)
  const v = askView(panel)
  const before = await listTop(panel)
  const box = v.locator('[data-testid="ext-home-composer"] textarea')
  await box.click()
  const words = 'Find the receipt for order 40917 echo-input'
  await panel.keyboard.type(words)
  await shots(panel, 'panel-typing')
  await panel.keyboard.press('Enter')
  // The task's own page: Back, its first question as its name, its conversation.
  await expect(v.getByTestId('ext-task-head')).toBeVisible({ timeout: 60_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText(words)
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const sid = (await session.getAttribute('data-session-id')) ?? ''
  expect(sid).not.toBe('')
  const taskId = await taskOfSession(sid)
  expect(taskId).not.toBe('')
  made.push(taskId)
  // A task, not an ask: no Ask project, started in its own task directory (no folder picker).
  const task = await getTask(taskId)
  expect(task.walnut_agent ?? false).toBe(false)
  expect(String(task.project ?? '')).not.toMatch(/^Ask /)
  expect(String(task.cwd ?? '')).toContain(taskId)
  // The page went beside the words, as a Walnut hint the session reads.
  let raw = ''
  await expect.poll(async () => {
    raw = (await historyRows(sid)).find((r) => r.role === 'assistant' && r.text.includes('Find the receipt'))?.text ?? ''
    return raw.length > 0
  }, { timeout: 60_000 }).toBe(true)
  expect(raw).toContain('Release notes 4.2')
  // The page's text rides in a file the hint names, never in the message.
  const file = /The page's text is in (\S+?): read it/.exec(raw)?.[1] ?? ''
  expect(file).toMatch(/browser-pages\/.+\.md$/)
  expect(fs.readFileSync(file, 'utf8')).toContain('retries a failed upload three times')
  await expect.poll(async () => (await kept())?.mode, { timeout: 15_000 }).toMatchObject({ mode: 'task', title: words })
  await shots(panel, 'panel-task-opened')
  // Back: the list, scrolled where it was; the composer is empty again.
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
  await expect(v.getByTestId('ext-task-head')).toHaveCount(0)
  expect(await listTop(panel)).toBe(before)
  await expect(box).toHaveValue('')
  await expect.poll(async () => (await kept())?.mode?.mode, { timeout: 15_000 }).toBe('home')
})

test('× leaves the page out; Save as todo files the words and starts nothing', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  const box = v.locator('[data-testid="ext-home-composer"] textarea')
  await box.click()
  await panel.keyboard.type('Renew the library card before Friday')
  await v.getByTestId('ext-panel-page-drop').click()
  await expect(v.getByTestId('ext-panel-include')).not.toBeChecked()
  await v.locator('[data-testid="ext-home-composer"] .draft-later-btn').click()
  const saved = v.getByTestId('ext-home-saved')
  await expect(saved).toContainText('Renew the library card before Friday', { timeout: 30_000 })
  await expect(box).toHaveValue('')
  // The next one starts as a new task does: with the page.
  await expect(v.getByTestId('ext-panel-include')).toBeChecked()
  let todo: Record<string, any> | undefined
  await expect.poll(async () => {
    const r = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks`)).json() as Record<string, any>
    const list = (Array.isArray(r) ? r : r.tasks ?? r.items ?? []) as Array<Record<string, any>>
    todo = list.find((t) => t.title === 'Renew the library card before Friday')
    return !!todo
  }, { timeout: 20_000 }).toBe(true)
  made.push(String(todo!.id))
  expect(todo!.session_id ?? null).toBeNull()
  // The page was left out with the chip's ×: its description does not name it (read from the task itself: the list leaves descriptions out).
  expect(String((await getTask(String(todo!.id))).description ?? '')).not.toContain('docs.example.test')
  // Its Open opens its detail in the panel, never a Walnut tab.
  const pages = lab.ctx.pages().length
  await v.getByTestId('ext-home-saved-open').click()
  await expect(v.getByTestId('ext-task-detail')).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText('Renew the library card before Friday')
  expect(lab.ctx.pages().length).toBe(pages)
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
})

test('a task with no conversation opens its detail in the panel', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  const row = v.locator('.todo-pinned-card').filter({ hasText: NEEDS[0].title })
  const pages = lab.ctx.pages().length
  await row.locator('.todo-pinned-title').click()
  await expect(v.getByTestId('ext-task-detail')).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText(NEEDS[0].title)
  await expect(v.getByTestId('ext-task-headline')).toContainText('Ops')
  expect(lab.ctx.pages().length).toBe(pages)
  await shots(panel, 'panel-task-detail')
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
})

test('Act in this tab hands the tab over: the strip and the relay show it, Stop takes it back', async () => {
  test.setTimeout(200_000)
  const v = askView(panel)
  await v.getByTestId('ext-home-act').click()
  await expect(v.getByTestId('ext-home-act')).toBeChecked()
  await v.locator('[data-testid="ext-home-composer"] textarea').click()
  // (`slow:` holds the mock CLI's answer a few seconds: the fixture keeps no transcript, so the
  // person's first bubble is the launch's own until the turn ends.)
  await panel.keyboard.type('slow:8000 Rotate the expired API key on Lab Accounts here')
  await panel.keyboard.press('Enter')
  await expect(v.getByTestId('ext-task-head')).toBeVisible({ timeout: 60_000 })
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  // Its first bubble names the page it went with (the chip was on again after the todo above).
  await expect(v.locator('.session-msg-user').filter({ hasText: 'Rotate the expired API key' }).first().getByTestId('ext-panel-attached-page')).toContainText('Release notes 4.2', { timeout: 8_000 })
  const taskId = await taskOfSession((await session.getAttribute('data-session-id')) ?? '')
  made.push(taskId)
  // The extension made the person's tab this task's agent tab.
  await expect.poll(agentOwners, { timeout: 30_000 }).toContain(`task:${taskId}`)
  await v.getByTestId('ext-task-back').click()
  // The strip under the composer, and the pill: an agent acts in this tab.
  const strip = v.getByTestId('ext-relay-strip')
  await expect(strip).toContainText('Walnut agent is using this tab', { timeout: 30_000 })
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Agent in tab')
  await shots(panel, 'panel-relay-strip')
  // The relay panel lists the tab in use, with Stop.
  await v.getByTestId('ext-relay-pill').click()
  const relay = v.getByTestId('ext-relay-panel')
  await expect(relay).toBeVisible()
  await expect(relay.getByTestId('ext-relay-row').first()).toContainText('Release notes 4.2 · this tab', { timeout: 20_000 })
  await expect(relay.getByTestId('ext-relay-stop').first()).toBeVisible()
  await expect(relay.getByTestId('ext-relay-agents')).not.toBeChecked()
  await shots(panel, 'panel-relay-panel')
  // Escape closes it; the strip's Stop takes the tab back.
  await panel.keyboard.press('Escape')
  await expect(relay).toHaveCount(0)
  await v.getByTestId('ext-relay-strip-stop').click()
  await expect(strip).toHaveCount(0, { timeout: 20_000 })
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Relay off', { timeout: 20_000 })
  await expect.poll(async () => (await agentOwners()).length, { timeout: 20_000 }).toBe(0)
})

test('the relay panel turns agents on and off, and Stop all ends every agent tab', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  await v.getByTestId('ext-relay-pill').click()
  const relay = v.getByTestId('ext-relay-panel')
  await expect(relay.getByTestId('ext-relay-none')).toBeVisible({ timeout: 20_000 })
  await relay.getByTestId('ext-relay-agents').click()
  await expect.poll(() => sw(lab).evaluate(async () => (await chrome.storage.local.get('agentControl')).agentControl), { timeout: 20_000 }).toBe(true)
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Relay on', { timeout: 20_000 })
  await expect(relay.getByTestId('ext-relay-agents')).toBeChecked()
  await shots(panel, 'panel-relay-on')
  await relay.getByTestId('ext-relay-agents').click()
  await expect.poll(() => sw(lab).evaluate(async () => (await chrome.storage.local.get('agentControl')).agentControl), { timeout: 20_000 }).toBe(false)
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Relay off', { timeout: 20_000 })
  // Two tabs agents hold (two tasks'): Stop all ends both.
  const other = await lab.ctx.newPage()
  await other.goto(lab.site('docs.example.test', '/other'))
  await lab.doc.bringToFront()
  await sw(lab).evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://docs.example.test/*' })
    const rec: Record<string, unknown> = {}
    for (const t of tabs) rec[String(t.id)] = { owner: `task:${t.url?.includes('other') ? 'demo-hotel' : 'demo-refund'}`, who: 'Walnut task', handed: 'x' }
    await chrome.storage.session.set({ agentTabs: rec })
  })
  await expect(relay.getByTestId('ext-relay-row')).toHaveCount(2, { timeout: 20_000 })
  await expect(relay).toContainText('Another page')
  await relay.getByTestId('ext-relay-stop-all').click()
  await expect(relay.getByTestId('ext-relay-none')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await agentOwners()).length, { timeout: 20_000 }).toBe(0)
  // A press outside closes it (on the header's empty middle: a press on the list would open a row).
  const head = (await v.getByTestId('ext-home-head').boundingBox())!
  await panel.mouse.click(head.x + head.width * 0.7, head.y + head.height / 2)
  await expect(relay).toHaveCount(0)
  await other.close()
})

test('the asks stay one ≡ away, and Tasks there comes back to the first page', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  await v.getByTestId('ask-walnut-menu').click()
  await expect(v.getByTestId('ext-drawer-tasks')).toBeVisible()
  await shots(panel, 'panel-drawer')
  await v.getByTestId('ask-walnut-new').click()
  await expect(v.getByTestId('ext-ask-head')).toBeVisible({ timeout: 30_000 })
  await expect(v.locator('[data-testid="ask-object-compose"] textarea')).toBeVisible()
  await expect(v.getByTestId('ext-home')).toBeHidden()
  await v.getByTestId('ask-walnut-menu').click()
  await v.getByTestId('ext-drawer-tasks').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
})

test('the key popover opens over the first page', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  await v.getByTestId('ext-ask-key').click()
  await expect(panel.getByTestId('key-pop')).toBeVisible({ timeout: 20_000 })
  await shots(panel, 'panel-key')
  await panel.keyboard.press('Escape')
  await expect(panel.getByTestId('key-pop')).toBeHidden()
})

test('a selection on the page shows over the new task as a quote, with its own ×', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  await selectText(lab.doc, 'p2')
  await v.locator('[data-testid="ext-home-composer"] textarea').click()
  await expect(v.getByTestId('ext-panel-selection')).toContainText('Dark mode follows', { timeout: 20_000 })
  await shots(panel, 'panel-quote')
  await v.getByTestId('ext-panel-selection-drop').click()
  await expect(v.getByTestId('ext-panel-selection')).toHaveCount(0)
})

test('the popup opens on New task; a question there goes on in the side panel', async () => {
  test.setTimeout(200_000)
  const opened = lab.ctx.waitForEvent('page')
  await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 400, height: 600 }), lab.docWindow)
  const pop = await opened
  await pop.setViewportSize({ width: 400, height: 600 })
  const v = askView(pop)
  await expect(v.getByTestId('ext-home')).toBeVisible({ timeout: 60_000 })
  await expect(v.getByTestId('ext-ask-side-panel')).toBeVisible()
  await expect(v.locator('.todo-pinned-card').filter({ hasText: NEEDS[0].title })).toBeVisible({ timeout: 30_000 })
  await shots(pop, 'popup-first')
  await v.getByTestId('ext-relay-pill').click()
  await expect(v.getByTestId('ext-relay-panel')).toBeVisible()
  await shots(pop, 'popup-relay')
  await v.getByTestId('ext-relay-pill').click()
  await expect(v.getByTestId('ext-relay-panel')).toHaveCount(0)
  await v.getByTestId('ext-ask-key').click()
  await expect(pop.getByTestId('key-pop')).toBeVisible({ timeout: 20_000 })
  await shots(pop, 'popup-key')
  await v.getByTestId('ext-ask-key').click()
  await expect(pop.getByTestId('key-pop')).toBeHidden()
  // A question typed in the popup is started by the side panel, which shows the task.
  await v.locator('[data-testid="ext-home-composer"] textarea').click()
  await pop.keyboard.type('Compare the two hotel rooms')
  await shots(pop, 'popup-typing')
  const side = lab.ctx.waitForEvent('page')
  await pop.keyboard.press('Enter')
  const sp = await side
  await sp.setViewportSize({ width: 400, height: 760 })
  const sv = askView(sp)
  await expect(sv.getByTestId('ext-task-head')).toBeVisible({ timeout: 90_000 })
  await expect(sv.getByTestId('ext-task-title')).toHaveText('Compare the two hotel rooms')
  const s = sv.getByTestId('ask-object-session')
  await expect(s).toBeVisible({ timeout: 60_000 })
  made.push(await taskOfSession((await s.getAttribute('data-session-id')) ?? ''))
  await sp.close()
})
