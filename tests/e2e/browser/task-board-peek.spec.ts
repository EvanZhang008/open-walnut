/**
 * A task chip on a leader's Board opens that task in the RIGHT column of the
 * split, in place of the leader's chat, as a TAB in the column's bar
 * (web/src/components/board/BoardTaskPeek.tsx, PeekTabBar.tsx, usePeekTabs.ts,
 * SessionPanel `inset`), as a user meets it on Home:
 *
 *   a. a worker WITH a session: a tab beside "Chat", its chat on the right under a
 *      header that names it as another task (title, live phase, "goes to this
 *      task"); the leader's chat hidden but mounted; the board frame not reloaded
 *      or scrolled;
 *   b. the Chat tab returns the leader's chat with its unsent draft and scroll,
 *      and the worker's tab stays;
 *   c. a worker with NO session, and an id the store does not know: a card with
 *      "Open task"; each chip adds a tab, a chip with a tab switches to it;
 *   d. the tabs switch by click, by the arrow keys, from the right-click menu and
 *      from the list button (the same menu, listing every tab); × closes one;
 *   e. the panel's own chip and Escape show the Chat tab; the inset's × closes
 *      its tab and the next one takes the column;
 *   f. sticky: Files keeps the tab on screen, the Board shows the same one, and
 *      leaving full screen and coming back does too; a chip opens a hidden chat
 *      column again;
 *   g. a message typed in a tab goes to the WORKER's session, not the leader's;
 *   and "Open task" still does the old jump to the task on Home.
 *   h. on a WORKER's panel the Board is its leader's: there the leader's chip opens
 *      the leader in a tab, and the worker's own chip goes back to its chat.
 *   i. full screen with no Board: a task clicked in the chat opens as a tab the
 *      same way, and the tabs come back after a reload.
 *
 * The chromium and webkit projects share ONE fixture board, so every task is
 * named `${engine}-peek-…` with a stamp and nothing counts across the board.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = '/tmp/board-b'
// The Board's own chip words (board-elements.frame.js PHASES), which the peek header repeats.
const PHASE_LABELS: Record<string, string> = {
  TODO: 'To do', WAITING: 'Waiting', IN_PROGRESS: 'In progress', NEED_ACTION: 'Needs you', COMPLETE: 'Done',
}

let fixtureRoot = ''
const litter: string[] = []

// deviceScaleFactor 1: evidence shots stay 1280px wide in WebKit too (Desktop Safari is 2x).
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOT_DIR, { recursive: true })
})

test.afterEach(async () => {
  // Children first, so no delete trips over a parent that still has children.
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
  litter.length = 0
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, source: 'local', ...opts })
  litter.push(task.id)
  return task.id
}

const phaseOf = async (id: string) => (await api<{ task: { phase: string } }>('GET', `/api/tasks/${id}`)).task.phase
const historyText = async (sid: string) => {
  const res = await fetch(`${API}/api/v1/sessions/${sid}/history?tail=50`)
  return res.ok ? res.text() : ''
}

/** Real navigation by link click (never page.goto), then the home page. */
async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

async function quickStart(page: Page, composer: Locator, prompt: string): Promise<{ taskId: string; sessionId: string }> {
  const response = page.waitForResponse((r) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(prompt)
  await composer.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const out = (await res.json()) as { taskId: string; sessionId: string }
  litter.push(out.taskId)
  return out
}

/** The chat column's tab bar (PeekTabBar.tsx) inside one panel's own chat column. */
function columnTabs(col: Locator) {
  const bar = col.locator(':scope > .peek-tab-bar')
  const tab = (id: string) => bar.locator(`.peek-tab[data-task-id="${id}"]`)
  return {
    bar,
    tab,
    button: (id: string) => tab(id).getByRole('tab'),
    chat: bar.getByRole('tab', { name: 'Chat', exact: true }),
    ids: () => bar.locator('.peek-tab').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.taskId ?? '')),
  }
}

