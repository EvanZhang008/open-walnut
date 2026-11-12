/**
 * The extension's first page (design C with a side bar, 2026-11-07; web/src/popout/ExtHome.tsx,
 * ExtHomeTasks.tsx, ExtRelay.tsx, ExtControl.tsx; packages/browser-extension/src/panel-ask.ts,
 * panel-rail.ts, panel-look-home.ts), through the real extension in Chromium, with real mouse and
 * keyboard input:
 *
 * - the side panel and the popup open on Chat: the side bar (Chat, Passwords, Browser control,
 *   Settings), the header (≡, Walnut, the relay pill, the key), Home's task panel filling the page
 *   (tabs, search, Needs you with each row's status line, the rows), and New task docked at the
 *   bottom on one line ("This page" and send), which grows into the whole composer (the page chip
 *   with ×, Act in this tab, Save as todo) when clicked; all drawn by the extension the moment it opens;
 * - each side bar entry: Passwords (locked, its one unlock row), Browser control (the status, an
 *   agent's tab shown everywhere at once with no reload, Stop; "Shared earlier" only for tabs he
 *   handed over; its settings), Settings; the panel opens on the entry it was left on;
 * - a new task's row is titled with his words at once, and search finds it;
 * - typing and Send make a task and a session that knows the page, shown in the panel with Back;
 *   Back returns to the list where it was; × leaves the page out; Act in this tab hands the tab over
 *   and the strip shows while the agent holds it, with Stop;
 * - Save as todo files the words as a todo without starting anything;
 * - the tabs and the search are Home's own, over a list of more than 100 tasks;
 * - a task with no conversation opens its detail in the panel, never a new tab, and so do the
 *   parent and the subtasks its detail links to;
 * - Act in this tab hands over only the tab Send was pressed in (moved to another tab while the task
 *   starts, nothing is handed over); Save as todo saves once, whatever the clicks; a question the
 *   popup handed over that Walnut could not start comes back in the side panel's composer;
 * - the relay pill opens the relay panel: agents on and off, the tab in use with Stop, Stop all;
 * - the asks stay one ≡ away;
 * - dark mode.
 *
 * Screenshots (EXT_FIRST_SHOTS, default test-results/extension-first-page) at 400 px, light and dark.
 * Fake data only.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, openPanel, selectText, startPanelLab, sw, type PanelLab } from './extension-panel-harness'
import { holdVaultLock } from './vault-lock'
import { ensureVaultSetUp } from './vault-session-helper'

test.describe.configure({ mode: 'serial' })
// The key reads the fixture's vault; nothing here locks it or ends an unlock.
holdVaultLock('shared', 'file')

// The grown composer's row: how far the send arrow reaches past the box (negative: inside), and how
// much of "Act in this tab" is cut.
const sendOverhang = async (v: ReturnType<typeof askView>): Promise<number> => {
  const send = (await v.locator('[data-testid="ext-home-composer"] .chat-send-group').boundingBox())!
  const bar = (await v.locator('[data-testid="ext-home-composer"] .chat-input-box').boundingBox())!
  return Math.round(send.x + send.width - (bar.x + bar.width))
}
const actWordsCut = (v: ReturnType<typeof askView>): Promise<number> =>
  v.locator('[data-testid="ext-home-composer"] .ext-home-act > span:last-child').evaluate((e) => e.scrollWidth - e.clientWidth)
// The first needs card by its own name: a task made later may quote its title in its words.
const needsCard = (v: ReturnType<typeof askView>) => v.locator(`.todo-pinned-card[aria-label="${NEEDS[0].title}"]`)
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
  // A person who has Passwords: the key and the Passwords entry read a locked vault, never "set it up".
  await ensureVaultSetUp(lab.doc, lab.base)
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
/** A task made by a test here (deleted after the file). */
async function makeTask(data: Record<string, unknown>): Promise<string> {
  const r = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data })
  expect(r.ok(), await r.text()).toBe(true)
  const j = await r.json() as Record<string, any>
  const id = String(j.task?.id ?? j.id)
  made.push(id)
  return id
}
/** Requests to `url` wait until the returned release is called (POSTs only). */
async function holdPosts(url: string): Promise<{ count: () => number; release: () => void; done: () => Promise<void> }> {
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let n = 0
  const route = async (r: Route) => {
    if (r.request().method() === 'POST') { n++; await held }
    await r.continue()
  }
  await lab.ctx.route(url, route)
  return { count: () => n, release: () => release(), done: async () => { release(); await lab.ctx.unroute(url, route) } }
}
/**
 * A task he just made from the panel is first in Recent at once, in the panel and in the one synced
 * list Home and the phone read (2026-11-10, the user: a task made from the side panel could not be
 * found in Recent, which still ordered rows by agent updates). Back on All after.
 */
