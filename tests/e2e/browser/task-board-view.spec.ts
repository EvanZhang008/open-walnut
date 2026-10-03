/**
 * The Board while the user reads it (web/src/components/board/: the runtime's view
 * keeping and slot, board-view-memory.ts, BoardReplyDock.tsx, TaskBoardPane.tsx):
 *
 *   V1. A leader's write (a new document) leaves the reader where they were: the
 *       element at the top stays at the top even when content lands above it, a
 *       <details> stays as the reader left it (open or closed), a thread the reader scrolled up in keeps its
 *       spot, and Files and back keeps all of it. Every thread opens at its newest
 *       message, one inside a closed <details> included (it used to open at its
 *       oldest, the one-rule bug).
 *   V2. Reply… opens the composer INLINE, in the thread's place under its messages:
 *       it covers nothing (the messages above, the next section pushed below), it
 *       moves with the page, grows with its text, takes the wheel for the page, and
 *       survives a leader's write with its text.
 *   V3. Finished items fold: an answered choice to one row (title, pick, the
 *       leader's `summary`), a thread in a done section to its newest message.
 *       A click opens either, Fold closes it, and the reader's pick outlives a
 *       write; an answer given here stays open until the board is rewritten.
 *
 * The chromium and webkit projects share ONE fixture board, so every task is
 * named `${engine}-view-…` with a stamp.
 */
import fs from 'node:fs/promises'
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = '/tmp/board-view'

let fixtureRoot = ''
const litter: string[] = []

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOT_DIR, { recursive: true })
})

test.afterEach(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
  litter.length = 0
})

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

const historyText = async (sid: string) => {
  const res = await fetch(`${API}/api/v1/sessions/${sid}/history?tail=80`)
  if (!res.ok) return ''
  const body = (await res.json()) as { messages?: Array<{ text?: string }> }
  return (body.messages ?? []).map((m) => m.text ?? '').join('\n')
}

async function leaderWithSession(title: string, project: string, ready: string): Promise<{ id: string; sid: string }> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, project, source: 'local', pinned: false })
  litter.push(task.id)
  const { sessionId } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd: `${fixtureRoot}/projects/walnut`, message: `snapshot-clean-turn:${ready}`, taskId: task.id,
  })
  await expect.poll(() => historyText(sessionId), { timeout: 60_000 }).toContain(ready)
  return { id: task.id, sid: sessionId }
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

/** The leader's page in the Board pane (a build with Walnut's team Overview opens on it: pick Custom). */
async function showPage(pane: Locator): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom.or(pane.locator('.task-board-frame')).first()).toBeVisible({ timeout: 15_000 })
  if (await custom.isVisible()) {
    await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
    if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
  }
  await expect(pane.locator('.task-board-frame')).toBeVisible()
}

async function openBoard(page: Page, taskId: string, sid: string): Promise<{ panel: Locator; pane: Locator; frame: FrameLocator }> {
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await showPage(pane)
  return { panel, pane, frame: page.frameLocator('.task-board-frame') }
}

const STYLE = `<style>
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; background: #f3f4f7; color: #1f2430; }
  main { padding: 6px 16px 40px; }
  section, details { background: #fff; border: 1px solid #e5e8ee; border-radius: 10px; margin: 10px 0; padding: 4px 12px 12px; }
  summary { cursor: pointer; padding: 8px 0; }
  h3 { margin: 8px 0; font-size: 14px; }
  .filler { height: 180px; color: #8a8f99; }
</style>`

/**
 * What a real board carried: a bar pinned to the top of the window, smooth scrolling, and
 * its own "keep the scroll" script (the old y in window.name, put back at load and twice
 * more), which knows nothing of content added above.
 */
const AUTHOR_EXTRAS = `<style>html { scroll-behavior: smooth; }</style>
<div id="pinned-bar" style="position:fixed;top:0;left:0;right:0;height:48px;background:#fff;border-bottom:1px solid #e5e8ee;z-index:5">Pinned bar</div>
<script>(function () {
  var K = 'own-view:';
  window.addEventListener('scroll', function () { window.name = K + Math.round(window.scrollY); }, { passive: true });
  if (window.name.indexOf(K) !== 0) return;
  document.documentElement.setAttribute('data-own-state', 'restored');
  var y = Number(window.name.slice(K.length));
  window.scrollTo(0, y);
  setTimeout(function () { window.scrollTo(0, y); }, 150);
  setTimeout(function () { window.scrollTo(0, y); }, 600);
})();</script>`