/** Menus never overflow the viewport (web/src/AGENTS.md, menus and overlays). */
async function expectInViewport(el: Locator): Promise<void> {
  const box = (await el.boundingBox())!
  const vp = el.page().viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
}

/** A board tall enough to scroll, its chips in the middle. */
function boardHtml(engine: string, stamp: string, ids: { leader: string; withSession: string; noSession: string }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Board</title>
<style>
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; background: #f3f4f7; color: #1f2430; }
  header { padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e8ee; }
  .spacer { height: 900px; margin: 0 16px; border-left: 2px dashed #d5d9e2; }
  section { background: #fff; border: 1px solid #e5e8ee; border-radius: 10px; margin: 8px 16px; padding: 10px 12px; }
  section p { margin: 6px 0; }
</style></head>
<body>
<header><h1 style="margin:0;font-size:17px">${engine} peek board ${stamp}</h1></header>
<div class="spacer"></div>
<section id="team">
  <h3 style="margin:0">Team</h3>
  <p>Probe: <walnut-task id="${ids.withSession}"></walnut-task></p>
  <p>Docs: <walnut-task id="${ids.noSession}"></walnut-task></p>
  <p>Lead: <walnut-task id="${ids.leader}"></walnut-task></p>
  <p>Gone: <walnut-task id="nosuchtask0000"></walnut-task></p>
</section>
<div class="spacer"></div>
</body></html>`
}

test('a Board chip opens its task as a tab in place of the chat; the tabs switch, close and stay', async ({ page }) => {
  test.setTimeout(360_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  // ── The leader: a live mock-CLI session through the draft column ──
  const cwd = `${fixtureRoot}/projects/walnut`
  await openDraftOnCwd(page, cwd)
  // A reply long enough to scroll, so "Back keeps the scroll" is measured mid-history, not at 0.
  const leaderNotes = Array.from({ length: 40 }, (_, i) => `Leader note ${i + 1}: the probe owner reports back on the board.`).join('\n\n')
  const { taskId: leader, sessionId: leaderSid } = await quickStart(page, draftComposer(page), `snapshot-clean-turn:Board leader ready\n\n${leaderNotes}`)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${leaderSid}"]`)
  await expect(panel.getByText('Board leader ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await api('PATCH', `/api/tasks/${leader}`, { title: `${engine}-peek-leader ${stamp}` })
  const { task: leaderTask } = await api<{ task: { project?: string } }>('GET', `/api/tasks/${leader}`)
  const project = leaderTask.project ?? ''

  // ── Two workers by API: one with its own session, one with none ──
  const workerTitle = `${engine}-peek-probe ${stamp}`
  const worker = await createTask(workerTitle, { project, pinned: false, parent_task_id: leader })
  const started = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd, message: 'snapshot-clean-turn:Probe worker ready', taskId: worker,
  })
  const workerSid = started.sessionId
  await expect.poll(() => historyText(workerSid), { timeout: 60_000 }).toContain('Probe worker ready')
  const docsTitle = `${engine}-peek-docs ${stamp}`
  const docsSummary = 'Write the rollout notes once the probe is green, then hand them to the leader for review.'
  const docs = await createTask(docsTitle, { project, pinned: false, parent_task_id: leader, description: docsSummary })
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: boardHtml(engine, stamp, { leader, withSession: worker, noSession: docs }) })

  // ── The Board tab, scrolled to the team section, with a draft in the leader's composer ──
  const ownCol = panel.locator(':scope > .session-panel-split > .session-panel-chat-col')
  const leaderComposer = ownCol.locator(':scope > .session-panel-input .chat-input-textarea')
  const leaderBody = ownCol.locator(':scope > .session-panel-body')
  const leaderHistory = leaderBody.locator('.session-history').first()
  const chatBar = ownCol.locator(':scope > .session-chat-bar')
  const tabs = columnTabs(ownCol)
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  const frame = page.frameLocator('.task-board-frame')
  const chip = (id: string) => frame.locator(`#team walnut-task[id="${id}"] .wn-task`)
  await expect(chip(worker).locator('.wn-title')).toHaveText(workerTitle, { timeout: 15_000 })
  await expect(chip(docs).locator('.wn-title')).toHaveText(docsTitle)
  // No tab yet: the plain Chat bar.
  await expect(chatBar.locator('.session-chat-bar-title')).toHaveText('Chat')
  await expect(tabs.bar).toHaveCount(0)
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __sameDoc?: number }).__sameDoc = 1
    document.getElementById('team')!.scrollIntoView({ block: 'center' })
  })
  const boardY = await frame.locator('body').evaluate(() => window.scrollY)
  expect(boardY).toBeGreaterThan(300)
  const frameState = () => frame.locator('body').evaluate(() => ({
    sameDoc: (window as unknown as { __sameDoc?: number }).__sameDoc ?? 0, y: window.scrollY,
  }))
  const leaderDraft = `Leader draft ${stamp}, not sent`
  await leaderComposer.fill(leaderDraft)
  // Read the leader's history from the middle, with a real wheel (the follower treats a
  // wheel as the reader's own move, a programmatic scroll it may pin back to the end).
  await expect(leaderBody.getByText('Leader note 40: the probe owner reports back on the board.').last()).toBeVisible({ timeout: 30_000 })
  const histBox = (await leaderHistory.boundingBox())!
  await page.mouse.move(histBox.x + histBox.width / 2, histBox.y + histBox.height / 2)
  const gapBelow = () => leaderHistory.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
  for (let i = 0; i < 3 && (await gapBelow()) < 300; i++) {
    await page.mouse.wheel(0, -600)
    await page.waitForTimeout(400)
  }
  // Headless WebKit can drop a synthetic wheel after the first; the first one already let go of the end.
  if ((await gapBelow()) < 300) await leaderHistory.evaluate((el) => { el.scrollTop -= 600 })
  await expect.poll(gapBelow).toBeGreaterThan(300)
  let leaderScroll = -1
  await expect.poll(async () => { // settled: two equal reads in a row
    const now = await leaderHistory.evaluate((el) => el.scrollTop)
    const same = now === leaderScroll
    leaderScroll = now
    return same
  }).toBe(true)
  expect(leaderScroll).toBeGreaterThan(0)

  // ── a. The worker's chip: a tab, its chat on the right, named as another task ──
  await chip(worker).click()
  const peek = panel.getByTestId('board-task-peek')
  await expect(peek).toBeVisible()
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await expect.poll(tabs.ids).toEqual(['', worker])
  await expect(tabs.button(worker)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.chat).toHaveAttribute('aria-selected', 'false')
  await expect(tabs.tab(worker).getByTestId('peek-tab-title')).toHaveText(workerTitle)
  await expect(chatBar.locator('.session-chat-bar-title')).toHaveCount(0) // the tabs replace the "Chat" title
  await expect(chatBar.getByRole('button', { name: 'Hide chat' })).toBeVisible()
  await expect(peek.getByTestId('board-peek-context')).toContainText('Another task')
  await expect(peek.getByTestId('board-peek-title')).toHaveText(workerTitle)
  // Live: the header follows the store's row, whatever phase the worker's turn left it in.
  await expect.poll(async () => {
    const shown = await peek.getByTestId('board-peek-phase').textContent()
    return shown === PHASE_LABELS[await phaseOf(worker)]
  }, { timeout: 15_000 }).toBe(true)
  await expect(peek.getByTestId('board-peek-note')).toHaveText('Messages you send here go to this task, not to the chat you came from.')
  const inset = peek.locator(`.session-panel.session-panel-inset[data-session-id="${workerSid}"]`)
  await expect(inset.getByText('Probe worker ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  // The inset keeps its title row, phase, kebab, Locate and composer; no split chips, no expand or popout.
  await expect(inset.locator('.session-panel-title')).toHaveText(workerTitle)
  await expect(inset.getByTestId('session-panel-locate')).toBeVisible()
  await expect(inset.getByRole('button', { name: 'More actions' }).first()).toBeVisible()
  await expect(inset.locator('.chat-input-textarea')).toBeVisible()
  await expect(inset.locator('.session-action-chip', { hasText: /^(Changed|Files|Board|Terminal)$/ })).toHaveCount(0)
  await expect(inset.locator('.session-panel-expand, .session-panel-popout, .session-panel-lock')).toHaveCount(0)
  await expect(inset.getByRole('button', { name: 'Close this tab' })).toBeVisible()
  // The tab bar sits where the Chat bar was, at the same height as the board's bar.
  const tabBox = (await tabs.bar.boundingBox())!
  const boardBar = (await pane.locator('.task-board-bar').boundingBox())!
  expect(Math.abs(tabBox.y - boardBar.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(tabBox.height - boardBar.height)).toBeLessThanOrEqual(1)
  // The inset's own layout: header below the tabs, history below it, composer at the bottom of the column.
  const insetHeader = (await inset.locator(':scope > .session-panel-header').boundingBox())!
  const insetComposer = (await inset.locator('.session-panel-input').boundingBox())!
  const colBox = (await ownCol.boundingBox())!
  expect(insetHeader.y).toBeGreaterThanOrEqual(tabBox.y + tabBox.height)
  expect(insetComposer.y + insetComposer.height).toBeLessThanOrEqual(colBox.y + colBox.height + 1)
  expect(insetComposer.y + insetComposer.height).toBeGreaterThan(colBox.y + colBox.height - 40)
  // The leader's chat: hidden, still mounted, untouched.
  await expect(leaderBody).toHaveCount(1)
  await expect(leaderBody).toBeHidden()
  await expect(leaderComposer).toBeHidden()
  await expect(leaderBody.getByText('Board leader ready', { exact: true }).first()).toBeAttached()
  // The board did not reload or move.
  await expect(pane).toBeVisible()
  expect(await frameState()).toEqual({ sameDoc: 1, y: boardY })
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-1-peek-open.png` })

  // ── b. The Chat tab: the leader's chat, its draft and scroll as they were; the worker's tab stays ──
  await tabs.chat.click()
  await expect(peek).toHaveCount(0)
  await expect(leaderComposer).toBeVisible()
  await expect(leaderComposer).toHaveValue(leaderDraft)
  await expect(tabs.chat).toHaveAttribute('aria-selected', 'true')
  await expect.poll(tabs.ids).toEqual(['', worker])
  expect(await leaderHistory.evaluate((el) => el.scrollTop)).toBe(leaderScroll)
  expect(await frameState()).toEqual({ sameDoc: 1, y: boardY })
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-2-chat-tab.png` })

  // ── c. A chip with a tab switches to it; no session: a card; an unknown id ──
  await chip(worker).click()
  await expect(inset).toBeVisible()
  await expect.poll(tabs.ids).toEqual(['', worker])
  await chip(docs).click()
  await expect(peek).toHaveAttribute('data-task-id', docs)
  await expect.poll(tabs.ids).toEqual(['', worker, docs])
  await expect(tabs.button(docs)).toHaveAttribute('aria-selected', 'true')
  await expect(inset).toHaveCount(0)
  await expect(peek.getByTestId('board-peek-title')).toHaveText(docsTitle)
  await expect(peek.getByTestId('board-peek-phase')).toHaveText('To do')
  await expect(peek.getByTestId('board-peek-note')).toHaveCount(0)
  const card = peek.getByTestId('board-peek-card')
  await expect(card).toHaveAttribute('data-known', 'true')
  await expect(card).toContainText('No session yet')
  await expect(peek.getByTestId('board-peek-excerpt')).toHaveText(docsSummary)
  await expect(card.getByRole('button', { name: 'Open task' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-3-no-session-card.png` })
  await frame.locator('walnut-task[id="nosuchtask0000"] .wn-task').click()
  await expect(peek).toHaveAttribute('data-task-id', 'nosuchtask0000')
  await expect.poll(tabs.ids).toEqual(['', worker, docs, 'nosuchtask0000'])
  await expect(tabs.tab('nosuchtask0000').getByTestId('peek-tab-title')).toHaveText('nosuchtask0000')
  await expect(card).toHaveAttribute('data-known', 'false')
  await expect(card).toContainText('No task on this page has the id nosuchtask0000.')
  await expect(card.getByRole('button', { name: 'Open task' })).toBeVisible()
  await expect(peek.getByTestId('board-peek-phase')).toHaveCount(0)

  // ── d. Switching: a click, the arrow keys, the right-click menu, the list button; × closes ──
  await tabs.button(worker).click()
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await expect(inset.getByText('Probe worker ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await tabs.button(worker).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.button(docs)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(peek).toHaveAttribute('data-task-id', docs)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(tabs.chat).toBeFocused()
  const menu = page.getByTestId('peek-tab-menu')
  const menuLabels = menu.locator('.wn-context-menu-label')
  const everyTab = ['Chat', workerTitle, docsTitle, 'nosuchtask0000']
  await tabs.tab(worker).click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menuLabels).toHaveText([...everyTab, 'Close tab', 'Close other tabs', 'Close all tabs'])
  await expect(menu.getByRole('menuitemradio', { name: docsTitle })).toHaveAttribute('aria-checked', 'true')
  await expectInViewport(menu)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-4-tab-menu.png` })
  await menu.getByRole('menuitemradio', { name: workerTitle }).click()
  await expect(menu).toHaveCount(0)
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await tabs.bar.getByTestId('peek-tab-list').click()
  await expect(menu).toBeVisible()
  await expect(menuLabels).toHaveText([...everyTab, 'Close tab', 'Close other tabs', 'Close all tabs'])
  await expectInViewport(menu)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(peek).toHaveAttribute('data-task-id', worker) // Esc closed the menu, nothing else
  await expect(pane).toBeVisible()
  await tabs.tab('nosuchtask0000').hover()
  await tabs.tab('nosuchtask0000').getByTestId('peek-tab-close').click()
  await expect.poll(tabs.ids).toEqual(['', worker, docs])
  await expect(peek).toHaveAttribute('data-task-id', worker)

  // ── e. The panel's own chip and Escape show the Chat tab; the inset's × closes its tab ──
  await chip(leader).click()
  await expect(peek).toHaveCount(0)
  await expect(tabs.chat).toHaveAttribute('aria-selected', 'true')
  await expect.poll(tabs.ids).toEqual(['', worker, docs])
  await expect(leaderComposer).toHaveValue(leaderDraft)
  await tabs.button(worker).click()
  await expect(inset).toBeVisible()
  await inset.getByTestId('session-panel-locate').focus()
  await page.keyboard.press('Escape')
  await expect(peek).toHaveCount(0)
  await expect(tabs.chat).toHaveAttribute('aria-selected', 'true')
  await expect.poll(tabs.ids).toEqual(['', worker, docs])
  await expect(pane).toBeVisible() // one Esc, one layer: the split stays open
  await tabs.button(worker).click()
  await inset.getByRole('button', { name: 'Close this tab' }).click()
  await expect.poll(tabs.ids).toEqual(['', docs])
  await expect(peek).toHaveAttribute('data-task-id', docs) // the next tab to the right
  await expect(pane).toBeVisible()
  expect(await frameState()).toEqual({ sameDoc: 1, y: boardY })

  // ── f. Sticky: Files keeps the tab, the Board shows it, and so does a new full screen ──
  await chip(worker).click()
  await expect(inset).toBeVisible()
  await expect.poll(tabs.ids).toEqual(['', docs, worker])
  const header = panel.locator(':scope > .session-panel-header')
  await header.locator('.session-action-chip', { hasText: /^Files$/ }).click()
  await expect(pane).toHaveCount(0)
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await expect(inset).toBeVisible()
  await expect(tabs.button(worker)).toHaveAttribute('aria-selected', 'true')
  await panel.getByTestId('session-board-chip').click()
  await expect(chip(worker).locator('.wn-title')).toHaveText(workerTitle, { timeout: 15_000 })
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await header.getByRole('button', { name: 'Exit full screen' }).click()
  await expect(pane).toHaveCount(0)
  await expect(peek).toHaveCount(0)
  await expect(tabs.bar).toHaveCount(0)
  await expect(leaderComposer).toBeVisible()
  await expect(leaderComposer).toHaveValue(leaderDraft)
  await panel.getByTestId('session-board-chip').click()
  await expect(chip(worker).locator('.wn-title')).toHaveText(workerTitle, { timeout: 15_000 })
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await expect.poll(tabs.ids).toEqual(['', docs, worker])
  // A chip opens the chat column again when it was hidden.
  await chatBar.getByRole('button', { name: 'Hide chat' }).click()
  await expect(ownCol).toBeHidden()
  await chip(docs).click()
  await expect(ownCol).toBeVisible()
  await expect(peek).toHaveAttribute('data-task-id', docs)

  // ── g. A message typed in a tab goes to the worker's session ──
  await tabs.button(worker).click()
  const insetComposer2 = inset.locator('.chat-input-textarea')
  await insetComposer2.fill('snapshot-clean-turn:Probe worker heard the peek')
  await insetComposer2.press('Enter')
  await expect(inset.getByText('Probe worker heard the peek', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  // The mock CLI answers with the text after the mode prefix, and its transcript
  // keeps the assistant turns: the answer on the worker's transcript is the proof
  // the message reached the worker's CLI, and the leader's has none of it.
  await expect.poll(() => historyText(workerSid), { timeout: 30_000 }).toContain('"text":"Probe worker heard the peek"')
  expect(await historyText(leaderSid)).toContain('Board leader ready')
  expect(await historyText(leaderSid)).not.toContain('Probe worker heard the peek')
  await tabs.chat.click()
  await expect(leaderComposer).toHaveValue(leaderDraft)
  await expect(leaderBody.getByText('Probe worker heard the peek')).toHaveCount(0)

  // ── "Open task" is the old jump: the task on the home board ──
  await chip(docs).click()
  await peek.getByTestId('board-peek-card').getByRole('button', { name: 'Open task' }).click()
  await expect(page.locator(`.todo-panel-item[data-task-id="${docs}"]`)).toHaveClass(/task-focused/, { timeout: 15_000 })
  await expect(pane).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('on a worker\'s panel the Board is the leader\'s: the leader\'s chip opens the leader, the own chip goes back', async ({ page }) => {
  test.setTimeout(240_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  // ── The worker: a live session through the draft column; its leader by API ──
  const cwd = `${fixtureRoot}/projects/walnut`
  await openDraftOnCwd(page, cwd)
  const { taskId: worker, sessionId: workerSid } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Team worker ready')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${workerSid}"]`)
  await expect(panel.getByText('Team worker ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  const workerTitle = `${engine}-peek-team-worker ${stamp}`
  await api('PATCH', `/api/tasks/${worker}`, { title: workerTitle })
  const { task: workerTask } = await api<{ task: { project?: string } }>('GET', `/api/tasks/${worker}`)
  const leaderTitle = `${engine}-peek-team-leader ${stamp}`
  const leader = await createTask(leaderTitle, { project: workerTask.project ?? '', pinned: false })
  const { sessionId: leaderSid } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd, message: 'snapshot-clean-turn:Team leader ready', taskId: leader,
  })
  await expect.poll(() => historyText(leaderSid), { timeout: 60_000 }).toContain('Team leader ready')
  await api('PATCH', `/api/tasks/${worker}`, { parent_task_id: leader })
  await api('PUT', `/api/v1/tasks/${leader}/board`, {
    html: `<h1>${engine} team board ${stamp}</h1>
<p id="team">Lead: <walnut-task id="${leader}"></walnut-task> · Me: <walnut-task id="${worker}"></walnut-task></p>`,
  })

  // ── The worker's Board tab shows the team's board, the leader's ──
  await panel.getByTestId('session-board-chip').click()
  const frame = page.frameLocator('.task-board-frame')
  await expect(frame.locator('h1')).toHaveText(`${engine} team board ${stamp}`, { timeout: 15_000 })
  const chip = (id: string) => frame.locator(`#team walnut-task[id="${id}"] .wn-task`)
  await expect(chip(leader).locator('.wn-title')).toHaveText(leaderTitle)

  // The leader's chip is another task here: it opens the leader's chat in a tab.
  await chip(leader).click()
  const peek = panel.getByTestId('board-task-peek')
  await expect(peek).toHaveAttribute('data-task-id', leader)
  const ownCol = panel.locator(':scope > .session-panel-split > .session-panel-chat-col')
  const tabs = columnTabs(ownCol)
  await expect.poll(tabs.ids).toEqual(['', leader])
  await expect(tabs.button(leader)).toHaveAttribute('aria-selected', 'true')
  await expect(peek.getByTestId('board-peek-title')).toHaveText(leaderTitle)
  await expect(peek.getByTestId('board-peek-note')).toHaveText('Messages you send here go to this task, not to the chat you came from.')
  const inset = peek.locator(`.session-panel.session-panel-inset[data-session-id="${leaderSid}"]`)
  await expect(inset.getByText('Team leader ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  const ownBody = panel.locator(':scope > .session-panel-split > .session-panel-chat-col > .session-panel-body')
  await expect(ownBody).toBeHidden()

  // The worker's own chip: back to the worker's own chat, the leader's tab kept.
  await chip(worker).click()
  await expect(peek).toHaveCount(0)
  await expect(ownBody).toBeVisible()
  await expect(ownBody.getByText('Team worker ready', { exact: true }).first()).toBeVisible()
  await expect(tabs.chat).toHaveAttribute('aria-selected', 'true')
  await expect.poll(tabs.ids).toEqual(['', leader])

  expect(pageErrors).toEqual([])
})

test('in full screen a task clicked in the chat opens as a tab, and the tabs come back after a reload', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  // ── The leader through the draft column, a worker with its own session by API ──
  const cwd = `${fixtureRoot}/projects/walnut`
  await openDraftOnCwd(page, cwd)
  const { taskId: leader, sessionId: leaderSid } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Chat leader ready')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${leaderSid}"]`)
  await expect(panel.getByText('Chat leader ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  const leaderTitle = `${engine}-peek-chat-leader ${stamp}`
  await api('PATCH', `/api/tasks/${leader}`, { title: leaderTitle })
  const { task: leaderTask } = await api<{ task: { project?: string } }>('GET', `/api/tasks/${leader}`)
  const workerTitle = `${engine}-peek-chat-worker ${stamp}`
  const worker = await createTask(workerTitle, { project: leaderTask.project ?? '', pinned: false, parent_task_id: leader })
  const { sessionId: workerSid } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd, message: 'snapshot-clean-turn:Chat worker ready', taskId: worker,
  })
  await expect.poll(() => historyText(workerSid), { timeout: 60_000 }).toContain('Chat worker ready')

  // The leader names the worker in its reply: the chat renders the id as a task pill.
  const ownCol = panel.locator(':scope > .session-panel-split > .session-panel-chat-col')
  const leaderComposer = ownCol.locator(':scope > .session-panel-input .chat-input-textarea')
  const leaderBody = ownCol.locator(':scope > .session-panel-body')
  await leaderComposer.fill(`snapshot-clean-turn:The probe is ${worker}, ask it first.`)
  await leaderComposer.press('Enter')
  const pill = leaderBody.locator(`a.task-link[data-task-id="${worker}"]`).last()
  await expect(pill).toBeVisible({ timeout: 60_000 })
  const tabs = columnTabs(ownCol)

  // ── Full screen, no split view: the pill opens the worker as a tab, as on the Board ──
  const header = panel.locator(':scope > .session-panel-header')
  await header.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(header.getByRole('button', { name: 'Exit full screen' })).toBeVisible()
  await expect(tabs.bar).toHaveCount(0) // no tab yet, no bar
  await pill.click()
  const peek = panel.getByTestId('board-task-peek')
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await expect.poll(tabs.ids).toEqual(['', worker])
  await expect(tabs.button(worker)).toHaveAttribute('aria-selected', 'true')
  const inset = peek.locator(`.session-panel.session-panel-inset[data-session-id="${workerSid}"]`)
  await expect(inset.getByText('Chat worker ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await expect(leaderBody).toBeHidden()
  await expect(page.getByTestId('task-board-pane')).toHaveCount(0)
  // The tabs sit under the panel's header, the task under the tabs, its composer at the bottom.
  const headBox = (await header.boundingBox())!
  const tabBox = (await tabs.bar.boundingBox())!
  const peekBox = (await peek.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(tabBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height - 1)
  expect(Math.abs(peekBox.y - (tabBox.y + tabBox.height))).toBeLessThanOrEqual(1)
  expect(Math.abs(tabBox.width - panelBox.width)).toBeLessThanOrEqual(2)
  const insetComposer = (await inset.locator('.session-panel-input').boundingBox())!
  expect(insetComposer.y + insetComposer.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1)
  expect(insetComposer.y + insetComposer.height).toBeGreaterThan(panelBox.y + panelBox.height - 40)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-5-fullscreen-chat-tab.png` })
  // The Chat tab is the leader's own chat; the tab stays.
  await tabs.chat.click()
  await expect(peek).toHaveCount(0)
  await expect(leaderBody).toBeVisible()
  await expect(pill).toBeVisible()
  await tabs.button(worker).click()
  await expect(inset).toBeVisible()
  // Out of full screen the column is a plain chat again, and its pills keep their old jump target.
  await header.getByRole('button', { name: 'Exit full screen' }).click()
  await expect(peek).toHaveCount(0)
  await expect(tabs.bar).toHaveCount(0)
  await expect(leaderBody).toBeVisible()

  // ── A reload: the leader again from the list, full screen: the same tab on screen ──
  await openHome(page)
  await page.locator('.todo-search-input').fill(leaderTitle)
  const row = page.locator(`.todo-panel-item[data-task-id="${leader}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  if (!(await panel.isVisible())) await row.locator('.todo-item-title').click()
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await header.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(peek).toHaveAttribute('data-task-id', worker)
  await expect.poll(tabs.ids).toEqual(['', worker])
  await expect(inset.getByText('Chat worker ready', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  // Close all tabs: the bar goes with them.
  await tabs.chat.click({ button: 'right' })
  const menu = page.getByTestId('peek-tab-menu')
  await expect(menu.locator('.wn-context-menu-label')).toHaveText(['Chat', workerTitle, 'Close all tabs'])
  await menu.getByRole('menuitem', { name: 'Close all tabs' }).click()
  await expect(tabs.bar).toHaveCount(0)
  await expect(peek).toHaveCount(0)
  await expect(leaderBody).toBeVisible()

  expect(pageErrors).toEqual([])
})