async function firstInRecent(id: string): Promise<void> {
  const v = askView(panel)
  const tab = v.locator('.todo-section-tab-recent')
  // On this page Recent waits under More (tab-bar-model WIDE_HIDDEN_TABS): put it on the bar
  // from there, as the person does, the first time.
  if (await tab.count() === 0) {
    await v.getByRole('button', { name: 'Tab bar options' }).click()
    const row = v.getByRole('menu', { name: 'Tab bar options' }).getByRole('menuitemcheckbox', { name: 'Recent', exact: true })
    await expect(row).toHaveAttribute('aria-checked', 'false')
    await row.click()
    await expect(row).toHaveAttribute('aria-checked', 'true')
    await panel.keyboard.press('Escape')
  }
  await tab.click()
  await expect(tab).toHaveClass(/is-active/)
  await expect(v.locator('.todo-pinned-list-recent [data-task-id]').first()).toHaveAttribute('data-task-id', id, { timeout: 15_000 })
  const key = 'walnut-todo-recent-opened'
  const prefs = (await (await lab.doc.request.get(`${lab.base}/api/ui-prefs?key=${key}`)).json() as Record<string, any>).prefs?.[key]?.v
  const list = (typeof prefs === 'string' ? JSON.parse(prefs) : prefs) as Array<{ id: string }>
  expect(list[0]?.id).toBe(id)
  await v.locator('.todo-section-tab').filter({ hasText: 'All' }).click()
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

test('the side panel opens on Chat: the side bar, the list filling the page, New task docked at the bottom; it keeps its drawing', async () => {
  test.setTimeout(200_000)
  panel = await openFirstPage()
  const v = askView(panel)
  // The side bar: four entries, Chat marked.
  const rail = panel.getByTestId('panel-rail')
  await expect(rail).toBeVisible()
  for (const e of ['chat', 'passwords', 'control', 'settings']) await expect(rail.getByTestId(`panel-rail-${e}`)).toBeVisible()
  await expect(rail.getByTestId('panel-rail-chat')).toHaveAttribute('aria-current', 'page')
  expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(68)
  // Every entry's name whole on its line (2026-11-09: "Passwords" was cut at 48 px), and Settings at
  // the foot, apart from the three things the panel does.
  for (const e of ['chat', 'passwords', 'control', 'settings']) {
    expect(await rail.getByTestId(`panel-rail-${e}`).locator('.panel-rail-name').evaluate((n) => n.scrollWidth - n.clientWidth), e).toBeLessThanOrEqual(0)
    const name = (await rail.getByTestId(`panel-rail-${e}`).locator('.panel-rail-name').boundingBox())!
    const btn = (await rail.getByTestId(`panel-rail-${e}`).boundingBox())!
    expect(name.x, e).toBeGreaterThanOrEqual(btn.x)
    expect(name.x + name.width, e).toBeLessThanOrEqual(btn.x + btn.width)
    // Room to spare, since macOS draws these words wider than Linux does: at 6 px of rail padding
    // "Passwords" fit here and was cut by 1 px on the Mac (2026-11-10).
    expect(btn.width - name.width, e).toBeGreaterThanOrEqual(6)
  }
  const railBox = (await rail.boundingBox())!
  const settingsBox = (await rail.getByTestId('panel-rail-settings').boundingBox())!
  expect(railBox.y + railBox.height - (settingsBox.y + settingsBox.height)).toBeLessThan(24)
  await expect(v.getByTestId('ext-home-head')).toBeVisible()
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Relay off')
  await expect(v.getByTestId('ext-ask-key')).toBeVisible()
  await expect(v.getByTestId('ext-key-locked')).toBeVisible({ timeout: 15_000 })
  // Settings is the side bar's: no gear in the header.
  await expect(v.getByTestId('ext-home-settings')).toHaveCount(0)
  // New task, docked on one line at the bottom: the words, "This page", send.
  const composer = v.getByTestId('ext-home-composer')
  const box = composer.locator('textarea')
  await expect(box).toHaveAttribute('placeholder', 'New task: what should Walnut do?')
  await expect(composer).toHaveAttribute('data-docked', 'true')
  await expect(v.getByTestId('ext-home-dock-chip')).toHaveText(/This page/, { timeout: 30_000 })
  await expect(v.getByTestId('ext-home-dock-chip')).toHaveAttribute('title', /Release notes 4\.2/)
  await expect(v.getByTestId('ext-home-act')).toHaveCount(0)
  const dock = (await composer.boundingBox())!
  // One line: the box no taller than a line, the dock with its padding under 100 px.
  expect((await box.boundingBox())!.height).toBeLessThan(44)
  expect(dock.height).toBeLessThan(100)
  expect(dock.y + dock.height).toBeGreaterThan(760 - 20)
  // Home's task panel: its tabs (over the search box) and its Needs you rows with their status line.
  await expect(v.locator('.todo-section-tab').filter({ hasText: 'All' })).toHaveClass(/is-active/, { timeout: 60_000 })
  // Never All and Pinned alone (review round 5, Opus #2): the tiers are there too.
  await expect(v.locator('.todo-section-tab').filter({ hasText: 'Pinned' })).toBeVisible()
  // (an empty tier hides, as on Home: this board's pinned tasks are in Satellite)
  await expect(v.locator('.todo-section-tab').filter({ hasText: /Focus|Satellite|Parked/ }).first()).toBeVisible()
  await expect(v.locator('.todo-section-tabs-menu')).toContainText('More')
  const tabsY = (await v.locator('.ext-home-tasks .todo-section-tabs').boundingBox())!.y
  const searchY = (await v.locator('.ext-home-tasks .todo-search-input').boundingBox())!.y
  expect(tabsY).toBeLessThan(searchY)
  for (const n of NEEDS) {
    const card = v.locator('.todo-pinned-card.todo-pinned-card-needs-action').filter({ hasText: n.title })
    await expect(card).toBeVisible({ timeout: 30_000 })
    // Its status line, as Home draws it (review round 5, Sol #3): the ask, in words.
    await expect(card).toContainText(n.ask, { timeout: 30_000 })
  }
  // A click grows it into the whole composer: the page chip with ×, Act in this tab, Save as todo.
  await box.click()
  await expect(composer).toHaveAttribute('data-docked', 'false')
  await expect(v.getByTestId('ext-panel-include')).toContainText('Release notes 4.2', { timeout: 30_000 })
  await expect(v.getByTestId('ext-panel-include')).toBeChecked()
  await expect(v.getByTestId('ext-home-act')).not.toBeChecked()
  await expect(composer.locator('.draft-later-btn')).toBeVisible()
  // The chip says what it is, and the task's mode and model are picked here as in every composer
  // (2026-11-09: "why can't i choose model, and mode etc", "also what is this").
  await expect(v.getByTestId('ext-panel-include')).toContainText(/^Page/)
  await expect(composer.locator('.is-plain-chat-pickers .draft-mode-pill')).toBeVisible()
  await expect(composer.locator('.is-plain-chat-pickers .draft-model-select')).toBeVisible()
  // Its picker is the composer's: open on an empty draft past the dock's delay, the composer stays
  // grown and the picker open (review 2026-11-09: it docked and so closed the picker).
  await composer.locator('.is-plain-chat-pickers .draft-model-select').click()
  await expect(v.locator('.model-picker')).toBeVisible()
  await panel.waitForTimeout(1200)
  await expect(v.locator('.model-picker')).toBeVisible()
  await expect(composer).toHaveAttribute('data-docked', 'false')
  await panel.keyboard.press('Escape')
  await expect(v.locator('.model-picker')).toHaveCount(0)
  await box.click()
  // Beside the side bar every control keeps its words and room: Act in this tab whole, send inside.
  await expect.poll(() => actWordsCut(v)).toBe(0)
  await expect.poll(() => sendOverhang(v)).toBeLessThanOrEqual(-2)
  await shots(panel, 'panel-composer-grown')
  // Left empty, it docks again (a press on the header's empty middle).
  const head = (await v.getByTestId('ext-home-head').boundingBox())!
  await panel.mouse.click(head.x + head.width * 0.7, head.y + head.height / 2)
  await expect(composer).toHaveAttribute('data-docked', 'true')
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
  await expect(look.getByTestId('panel-snap-page')).toContainText('This page')
  await expect(look.getByTestId('panel-snap-page')).toHaveAttribute('title', /Release notes 4\.2/)
  // The side bar is the extension's own: there at once, beside the drawing.
  await expect(p.getByTestId('panel-rail-chat')).toHaveAttribute('aria-current', 'page')
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
  await expect(needsCard(v)).toBeVisible({ timeout: 20_000 })
  await expect(v.getByTestId('status-section-notstarted')).toBeVisible()
  await expect(v.locator('.ext-home-tasks').getByText('Which plants like shade?')).toHaveCount(0)
  await shots(panel, 'panel-tab-pinned')
  const allTab = v.locator('.todo-section-tab').filter({ hasText: 'All' })
  await allTab.click()
  await expect(allTab).toHaveClass(/is-active/)
  // The board's more than 100 open tasks nobody started, unfolded under Not started.
  const waiting = v.getByTestId('status-section-notstarted').locator('.navigation-heading-open')
  if ((await waiting.getAttribute('aria-expanded')) !== 'true') await waiting.click()
  await expect(waiting).toHaveAttribute('aria-expanded', 'true')
  // At least the 104 seeded here: the run shares its server with other specs, whose own tasks
  // nobody started count too (2026-11-10, CI read 201, then 203).
  await expect.poll(async () => Number((await v.getByTestId('status-section-notstarted-count').textContent())?.replace(/\+$/, '')))
    .toBeGreaterThanOrEqual(104)
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
  await firstInRecent(taskId)
  // Its row is titled with his words at once, never "Session: <id>" (review round 5, Sol #1),
  // and search finds it by them.
  expect(String((await getTask(taskId)).title)).toContain('Find the receipt for order 40917')
  const search = v.locator('.ext-home-tasks .todo-search-input')
  await search.click()
  await panel.keyboard.type('receipt for order 40917')
  await expect(v.locator('.ext-home-tasks').getByText(/Find the receipt for order 40917/).first()).toBeVisible({ timeout: 30_000 })
  await expect(v.locator('.ext-home-tasks').getByText(/^Session: /)).toHaveCount(0)
  await panel.keyboard.press('Escape')
  await expect(search).toHaveValue('')
})

test('the grown composer picks the folder and the project; the task files there, and the next one starts in the same place', async () => {
  // 2026-11-10, the user: "we need to be able to choose which folder".
  test.setTimeout(200_000)
  const v = askView(panel)
  const composer = v.getByTestId('ext-home-composer')
  const box = composer.locator('textarea')
  const folderPill = composer.locator('.draft-composer-bar .draft-folder-pill')
  const projectChip = composer.locator('.draft-composer-bar .draft-project-chip')
  // Docked: one line, no launch bar.
  await expect(composer).toHaveAttribute('data-docked', 'true')
  await expect(composer.locator('.draft-launch-bar')).toBeHidden()
  await box.click()
  await expect(composer).toHaveAttribute('data-docked', 'false')
  // Grown: Home's launch bar, saying where the task goes before any pick.
  await expect(folderPill).toBeVisible()
  await expect(folderPill).toHaveText(/Folder:\s*its own/)
  await expect(projectChip).toHaveText(/Project:\s*Inbox/)
  // The folder picker opens from its pill and the composer stays grown under it (its anchor stays).
  await folderPill.click()
  const picker = v.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  await panel.waitForTimeout(700)
  await expect(composer).toHaveAttribute('data-docked', 'false')
  await expect(picker).toBeVisible()
  await shots(panel, 'panel-folder-picker')
  // A folder picked from it shows on the pill, with a × back to the task's own folder.
  const row = picker.locator('.sps-path-item').filter({ hasText: /wallets/ }).first()
  await row.click()
  // A row fills the path in; Shift+Enter uses it (the picker's footer says so).
  await expect(picker.locator('.sps-search-input')).toHaveValue(/wallets/)
  await picker.locator('.sps-search-input').press('Shift+Enter')
  await expect(folderPill).toHaveText(/Folder\/Host:\s*wallets/, { timeout: 10_000 })
  await expect(picker).toHaveCount(0)
  await expect(composer).toHaveAttribute('data-docked', 'false')
  await shots(panel, 'panel-folder-picked')
  await composer.getByTestId('draft-folder-clear').click()
  await expect(folderPill).toHaveText(/Folder:\s*its own/)
  await expect(composer.getByTestId('draft-folder-clear')).toHaveCount(0)
  await expect(projectChip).toHaveText(/Project:\s*Inbox/)
  // The project: the chip opens More, its Project row the project list; pick Travel.
  await projectChip.click()
  const menu = v.getByTestId('draft-task-menu')
  await expect(menu).toBeVisible()
  // The panel's launch makes no isolated workspace, so More offers none (review 2026-11-10, #1).
  await expect(menu.getByTestId('draft-menu-workspace')).toHaveCount(0)
  await menu.locator('.draft-task-menu-project .task-kebab-project-current').click()
  const flyout = v.locator('.task-kebab-project-flyout')
  await expect(flyout).toBeVisible()
  await flyout.locator('.task-kebab-project-opt').filter({ hasText: /^\s*Travel\s*$/ }).click()
  await expect(projectChip).toHaveText(/Project:\s*Travel/, { timeout: 10_000 })
  await expect(menu).toHaveCount(0)
  await expect(composer).toHaveAttribute('data-docked', 'false')
  await box.click()
  const words = 'Plan the Lisbon day trip echo-input'
  await panel.keyboard.type(words)
  await shots(panel, 'panel-project-picked')
  await panel.keyboard.press('Enter')
  await expect(v.getByTestId('ext-task-head')).toBeVisible({ timeout: 60_000 })
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const taskId = await taskOfSession((await session.getAttribute('data-session-id')) ?? '')
  expect(taskId).not.toBe('')
  made.push(taskId)
  const task = await getTask(taskId)
  expect(task.project).toBe('Travel')
  // No folder picked: still its own task directory.
  expect(String(task.cwd ?? '')).toContain(taskId)
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
  // The next task starts where this one did, also after the panel opens again.
  await box.click()
  await expect(projectChip).toHaveText(/Project:\s*Travel/)
  await panel.close()
  panel = await openFirstPage()
  const v2 = askView(panel)
  await v2.locator('[data-testid="ext-home-composer"] textarea').click()
  await expect(v2.locator('[data-testid="ext-home-composer"] .draft-composer-bar .draft-project-chip')).toHaveText(/Project:\s*Travel/)
  // Back to the Inbox for the tests after this one.
  await v2.locator('[data-testid="ext-home-composer"] .draft-composer-bar .draft-project-chip').click()
  await v2.getByTestId('draft-task-menu').locator('.draft-task-menu-project .task-kebab-project-current').click()
  await v2.locator('.task-kebab-project-flyout .task-kebab-project-opt').filter({ hasText: /^\s*Inbox\s*$/ }).click()
  await expect(v2.locator('[data-testid="ext-home-composer"] .draft-composer-bar .draft-project-chip')).toHaveText(/Project:\s*Inbox/)
  await panel.keyboard.press('Escape')
  await frame(panel).evaluate(() => localStorage.removeItem('walnut-ext-home-place'))
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
  // Docked again; the next one starts as a new task does: with the page.
  await expect(v.getByTestId('ext-home-composer')).toHaveAttribute('data-docked', 'true')
  await expect(v.getByTestId('ext-home-dock-chip')).toBeVisible()
  await box.click()
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
  await firstInRecent(String(todo!.id))
})

test('Save as todo saves once: a double click makes one todo, and Send waits while it saves', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  const words = 'Order the spare keyboard for the lab'
  const box = v.locator('[data-testid="ext-home-composer"] textarea')
  const save = v.locator('[data-testid="ext-home-composer"] .draft-later-btn')
  const saving = await holdPosts('**/api/tasks')
  const starts: string[] = []
  const onReq = (r: { url: () => string; method: () => string }) => { if (r.method() === 'POST' && r.url().includes('/api/sessions/quick-start')) starts.push(r.url()) }
  lab.ctx.on('request', onReq)
  try {
    await box.click()
    await panel.keyboard.type(words)
    await save.dblclick()
    await expect(v.getByTestId('ext-home-saving')).toBeVisible({ timeout: 20_000 })
    await expect(save).toBeDisabled()
    // Send while it saves starts nothing, and the words stay in the box.
    await box.click()
    await panel.keyboard.press('Enter')
    await panel.waitForTimeout(1_500)
    await expect(v.getByTestId('ext-home-starting')).toHaveCount(0)
    await expect(box).toHaveValue(words)
    expect(saving.count()).toBe(1)
    saving.release()
    await expect(v.getByTestId('ext-home-saved')).toContainText(words, { timeout: 30_000 })
  } finally {
    await saving.done()
    lab.ctx.off('request', onReq)
  }
  await panel.waitForTimeout(2_000)
  const r = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks`)).json() as Record<string, any>
  const list = ((Array.isArray(r) ? r : r.tasks ?? r.items ?? []) as Array<Record<string, any>>).filter((t) => t.title === words)
  for (const t of list) made.push(String(t.id))
  expect(list).toHaveLength(1)
  expect(starts).toHaveLength(0)
  await expect(v.getByTestId('ext-home')).toBeVisible()
})

test('a task with no conversation opens its detail in the panel', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  const row = needsCard(v)
  const pages = lab.ctx.pages().length
  await row.locator('.todo-pinned-title').click()
  await expect(v.getByTestId('ext-task-detail')).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText(NEEDS[0].title)
  await expect(v.getByTestId('ext-task-headline')).toContainText('Ops')
  expect(lab.ctx.pages().length).toBe(pages)
  await shots(panel, 'panel-task-detail')
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
  // His click in the panel's list is an open: the row is first in Recent.
  const r = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks`)).json() as Record<string, any>
  const list = (Array.isArray(r) ? r : r.tasks ?? r.items ?? []) as Array<Record<string, any>>
  await firstInRecent(String(list.find((t) => t.title === NEEDS[0].title)!.id))
})