/** A long page: filler sections around the parts under test. `top` lands above everything (a leader's write). */
function longBoard(engine: string, stamp: string, top = '', extra = '', script = ''): string {
  const fill = (n: number) => Array.from({ length: n }, (_, i) => `<p class="filler">Filler ${i + 1}.</p>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body><main>
${top}
<h1 style="font-size:17px">${engine} view board ${stamp}</h1>
<section id="sec-a"><h3>Area A</h3>${fill(2)}</section>
<section id="sec-talk"><h3>Talk</h3><walnut-thread id="talk" title="Rollout talk"></walnut-thread>
  <p id="after-talk">The paragraph under the thread.</p></section>
<details id="sec-closed"><summary><h3 style="display:inline">Closed area</h3></summary>
  <walnut-thread id="ask" title="Asked earlier"></walnut-thread></details>
<details id="sec-notes" open><summary><h3 style="display:inline">Notes</h3></summary><p>Open as written.</p></details>
<section id="sec-b"><h3>Area B</h3>${fill(3)}<p id="b-mark">Area B, read to here.</p>${fill(3)}</section>
${extra}
<section id="sec-c"><h3>Area C</h3>${fill(4)}</section>
</main>${script}</body></html>`
}

const frameY = (frame: FrameLocator) => frame.locator('body').evaluate(() => Math.round(window.scrollY))
/** The reader's own scroll, at once (the page may ask for smooth scrolling). */
const scrollFrame = (frame: FrameLocator, y: number) => frame.locator('body').evaluate((_, to) => {
  const root = document.documentElement
  const was = root.style.scrollBehavior
  root.style.scrollBehavior = 'auto'
  window.scrollTo(0, to)
  root.style.scrollBehavior = was
}, y)
/** Where an element in the frame starts, in the frame's own window. */
const topIn = (el: Locator) => el.evaluate((n) => Math.round(n.getBoundingClientRect().top))
/** How far a thread's message area is from its newest message. */
const gapOf = (thread: Locator) => thread.evaluate((el) => {
  const s = el.querySelector('.wn-scroll') as HTMLElement
  return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight)
})
const scrollTopOf = (thread: Locator) => thread.evaluate((el) => Math.round((el.querySelector('.wn-scroll') as HTMLElement).scrollTop))