test('a task\'s detail opens its subtask and its parent in the panel too, never Walnut\'s whole app', async () => {
  test.setTimeout(150_000)
  const parentTitle = 'Plan the lab move for the spring'
  const childTitle = 'Label the cables before the lab move'
  const parent = await makeTask({ title: parentTitle, project: 'Ops' })
  const rep = await lab.doc.request.put(`${lab.base}/api/v1/tasks/${parent}/report`, { data: { state: 'needs', ask: 'Which room do we move to?' } })
  expect(rep.ok(), await rep.text()).toBe(true)
  const child = await makeTask({ title: childTitle, project: 'Ops' })
  const adopt = await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${child}`, { data: { parent_task_id: parent } })
  expect(adopt.ok(), await adopt.text()).toBe(true)
  const v = askView(panel)
  const pages = lab.ctx.pages().length
  await v.locator('.todo-pinned-card').filter({ hasText: parentTitle }).locator('.todo-pinned-title').click()
  const detail = v.getByTestId('ext-task-detail')
  await expect(detail).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText(parentTitle)
  // Its subtask, then the subtask's parent: each opens here, with Back, in the panel's own view.
  await detail.locator('.tdp-task-row').filter({ hasText: childTitle }).click({ timeout: 30_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText(childTitle, { timeout: 30_000 })
  await expect(detail).toBeVisible()
  expect(frame(panel).url()).toContain('view=ext-panel')
  await detail.locator('.tdp-task-row').filter({ hasText: parentTitle }).click({ timeout: 30_000 })
  await expect(v.getByTestId('ext-task-title')).toHaveText(parentTitle, { timeout: 30_000 })
  expect(frame(panel).url()).toContain('view=ext-panel')
  await expect(v.getByTestId('ext-task-back')).toBeVisible()
  expect(lab.ctx.pages().length).toBe(pages)
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
})

test('Act in this tab hands the tab over: the strip and the relay show it, Stop takes it back', async () => {
  test.setTimeout(200_000)
  const v = askView(panel)
  await v.locator('[data-testid="ext-home-composer"] textarea').click()
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

test('Act in this tab hands over only the tab Send was pressed in: moved to another tab meanwhile, nothing is handed over', async () => {
  test.setTimeout(240_000)
  const v = askView(panel)
  await expect(v.getByTestId('ext-home')).toBeVisible()
  const docTab = await sw(lab).evaluate(async () => (await chrome.tabs.query({ active: true, url: 'http://docs.example.test/notes*' }))[0]?.id ?? 0)
  expect(docTab).toBeGreaterThan(0)
  const other = await sw(lab).evaluate(async (o: { w: number; url: string }) => (await chrome.tabs.create({ windowId: o.w, url: o.url, active: false })).id ?? 0, { w: lab.docWindow, url: lab.site('docs.example.test', '/other') })
  const start = await holdPosts('**/api/sessions/quick-start')
  try {
    await v.locator('[data-testid="ext-home-composer"] textarea').click()
    await v.getByTestId('ext-home-act').click()
    await expect(v.getByTestId('ext-home-act')).toBeChecked()
    await v.locator('[data-testid="ext-home-composer"] textarea').click()
    await panel.keyboard.type('Check the upload retries on this page')
    await panel.keyboard.press('Enter')
    await expect(v.getByTestId('ext-home-starting')).toBeVisible({ timeout: 30_000 })
    await expect.poll(start.count, { timeout: 30_000 }).toBe(1)
    // The person moves to another tab before Walnut has started the task.
    await sw(lab).evaluate((id: number) => chrome.tabs.update(id, { active: true }), other)
    await expect(v.getByTestId('ext-panel-include')).toContainText('Another page', { timeout: 20_000 })
    start.release()
    await expect(v.getByTestId('ext-task-head')).toBeVisible({ timeout: 60_000 })
    const session = v.getByTestId('ask-object-session')
    await expect(session).toBeVisible({ timeout: 60_000 })
    const taskId = await taskOfSession((await session.getAttribute('data-session-id')) ?? '')
    made.push(taskId)
    // The task page says why it has no tab; neither the tab moved to nor the one left was handed over.
    await expect(v.getByText('You moved to another tab while the task started')).toBeVisible({ timeout: 20_000 })
    await panel.waitForTimeout(3_000)
    expect(await agentOwners()).not.toContain(`task:${taskId}`)
    await shots(panel, 'panel-act-moved')
  } finally {
    await start.done()
    await sw(lab).evaluate(async (t: { a: number; b: number }) => { await chrome.tabs.update(t.a, { active: true }); await chrome.tabs.remove(t.b) }, { a: docTab, b: other })
  }
  await expect(v.getByTestId('ext-panel-include')).toContainText('Release notes 4.2', { timeout: 20_000 })
  await v.getByTestId('ext-task-back').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
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

/** This window's tab with the docs page, and what the extension tells its pages about agents' tabs. */
const docTabId = () => sw(lab).evaluate(async () => (await chrome.tabs.query({ active: true, url: 'http://docs.example.test/notes*' }))[0]?.id ?? 0)
const setAgentTabs = (rec: Record<string, unknown>) => sw(lab).evaluate((r: Record<string, unknown>) => chrome.storage.session.set({ agentTabs: r }), rec)

test('Browser control: the status big; an agent taking this tab while it is open shows there, on the pill and the strip, with no reload; Stop', async () => {
  test.setTimeout(200_000)
  const v = askView(panel)
  await panel.getByTestId('panel-rail-control').click({ timeout: 20_000 })
  await expect(panel.getByTestId('panel-rail-control')).toHaveAttribute('aria-current', 'page')
  const control = v.getByTestId('ext-control')
  await expect(control).toBeVisible({ timeout: 20_000 })
  await expect(v.getByTestId('ext-home')).toBeHidden()
  const status = v.getByTestId('ext-control-status')
  await expect(status).toHaveAttribute('data-kind', 'off', { timeout: 20_000 })
  await expect(status).toContainText('Agents are off')
  await expect(v.getByTestId('ext-control-none')).toBeVisible()
  await expect(v.getByTestId('ext-control-agents')).not.toBeChecked()
  await expect(v.getByTestId('ext-control-stop-all')).toBeDisabled()
  await shots(panel, 'panel-control')
  // An agent takes the tab he is on from the command line (a session's owner key), the panel open.
  const doc = await docTabId()
  expect(doc).toBeGreaterThan(0)
  const frameUrl = frame(panel).url()
  await setAgentTabs({ [String(doc)]: { owner: 'session:s-cli-take-1', history: ['http://docs.example.test/notes', 'http://docs.example.test/notes#retries'], taken: true } })
  await expect(status).toHaveAttribute('data-kind', 'tab', { timeout: 20_000 })
  await expect(status).toContainText('An agent is using this tab')
  const row = control.getByTestId('ext-relay-row').filter({ hasText: 'this tab' })
  await expect(row).toContainText('Release notes 4.2 · this tab')
  await expect(row).toContainText('A Walnut session')
  await expect(control.getByTestId('ext-control-recent')).toContainText('docs.example.test/notes')
  await expect(v.getByTestId('ext-control-stop-all')).toBeEnabled()
  await shots(panel, 'panel-control-tab')
  // Chat says the same, at once: the pill and the strip.
  await panel.getByTestId('panel-rail-chat').click({ timeout: 20_000 })
  await expect(v.getByTestId('ext-home')).toBeVisible()
  await expect(v.getByTestId('ext-relay-pill')).toHaveText('Agent in tab', { timeout: 20_000 })
  await expect(v.getByTestId('ext-relay-strip')).toContainText('using this tab', { timeout: 20_000 })
  // And the pill's own panel.
  await v.getByTestId('ext-relay-pill').click({ timeout: 20_000 })
  await expect(v.getByTestId('ext-relay-panel').getByTestId('ext-relay-row').first()).toContainText('this tab', { timeout: 20_000 })
  await panel.keyboard.press('Escape')
  // Nothing reloaded the view for it.
  expect(frame(panel).url()).toBe(frameUrl)
  // Stop, from Browser control.
  await panel.getByTestId('panel-rail-control').click({ timeout: 20_000 })
  await row.getByTestId('ext-relay-stop').click({ timeout: 20_000 })
  await expect(status).toHaveAttribute('data-kind', 'off', { timeout: 20_000 })
  await expect.poll(async () => (await agentOwners()).length, { timeout: 20_000 }).toBe(0)
})

test('Browser control: "Shared earlier" lists only tabs he handed over, never a tab an agent opened; its settings', async () => {
  test.setTimeout(200_000)
  const v = askView(panel)
  await expect(v.getByTestId('ext-control')).toBeVisible()
  // Its settings first (agents off ends the agents' own tabs): the switch is the extension's.
  await v.getByTestId('ext-control-agents').click({ timeout: 20_000 })
  await expect.poll(() => sw(lab).evaluate(async () => (await chrome.storage.local.get('agentControl')).agentControl), { timeout: 20_000 }).toBe(true)
  await expect(v.getByTestId('ext-control-agents')).toBeChecked()
  // The line under the switch says what it does in the state it is in now.
  await expect(v.getByTestId('ext-control-agents-line')).toHaveText(/^On: /)
  await v.getByTestId('ext-control-agents').click({ timeout: 20_000 })
  await expect.poll(() => sw(lab).evaluate(async () => (await chrome.storage.local.get('agentControl')).agentControl), { timeout: 20_000 }).toBe(false)
  await expect(v.getByTestId('ext-control-agents-line')).toHaveText(/^Off: /)
  // Ask before a new site: Walnut's own site setting.
  const sites = v.getByTestId('ext-control-ask-sites')
  await expect(sites).toBeVisible({ timeout: 20_000 })
  const was = await sites.isChecked()
  await sites.click({ timeout: 20_000 })
  await expect.poll(async () => ((await (await lab.doc.request.get(`${lab.base}/api/v1/browser/status`)).json()) as { mode?: string }).mode, { timeout: 20_000 }).toBe(was ? 'any' : 'ask')
  await sites.click({ timeout: 20_000 })
  await expect.poll(async () => ((await (await lab.doc.request.get(`${lab.base}/api/v1/browser/status`)).json()) as { mode?: string }).mode, { timeout: 20_000 }).toBe(was ? 'ask' : 'any')
  const handedPage = await lab.ctx.newPage()
  await handedPage.goto(lab.site('docs.example.test', '/other'), { timeout: 30_000 })
  const agentPage = await lab.ctx.newPage()
  await agentPage.goto(lab.site('docs.example.test', '/login'), { timeout: 30_000 })
  await lab.doc.bringToFront()
  try {
    const ids = await sw(lab).evaluate(async () => {
      const [a] = await chrome.tabs.query({ url: 'http://docs.example.test/other*' })
      const [b] = await chrome.tabs.query({ url: 'http://docs.example.test/login*' })
      return { handed: a?.id ?? 0, opened: b?.id ?? 0 }
    })
    expect(ids.handed).toBeGreaterThan(0)
    expect(ids.opened).toBeGreaterThan(0)
    // A task he handed a tab to (done with it), and a tab an agent opened from it (a popup).
    await setAgentTabs({
      [String(ids.handed)]: { owner: 'task:demo-done', who: 'Walnut task', handed: true, history: ['http://docs.example.test/other'] },
      [String(ids.opened)]: { owner: 'task:demo-done', who: 'Walnut task', viaHanded: true, history: ['http://docs.example.test/login'] },
    })
    const control = v.getByTestId('ext-control')
    await expect(control.getByTestId('ext-relay-unshare')).toHaveCount(1, { timeout: 20_000 })
    await expect(control.locator('[data-testid="ext-relay-row"]:has([data-testid="ext-relay-unshare"])')).toHaveAttribute('data-tab', String(ids.handed))
    await expect(control.locator(`[data-testid="ext-relay-row"][data-tab="${ids.opened}"]`).getByTestId('ext-relay-stop')).toBeVisible()
    await shots(panel, 'panel-control-shared')
    // Stop all ends both.
    await v.getByTestId('ext-control-stop-all').click({ timeout: 20_000 })
    await expect(v.getByTestId('ext-control-none')).toBeVisible({ timeout: 20_000 })
    await expect.poll(async () => (await agentOwners()).length, { timeout: 20_000 }).toBe(0)
  } finally {
    await setAgentTabs({})
    await handedPage.close()
    await agentPage.close()
  }
})

test('the panel opens again on the side bar entry it was left on', async () => {
  test.setTimeout(150_000)
  await expect(askView(panel).getByTestId('ext-control')).toBeVisible()
  const { panel: again } = await openPanel(lab, 'home', { keepRail: true })
  await again.setViewportSize({ width: 400, height: 760 })
  await expect(again.getByTestId('panel-rail-control')).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
  await expect(askView(again).getByTestId('ext-control')).toBeVisible({ timeout: 60_000 })
  await again.getByTestId('panel-rail-chat').click({ timeout: 20_000 })
  await expect(askView(again).getByTestId('ext-home')).toBeVisible()
  await again.close()
  await panel.getByTestId('panel-rail-chat').click({ timeout: 20_000 })
  await expect(askView(panel).getByTestId('ext-home')).toBeVisible()
})

test('Passwords on the side bar: the full view; locked, its one unlock row', async () => {
  test.setTimeout(150_000)
  await panel.getByTestId('panel-rail-passwords').click({ timeout: 20_000 })
  await expect(panel.getByTestId('panel-view-passwords')).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByTestId('panel-rail-passwords')).toHaveAttribute('aria-current', 'page')
  const pw = panel.frameLocator('iframe.panel-frame-passwords')
  await expect(pw.getByLabel('Master password')).toBeVisible({ timeout: 30_000 })
  await expect(pw.getByTestId('popup-unlock')).toBeVisible()
  await expect(pw.locator('.view-bar h1')).toHaveText('Passwords')
  // The side bar is the way back: the view's own Back is not drawn beside it.
  await expect(pw.getByTestId('panel-view-back')).toBeHidden()
  await shots(panel, 'panel-passwords')
  await panel.getByTestId('panel-rail-chat').click({ timeout: 20_000 })
  await expect(panel.locator('.panel-view:not([hidden])')).toHaveCount(0)
  await expect(askView(panel).getByTestId('ext-home')).toBeVisible()
})

test('Settings on the side bar: the extension\'s settings view', async () => {
  test.setTimeout(150_000)
  await panel.getByTestId('panel-rail-settings').click({ timeout: 20_000 })
  await expect(panel.getByTestId('panel-view-settings')).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByTestId('panel-rail-settings')).toHaveAttribute('aria-current', 'page')
  const st = panel.frameLocator('iframe.panel-frame-settings')
  await expect(st.getByText('Let Walnut agents use this browser')).toBeVisible({ timeout: 30_000 })
  await expect(st.locator('.view-bar h1')).toHaveText('Settings')
  await shots(panel, 'panel-settings')
  // Escape goes back to Chat, and the next open opens there.
  await st.locator('body').press('Escape', { timeout: 20_000 })
  await expect(panel.locator('.panel-view:not([hidden])')).toHaveCount(0, { timeout: 10_000 })
  await expect(panel.getByTestId('panel-rail-chat')).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => sw(lab).evaluate(async () => ((await chrome.storage.local.get('panelRail')).panelRail as Record<string, string> | undefined)?.panel), { timeout: 10_000 }).toBe('chat')
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
  // The popup has the side bar too (it fits at 400 px): Chat marked.
  await expect(pop.getByTestId('panel-rail-chat')).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
  await expect(needsCard(v)).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ext-home-composer')).toHaveAttribute('data-docked', 'true')
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
  // Each side bar entry in the popup too, in place (never a page of its own).
  await pop.getByTestId('panel-rail-control').click()
  await expect(v.getByTestId('ext-control-status')).toBeVisible({ timeout: 20_000 })
  await shots(pop, 'popup-control')
  await pop.getByTestId('panel-rail-passwords').click()
  await expect(pop.frameLocator('iframe.panel-frame-passwords').locator('.view-bar h1')).toHaveText('Passwords', { timeout: 30_000 })
  expect(pop.url()).toContain('popup-ask.html')
  await shots(pop, 'popup-passwords')
  await pop.getByTestId('panel-rail-settings').click()
  await expect(pop.frameLocator('iframe.panel-frame-settings').getByText('Let Walnut agents use this browser')).toBeVisible({ timeout: 30_000 })
  await shots(pop, 'popup-settings')
  await pop.getByTestId('panel-rail-chat').click()
  await expect(v.getByTestId('ext-home')).toBeVisible()
  // A question typed in the popup is started by the side panel, which shows the task.
  await v.locator('[data-testid="ext-home-composer"] textarea').click()
  // The mode picked here is the one the side panel starts it in (review 2026-11-09: the popup's picks
  // were dropped on the way).
  const modePill = v.locator('[data-testid="ext-home-composer"] .is-plain-chat-pickers .draft-mode-pill')
  const modeBefore = await modePill.getAttribute('data-mode')
  await modePill.click()
  await expect(modePill).not.toHaveAttribute('data-mode', modeBefore ?? '')
  const pickedMode = await modePill.getAttribute('data-mode')
  // So is the project picked here (2026-11-10: the popup's place goes with its question).
  const popProject = v.locator('[data-testid="ext-home-composer"] .draft-composer-bar .draft-project-chip')
  await popProject.click()
  await v.getByTestId('draft-task-menu').locator('.draft-task-menu-project .task-kebab-project-current').click()
  await v.locator('.task-kebab-project-flyout .task-kebab-project-opt').filter({ hasText: /^\s*Home\s*$/ }).click()
  await expect(popProject).toHaveText(/Project:\s*Home/, { timeout: 10_000 })
  // A pick closes the menu by itself (an Escape now would close the popup).
  await expect(v.getByTestId('draft-task-menu')).toHaveCount(0)
  await v.locator('[data-testid="ext-home-composer"] textarea').click()
  await pop.keyboard.type('Compare the two hotel rooms')
  // Grown in the popup, the send button keeps its room (review round 5, Sol #4).
  expect(await sendOverhang(v)).toBeLessThanOrEqual(-2)
  expect(await actWordsCut(v)).toBe(0)
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
  const handedSid = (await s.getAttribute('data-session-id')) ?? ''
  const handedTask = await taskOfSession(handedSid)
  made.push(handedTask)
  const rec = await (await lab.doc.request.get(`${lab.base}/api/v1/sessions/${handedSid}`)).json() as Record<string, any>
  expect(rec.mode ?? rec.session?.mode).toBe(pickedMode)
  expect((await getTask(handedTask)).project).toBe('Home')
  await frame(sp).evaluate(() => localStorage.removeItem('walnut-ext-home-place'))
  await sp.close()
})

test('a question the popup handed over that Walnut could not start comes back in the side panel\'s composer', async () => {
  test.setTimeout(240_000)
  let refuse = true
  const route = async (r: Route) => {
    if (refuse && r.request().method() === 'POST') {
      refuse = false
      await r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Walnut is busy, try again' }) })
      return
    }
    await r.continue()
  }
  await lab.ctx.route('**/api/sessions/quick-start', route)
  let sp: Page | undefined
  try {
    const opened = lab.ctx.waitForEvent('page')
    await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 400, height: 600 }), lab.docWindow)
    const pop = await opened
    await pop.setViewportSize({ width: 400, height: 600 })
    const pv = askView(pop)
    await expect(pv.getByTestId('ext-home')).toBeVisible({ timeout: 60_000 })
    const words = 'Compare the two standing desks for the lab'
    await pv.locator('[data-testid="ext-home-composer"] textarea').click()
    await expect(pv.getByTestId('ext-panel-include')).toContainText('Release notes 4.2', { timeout: 30_000 })
    await pop.keyboard.type(words)
    const side = lab.ctx.waitForEvent('page')
    await pop.keyboard.press('Enter')
    sp = await side
    await sp.setViewportSize({ width: 400, height: 760 })
    // The side panel already open in this window may take the question before the new one does
    // (the background hands it to one panel only): whichever shows it is the one to read.
    const panels = [panel, sp]
    let at = -1
    await expect.poll(async () => {
      for (const [i, p] of panels.entries()) if (await askView(p).getByTestId('ext-home-error').count()) { at = i; return i }
      return -1
    }, { timeout: 90_000 }).not.toBe(-1)
    const took = panels[at]
    const sv = askView(took)
    // Walnut refused it: the side panel says so, and the words are back in its composer.
    await expect(sv.getByTestId('ext-home-error')).toContainText('could not start it')
    const box = sv.locator('[data-testid="ext-home-composer"] textarea')
    await expect(box).toHaveValue(words, { timeout: 20_000 })
    await shots(took, 'panel-handoff-refused')
    // Send again: now it starts.
    await box.click()
    await took.keyboard.press('End')
    await took.keyboard.press('Enter')
    await expect(sv.getByTestId('ext-task-head')).toBeVisible({ timeout: 90_000 })
    await expect(sv.getByTestId('ext-task-title')).toHaveText(words)
    const s = sv.getByTestId('ask-object-session')
    await expect(s).toBeVisible({ timeout: 60_000 })
    made.push(await taskOfSession((await s.getAttribute('data-session-id')) ?? ''))
  } finally {
    await lab.ctx.unroute('**/api/sessions/quick-start', route)
    await sp?.close()
  }
})