test('the reader keeps their place across the leader\'s writes, and every thread opens at its newest', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const { id: leader, sid } = await leaderWithSession(`${engine}-view-keep-leader ${stamp}`, `${engine}-view ${stamp}`, 'View leader ready')
  const asLeader = { 'x-walnut-caller-sid': sid }
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: longBoard(engine, stamp, '', '', AUTHOR_EXTRAS) }, asLeader)
  for (let i = 1; i <= 14; i++) {
    await api('POST', `/api/v1/tasks/${leader}/board/threads/talk`, { text: `Talk note ${i}: the rollout owner reports back.` }, asLeader)
    await api('POST', `/api/v1/tasks/${leader}/board/threads/ask`, { text: `Ask note ${i}: an answer from earlier.` }, asLeader)
  }

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  let { panel, pane, frame } = await openBoard(page, leader, sid)
  const talk = frame.locator('walnut-thread[id="talk"]')
  const ask = frame.locator('walnut-thread[id="ask"]')
  await expect(talk.locator('.wn-msg')).toHaveCount(14, { timeout: 15_000 })
  await expect.poll(() => gapOf(talk)).toBeLessThanOrEqual(2)

  // One rule: a thread inside a closed <details> opens at its newest message too.
  await frame.locator('#sec-closed > summary').click()
  await expect(ask.locator('.wn-msg').last()).toBeVisible()
  await expect.poll(() => gapOf(ask)).toBeLessThanOrEqual(2)
  expect(await scrollTopOf(ask)).toBeGreaterThan(0)

  // The reader closes the notes the author wrote open, scrolls the talk up to its start, and the page down to Area B.
  await frame.locator('#sec-notes > summary').click()
  await expect(frame.locator('#sec-notes')).toHaveJSProperty('open', false)
  await talk.evaluate((el) => { (el.querySelector('.wn-scroll') as HTMLElement).scrollTop = 0 })
  await expect.poll(() => scrollTopOf(talk)).toBe(0)
  const mark = frame.locator('#b-mark')
  await scrollFrame(frame, await mark.evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY - 40)))
  const markTop = await topIn(mark)
  expect(Math.abs(markTop - 40)).toBeLessThanOrEqual(2)
  await page.waitForTimeout(600) // the view report is throttled to 300 ms

  // The leader writes: a tall block lands ABOVE everything. Same element at the top, same open <details>, same
  // spot in the talk, though the page's own script puts the old y back (Walnut's view wins, without a jump).
  const banner = `<section id="sec-new"><h3>New at the top</h3><p class="filler">New.</p><p class="filler">New.</p></section>`
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: longBoard(engine, stamp, banner, '', AUTHOR_EXTRAS) }, asLeader)
  await expect(frame.locator('#sec-new')).toBeAttached({ timeout: 15_000 })
  await expect.poll(() => topIn(mark), { timeout: 5_000 }).toBeGreaterThanOrEqual(markTop - 3)
  expect(await topIn(mark)).toBeLessThanOrEqual(markTop + 3)
  await page.waitForTimeout(1_200) // past the restore's settling: nothing moves it afterwards
  expect(Math.abs((await topIn(mark)) - markTop)).toBeLessThanOrEqual(3)
  await expect(frame.locator('#sec-closed')).toHaveJSProperty('open', true)
  await expect(frame.locator('#sec-notes')).toHaveJSProperty('open', false)
  await expect.poll(() => scrollTopOf(talk)).toBe(0)
  await expect.poll(() => gapOf(ask)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-V1-after-write.png` })

  // Files and back: a new pane, the same place.
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(pane).toHaveCount(0)
  await panel.getByTestId('session-board-chip').click()
  pane = page.getByTestId('task-board-pane')
  await showPage(pane)
  frame = page.frameLocator('.task-board-frame')
  await expect(frame.locator('#sec-new')).toBeAttached({ timeout: 15_000 })
  await expect.poll(() => topIn(frame.locator('#b-mark')), { timeout: 5_000 }).toBeGreaterThanOrEqual(markTop - 3)
  expect(await topIn(frame.locator('#b-mark'))).toBeLessThanOrEqual(markTop + 3)
  await expect(frame.locator('#sec-closed')).toHaveJSProperty('open', true)
  await expect.poll(() => scrollTopOf(frame.locator('walnut-thread[id="talk"]'))).toBe(0)
  // The page's own state in window.name came along into the new pane's frame.
  await expect(frame.locator('html')).toHaveAttribute('data-own-state', 'restored')
  expect(pageErrors).toEqual([])
})

test('Reply opens the composer inline, under the thread, and it covers nothing', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const { id: leader, sid } = await leaderWithSession(`${engine}-view-inline-leader ${stamp}`, `${engine}-view ${stamp}`, 'Inline leader ready')
  const asLeader = { 'x-walnut-caller-sid': sid }
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: longBoard(engine, stamp) }, asLeader)
  for (let i = 1; i <= 6; i++) {
    await api('POST', `/api/v1/tasks/${leader}/board/threads/talk`, { text: `Talk note ${i}.` }, asLeader)
  }

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { pane, frame } = await openBoard(page, leader, sid)
  const talk = frame.locator('walnut-thread[id="talk"]')
  await expect(talk.locator('.wn-msg')).toHaveCount(6, { timeout: 15_000 })
  await talk.evaluate((el) => el.scrollIntoView({ block: 'start' }))

  await talk.locator('.wn-reply').click()
  const dock = pane.getByTestId('board-reply-dock')
  const slot = talk.locator('.wn-dock-slot')
  const input = dock.locator('.chat-input-textarea')
  await expect(dock).toHaveAttribute('data-placement', 'inline')
  await expect(input).toBeFocused()
  await expect(dock.locator('.mic-btn-wrapper button')).toBeVisible()
  const off = async () => {
    const [d, s] = [await dock.boundingBox(), await slot.boundingBox()]
    return d && s ? Math.max(Math.abs(d.y - s.y), Math.abs(d.x - s.x), Math.abs(d.width - s.width), Math.abs(d.height - s.height)) : 99
  }
  await expect.poll(off).toBeLessThanOrEqual(2)

  // It covers nothing: the messages end above it, the paragraph under the thread starts below it.
  const box = async (l: Locator) => (await l.boundingBox())!
  const d1 = await box(dock)
  expect((await box(talk.locator('.wn-scroll'))).y + (await box(talk.locator('.wn-scroll'))).height).toBeLessThanOrEqual(d1.y + 1)
  expect((await box(frame.locator('#after-talk'))).y).toBeGreaterThanOrEqual(d1.y + d1.height - 1)
  // The whole box is on the page at the slot: nothing else is drawn over its middle.
  const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="board-reply-dock"]'),
    [d1.x + d1.width / 2, d1.y + d1.height / 2])
  expect(hit).toBe(true)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-V2-inline.png` })

  // It moves with the page, and grows with its text (the slot makes room).
  const y0 = await frameY(frame)
  await scrollFrame(frame, y0 + 120)
  await expect.poll(off).toBeLessThanOrEqual(2)
  expect(Math.round((await box(dock)).y)).toBeLessThan(Math.round(d1.y) - 100)
  await input.fill(`Line one ${stamp}\nLine two\nLine three\nLine four`)
  await expect.poll(async () => (await box(dock)).height).toBeGreaterThan(d1.height + 20)
  await expect.poll(off).toBeLessThanOrEqual(2)
  // A wheel over the box scrolls the page under it.
  const y1 = await frameY(frame)
  await dock.locator('.task-board-dock-head').dispatchEvent('wheel', { deltaY: 200, bubbles: true })
  await expect.poll(() => frameY(frame)).toBeGreaterThan(y1 + 150)
  await expect.poll(off).toBeLessThanOrEqual(2)

  // A leader's write while the user types: the box stays at the thread, the text with it.
  await api('POST', `/api/v1/tasks/${leader}/board/edits`, { edits: [{ old: 'Area A</h3>', new: 'Area A, edited</h3>' }] }, asLeader)
  await expect(frame.locator('#sec-a h3')).toHaveText('Area A, edited', { timeout: 15_000 })
  await expect(input).toHaveValue(`Line one ${stamp}\nLine two\nLine three\nLine four`)
  await expect(dock).toHaveAttribute('data-placement', 'inline')
  await expect.poll(off).toBeLessThanOrEqual(2)

  // Send: the message lands above the box, which stays for the next one.
  await input.fill(`Inline reply ${stamp}`)
  await input.press('Enter')
  await expect(talk.locator('.wn-msg').last().locator('.wn-text')).toHaveText(`Inline reply ${stamp}`, { timeout: 15_000 })
  await expect(input).toHaveValue('')
  await expect.poll(off).toBeLessThanOrEqual(2)
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain(`Inline reply ${stamp}`)

  // Escape: the box and its slot go, and Reply… is back in its place.
  await input.press('Escape')
  await expect(dock).toHaveCount(0)
  await expect(slot).toHaveCount(0)
  await expect(talk.locator('.wn-reply')).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('finished items fold: an answered choice to one row, a done section\'s thread to its newest message', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const { id: leader, sid } = await leaderWithSession(`${engine}-view-fold-leader ${stamp}`, `${engine}-view ${stamp}`, 'Fold leader ready')
  const asLeader = { 'x-walnut-caller-sid': sid }
  const items = (note: string) => `
<section id="sec-shipped" data-project="shipped" data-status="done"><h3>Shipped</h3>
  <walnut-choice id="ship-when" title="When to ship" options="tue:Tuesday at 16:00,wed:Wednesday" recommended="tue"
    summary="Shipped Tuesday at 16:00, no pages."><p class="ctx">The window opens at 16:00.</p></walnut-choice>
  <walnut-thread id="ship-talk" title="Ship talk"></walnut-thread></section>
<section id="sec-open" data-status="decide"><h3>Open ${note}</h3>
  <walnut-choice id="next-step" title="Next step" options="a:Clean up,b:Leave it"></walnut-choice></section>`
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: longBoard(engine, stamp, '', items('one')) }, asLeader)
  await api('PUT', `/api/v1/tasks/${leader}/board/choices/ship-when`, { option: 'tue' })
  for (let i = 1; i <= 4; i++) {
    await api('POST', `/api/v1/tasks/${leader}/board/threads/ship-talk`, { text: `Ship note ${i}.` }, asLeader)
  }

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { frame } = await openBoard(page, leader, sid)
  const ship = frame.locator('walnut-choice[id="ship-when"]')
  const shipTalk = frame.locator('walnut-thread[id="ship-talk"]')
  const row = ship.locator('.wn-fold-row')

  // The answered choice: one row with what was asked, the pick and the leader's summary.
  await expect(ship).toHaveAttribute('data-folded', '', { timeout: 15_000 })
  await expect(row.locator('.wn-fold-title')).toHaveText('When to ship')
  await expect(row.locator('.wn-fold-pick')).toHaveText('Tuesday at 16:00')
  await expect(row.locator('.wn-fold-sum')).toHaveText('Shipped Tuesday at 16:00, no pages.')
  await expect(ship.locator('.wn-choice-opts')).toBeHidden()
  await expect(ship.locator('.ctx')).toBeHidden()
  expect((await ship.boundingBox())!.height).toBeLessThan(60)
  // The done section's thread: its newest message, and a way to the rest.
  await expect(shipTalk).toHaveAttribute('data-folded', '')
  const shown = shipTalk.locator('.wn-msg:visible')
  await expect(shown).toHaveCount(1)
  await expect(shown.locator('.wn-text')).toHaveText('Ship note 4.')
  await expect(shipTalk.locator('.wn-fold-more')).toHaveText('Show 3 earlier messages')
  await expect(shipTalk.locator('.wn-reply')).toBeHidden()
  await frame.locator('#sec-shipped').scrollIntoViewIfNeeded()
  await frame.locator('#sec-shipped').screenshot({ path: `${SHOT_DIR}/${engine}-V3-folded.png` })

  // Open both; the reader's pick outlives the leader's next write.
  await row.click()
  await expect(ship).not.toHaveAttribute('data-folded', '')
  await expect(ship.locator('.wn-choice-opt[aria-pressed="true"]')).toHaveText(/Tuesday at 16:00/)
  await expect(ship.locator('.wn-fold-btn')).toBeVisible()
  await shipTalk.locator('.wn-fold-more').click()
  await expect(shipTalk.locator('.wn-msg:visible')).toHaveCount(4)
  await expect.poll(() => gapOf(shipTalk)).toBeLessThanOrEqual(2)
  await expect(shipTalk.locator('.wn-fold-btn')).toBeVisible()
  await page.waitForTimeout(600) // the view report is throttled
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: longBoard(engine, stamp, '', items('two')) }, asLeader)
  await expect(frame.locator('#sec-open h3')).toHaveText('Open two', { timeout: 15_000 })
  await expect(frame.locator('walnut-choice[id="ship-when"]')).not.toHaveAttribute('data-folded', '')
  await expect(frame.locator('walnut-thread[id="ship-talk"]')).not.toHaveAttribute('data-folded', '')
  // Fold again: folded after the next write too.
  await ship.locator('.wn-fold-btn').click()
  await shipTalk.locator('.wn-fold-btn').click()
  await expect(ship).toHaveAttribute('data-folded', '')
  await expect(shipTalk).toHaveAttribute('data-folded', '')
  await page.waitForTimeout(600)

  // An answer given here stays open under the user's eyes; the next write folds it.
  const next = frame.locator('walnut-choice[id="next-step"]')
  await next.locator('.wn-choice-opt').first().click()
  await expect(next.locator('.wn-choice-status')).toHaveText(/^(Sent to the leader|Saved\. The leader sees it on the board\.)$/, { timeout: 15_000 })
  await expect(next).toHaveAttribute('data-answered', '')
  await expect(next).not.toHaveAttribute('data-folded', '')
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: longBoard(engine, stamp, '', items('three')) }, asLeader)
  await expect(frame.locator('#sec-open h3')).toHaveText('Open three', { timeout: 15_000 })
  await expect(frame.locator('walnut-choice[id="next-step"]')).toHaveAttribute('data-folded', '')
  await expect(frame.locator('walnut-choice[id="next-step"] .wn-fold-pick')).toHaveText('Clean up')
  await expect(frame.locator('walnut-choice[id="ship-when"]')).toHaveAttribute('data-folded', '')
  await expect(frame.locator('walnut-thread[id="ship-talk"]')).toHaveAttribute('data-folded', '')
  expect(pageErrors).toEqual([])
})
