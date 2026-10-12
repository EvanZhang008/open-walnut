/**
 * The session header's tool row holds still while the session record loads.
 *
 * The 2026-10-11 report: the Fork chip rendered nothing until the session
 * record named the session's task, then appeared in front of Changed and Files
 * and pushed both right by its width (Files moved from x=441 to x=483), so a
 * click aimed at Files in that window opened Changed. The record lands 60 to
 * 130 ms after Files is painted on an idle machine and much later on a slow
 * one; the Mac app (WebKit) showed it too. Board (it waits for the task as
 * well, and sits in front of Terminal), Locate (it took room late, which in a
 * narrow column sent a chip into the "..." menu) and Plan (it sat in front of
 * Fork and waited for a plan) did the same.
 *
 * Now whether Fork, Board and Locate exist is decided on the first frame from
 * what the page already knows of the session's task (the status store the task
 * list and the session finder seed): a session with a task gets them in place,
 * disabled with their reason as the title until the record is there; a session
 * known to have none never shows them (they could never act, and in a narrow
 * column they pushed Files and Terminal into "..."). A session nothing on the
 * page has named yet (a reload restoring its column, a deep link, the first
 * chat reference to it) waits with them; if its record then says it has no
 * task, their places stay as invisible, inert spacers, because taking them away
 * moved Files left by Fork's width and put Terminal where Files had been, so a
 * click aimed at Files opened Terminal (the r2 gate, L-10). A task deleted while
 * its session is open does the same: the server now announces the session's
 * new status (no task, a newer revision), and a record that raced the delete
 * cannot bring the controls back. A chat reference that names an open session
 * by a prefix folds into that session's column, which keeps its row as it was:
 * the replaced panel's memory goes only to a panel the host mounts for it (the
 * r3 gate, L-17); that row is checked on every frame its column is at rest,
 * not in the frames where the column slides (r4 gate, M-3). Plan, which only
 * some sessions have, sits after the chips every session has.
 *
 * Every test holds `GET /api/sessions/<id>` the way a slow box would and opens
 * the column through the UI (the task row, the session finder, a chat
 * reference); the only page loads past the first are the routes under test (a
 * reload, a deep link) and one reload that puts the socket behind a test route.
 * Chromium, and with PW_WEBKIT=1 --project webkit, WebKit (the Mac app).
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page, type Route, type WebSocketRoute } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SESSION_TITLE = 'Editor fixture session'
const PLAN_SESSION = { id: 'pw-plan-session-completed', query: 'Plan: investigate auth module' }
/** A real fixture record with no task. */
const TASKLESS = { id: '2532066a-e210-4702-be34-ed01008adbde', query: 'Deep link primary session' }
/** The controls that need the session's task, drawn as controls. */
const TASK_CONTROLS = ['[data-header-id="fork"] button', 'button[data-header-id="board"]', 'button[data-header-id="locate"]']
  .map((sel) => `${sel}:not([data-header-spacer])`).join(', ')
/** The places they keep once the record said "no task" (and the "..." chip when only they are folded). */
const SPACERS = '[data-header-spacer="true"]'
const SHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? 'test-results/session-header-chips-hold-place'

const column = (page: Page, sid: string) =>
  page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)

interface Hold {
  /** GETs of the record that arrived while held. */
  held: () => number
  release: () => void
  dispose: () => Promise<void>
}

/** Hold every GET of one session's record until `release()`, what a slow box does. */
async function holdRecord(page: Page, sessionId: string, opts: { fail?: boolean } = {}): Promise<Hold> {
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  let held = 0
  const url = new RegExp(`/api/sessions/${sessionId}(\\?|$)`)
  const handler = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue()
    held++
    // A failing box answers 500 at once and every time: the panel retries, then gives up.
    if (opts.fail) return route.fulfill({ status: 500, json: { error: 'record read failed (test)' } })
    await gate
    // The page may be gone by the time the hold ends (a failed test); nothing to deliver then.
    await route.continue().catch(() => undefined)
  }
  await page.route(url, handler)
  return {
    held: () => held,
    release: () => open(),
    dispose: async () => { open(); await page.unroute(url, handler).catch(() => undefined) },
  }
}

/** Open the fixture session's column from its task row, as a person does. */
async function openFromTaskRow(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = column(page, SESSION_ID)
  await expect(panel).toBeVisible()
  return panel
}

/** Open a session as a home column through the finder (Cmd/Ctrl+Shift+O, type, click). */
async function openViaFinder(page: Page, query: string, sid: string): Promise<Locator> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const finder = page.locator('.session-search-panel')
  await expect(finder).toBeVisible()
  // The finder keeps the last query while closed and clears it in an effect once it is shown;
  // text typed before that effect is wiped with it (seen on the second open of the same query).
  // The same effect focuses the box a frame later, so a focused box has been cleared.
  const input = finder.locator('.session-search-input')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('')
  // It lists recent sessions at once and swaps in the query's answer 250 ms after the last
  // keystroke. A click during that swap can press one row and release on another, which opens
  // nothing (seen in WebKit), so click once the answer is on screen.
  const answered = page.waitForResponse((res) => {
    const u = new URL(res.url())
    return u.pathname === '/api/sessions/recent' && u.searchParams.get('q') === query
  })
  await input.fill(query)
  await expect(input).toHaveValue(query)
  await answered
  await expect(finder.locator('.todo-search-spinner')).toHaveCount(0)
  const result = finder.locator('.session-search-result').filter({ has: page.locator('.session-search-title', { hasText: query }) })
  await expect(result).toHaveCount(1, { timeout: 10_000 })
  await result.click()
  const panel = column(page, sid)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

type Box = { x: number; y: number; w: number; h: number }

/** Every item on the tool row that is drawn, by its header id ("more" for the "..." chip). */
async function rowBoxes(panel: Locator): Promise<Record<string, Box>> {
  return panel.locator('.session-meta-row-2').evaluate((row) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {}
    for (const el of row.querySelectorAll<HTMLElement>('[data-header-id], [data-header-more]')) {
      const b = el.getBoundingClientRect()
      if (b.width <= 0 || b.height <= 0) continue
      const id = el.dataset.headerId ?? 'more'
      out[id] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
    }
    return out
  })
}

/** The items that moved, resized or left the row between two reads ("id: before -> after"). */
function moved(before: Record<string, Box>, after: Record<string, Box>): string[] {
  const out: string[] = []
  for (const [id, b] of Object.entries(before)) {
    const a = after[id]
    if (!a) { out.push(`${id}: left the row`); continue }
    if (a.x !== b.x || a.y !== b.y || a.w !== b.w) out.push(`${id}: ${b.x},${b.y} w${b.w} -> ${a.x},${a.y} w${a.w}`)
  }
  return out
}

/** Two frames for React and the row's fit observer, then a beat for its re-measure. */
async function settle(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.waitForTimeout(250)
}

/** What a control that waits for the record says while it waits (its title). */
const WAITING: Record<string, string> = {
  fork: 'Fork becomes available once the session has loaded',
  board: 'The Board becomes available once the session has loaded',
  locate: 'Locate becomes available once the session has loaded',
}

/** Open the row's "..." menu and check the rows of whatever is folded into it, then Escape. */
async function checkFoldedRows(page: Page, panel: Locator, ready: boolean) {
  // Which items are folded depends on the fonts (and so on the machine): read it from the row.
  const folded = await panel.locator('.session-meta-row-2 [data-header-id][data-hidden="true"]').evaluateAll(
    (els) => els.map((el) => (el as HTMLElement).dataset.headerId!),
  )
  const waiting = folded.filter((id) => id in WAITING)
  expect(waiting.length, `a narrow row folds a control that waits for the record (folded: ${folded.join(',')})`).toBeGreaterThan(0)
  await panel.getByTestId('session-header-more-btn').click()
  const menu = page.getByTestId('session-header-more-menu')
  await expect(menu).toBeVisible()
  for (const id of folded) {
    const row = menu.getByTestId(`session-header-more-item-${id}`)
    if (!(id in WAITING)) { await expect(row, `${id} needs nothing from the record`).toBeEnabled(); continue }
    if (ready) { await expect(row).toBeEnabled(); continue }
    await expect(row).toBeDisabled()
    await expect(row).toHaveAttribute('title', WAITING[id]!)
  }
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

/** Draw every session column at `px` wide from here on (the next column opens at that width). */
async function clampColumns(page: Page, px: number) {
  await page.evaluate((width) => {
    document.getElementById('pw-column-clamp')?.remove()
    const style = document.createElement('style')
    style.id = 'pw-column-clamp'
    style.textContent = `.main-page-session-column {
      width: ${width}px !important; max-width: ${width}px !important; min-width: 0 !important; flex: 0 0 ${width}px !important;
    }`
    document.head.appendChild(style)
  }, px)
}

/** No Fork, Board or Locate and no spacer, nothing disabled, and Files and Terminal on the row (not folded). */
async function expectNoTaskControls(panel: Locator, when: string) {
  const row = panel.locator('.session-meta-row-2')
  await expect(row.locator(TASK_CONTROLS), `${when}: no Fork, Board or Locate`).toHaveCount(0)
  await expect(row.locator(SPACERS), `${when}: and no place kept for them`).toHaveCount(0)
  await expect(row.locator('button:disabled'), `${when}: no disabled control on the row`).toHaveCount(0)
  for (const id of ['files', 'terminal']) {
    const chip = row.locator(`button[data-header-id="${id}"]`)
    await expect(chip, `${when}: ${id} is on the row`).toHaveAttribute('data-hidden', 'false')
    await expect(chip).toBeVisible()
  }
}

/**
 * Fork, Board and Locate are spacers: there, invisible, out of reach (no pointer, no focus, no name,
 * not in the accessibility tree), and the "..." chip counts and lists only the live items it holds.
 */
async function expectSpacers(page: Page, panel: Locator, when: string) {
  const row = panel.locator('.session-meta-row-2')
  await expect(row.locator(TASK_CONTROLS), `${when}: no Fork, Board or Locate to press`).toHaveCount(0)
  const facts = await row.evaluate((r, sel) => {
    const isSpacerItem = (el: HTMLElement) => el.matches(sel) || !!el.querySelector(sel)
    const spacers = [...r.querySelectorAll<HTMLElement>(sel)].map((el) => {
      const item = el.closest<HTMLElement>('[data-header-id]')
      const cs = getComputedStyle(el)
      el.focus()
      return {
        id: el.dataset.headerMore ? 'more' : item?.dataset.headerId ?? '?',
        visibility: cs.visibility,
        pointer: cs.pointerEvents,
        ariaHidden: el.getAttribute('aria-hidden'),
        tabIndex: el.tabIndex,
        named: !!(el.getAttribute('aria-label') || el.getAttribute('title') || el.dataset.testid),
        focused: document.activeElement === el,
      }
    })
    const foldedLive = [...r.querySelectorAll<HTMLElement>('[data-header-id][data-hidden="true"]')]
      .filter((el) => !isSpacerItem(el)).map((el) => el.dataset.headerId!)
    const more = r.querySelector<HTMLElement>('[data-header-more]:not([data-header-spacer])')
    return { spacers, foldedLive, more: more?.getAttribute('aria-label') ?? null }
  }, SPACERS)
  const ids = facts.spacers.map((f) => f.id)
  for (const id of ['fork', 'board', 'locate']) expect(ids.filter((x) => x === id), `${when}: ${id} keeps one place`).toHaveLength(1)
  for (const f of facts.spacers) {
    expect(f, `${when}: the ${f.id} spacer is invisible and out of reach`).toEqual({
      id: f.id, visibility: 'hidden', pointer: 'none', ariaHidden: 'true', tabIndex: -1, named: false, focused: false,
    })
  }
  await expect(row.getByRole('button', { name: /Fork|Board|Locate|Find on Home/ }), `${when}: no such button for assistive tech`).toHaveCount(0)
  if (facts.foldedLive.length === 0) {
    expect(facts.more, `${when}: no "..." to open when only spacers are folded`).toBeNull()
    return
  }
  expect(facts.more, `${when}: "..." counts only what it can open`).toBe(`More (${facts.foldedLive.length})`)
  await panel.getByTestId('session-header-more-btn').click()
  const menu = page.getByTestId('session-header-more-menu')
  await expect(menu).toBeVisible()
  const listed = await menu.locator('[data-testid^="session-header-more-item-"]').evaluateAll(
    (els) => els.map((el) => (el as HTMLElement).dataset.testid!.replace('session-header-more-item-', '')),
  )
  expect(listed, `${when}: the menu lists only live items`).toEqual(facts.foldedLive)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

/** Record Files' box on every frame of the panel(s) matching `panelSel` until the returned stop. */
async function traceFiles(page: Page, panelSel: string): Promise<() => Promise<string[]>> {
  await page.evaluate((sel) => {
    const trace = { on: true, seen: [] as string[] }
    ;(window as unknown as { __filesTrace: typeof trace }).__filesTrace = trace
    const tick = () => {
      if (!trace.on) return
      for (const el of document.querySelectorAll<HTMLElement>(`${sel} .session-meta-row-2 [data-header-id="files"]`)) {
        const b = el.getBoundingClientRect()
        const key = `${Math.round(b.x)},${Math.round(b.y)} w${Math.round(b.width)} h${Math.round(b.height)}`
        if (b.width > 0 && !trace.seen.includes(key)) trace.seen.push(key)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, panelSel)
  return () => page.evaluate(() => {
    const trace = (window as unknown as { __filesTrace: { on: boolean; seen: string[] } }).__filesTrace
    trace.on = false
    return trace.seen
  })
}

/** What traceRow saw: the row layouts of the frames where the column was at rest, in the order first
 *  seen, how many frames that was (all, and after the mark), and how many frames it skipped. */
interface RowTrace { rest: string[]; restFrames: number; restFramesAfterMark: number; movingFrames: number }

/**
 * Record the tool row's layout on every frame of the panel matching `panelSel`, relative to the row
 * (each drawn item's id, offset from the row's left edge and width), until the returned stop; `mark`
 * notes the moment from which rest frames are counted apart. Only frames where the column is at rest
 * count: the row's own page box (unrounded) is the same as in the previous frame, and no element
 * holding the row runs an animation. While other columns enter and leave, the columns slide and scale
 * (auto-animate), and WebKit draws single frames there with the row's items 3 to 6 px off its edge
 * (r4 gate, M-3; the base tree draws them too). Nobody can aim at a column in flight; a row at rest
 * must not change.
 */
async function traceRow(page: Page, panelSel: string): Promise<{ mark: () => Promise<void>; stop: () => Promise<RowTrace> }> {
  await page.evaluate((sel) => {
    const trace = { on: true, marked: false, rest: [] as string[], restFrames: 0, restFramesAfterMark: 0, movingFrames: 0, lastBox: '' }
    ;(window as unknown as { __rowTrace: typeof trace }).__rowTrace = trace
    const tick = () => {
      if (!trace.on) return
      const row = document.querySelector<HTMLElement>(`${sel} .session-meta-row-2`)
      if (row) {
        const r = row.getBoundingClientRect()
        const box = `${r.x.toFixed(2)},${r.y.toFixed(2)} w${r.width.toFixed(2)}`
        let animating = false
        for (let el = row.parentElement; el && !animating; el = el.parentElement) {
          animating = el.getAnimations().some((a) => a.playState === 'running')
        }
        const atRest = box === trace.lastBox && !animating
        trace.lastBox = box
        if (!atRest) trace.movingFrames++
        else {
          const items: string[] = []
          for (const el of row.querySelectorAll<HTMLElement>('[data-header-id], [data-header-more]')) {
            const b = el.getBoundingClientRect()
            if (b.width <= 0 || b.height <= 0) continue
            items.push(`${el.dataset.headerId ?? 'more'}@${Math.round(b.x - r.x)}w${Math.round(b.width)}`)
          }
          const key = items.join(' ')
          if (!trace.rest.includes(key)) trace.rest.push(key)
          trace.restFrames++
          if (trace.marked) trace.restFramesAfterMark++
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, panelSel)
  type Live = RowTrace & { on: boolean; marked: boolean }
  return {
    mark: () => page.evaluate(() => { (window as unknown as { __rowTrace: Live }).__rowTrace.marked = true }),
    stop: () => page.evaluate(() => {
      const trace = (window as unknown as { __rowTrace: Live }).__rowTrace
      trace.on = false
      return { rest: trace.rest, restFrames: trace.restFrames, restFramesAfterMark: trace.restFramesAfterMark, movingFrames: trace.movingFrames }
    }),
  }
}

/**
 * The row layouts at rest that differ from the first one: another set of items, or an item whose
 * offset or width moved by more than a pixel (a column at a fractional offset can round every item
 * one pixel away from the row's own edge; that moves nothing).
 */
function rowLayoutChanges(seen: string[]): string[] {
  const parse = (key: string) => key.split(' ').map((item) => {
    const [, id, x, w] = item.match(/^(.+)@(-?\d+)w(\d+)$/)!
    return { id: id!, x: Number(x), w: Number(w) }
  })
  const first = parse(seen[0]!)
  return seen.slice(1).filter((key) => {
    const items = parse(key)
    return items.length !== first.length || items.some((it, i) => it.id !== first[i]!.id
      || Math.abs(it.x - first[i]!.x) > 1 || Math.abs(it.w - first[i]!.w) > 1)
  })
}

/** A traced box ("x,y wW hH") holds the point. */
function boxHolds(key: string, p: { x: number; y: number }): boolean {
  const [x, y, w, h] = key.match(/-?\d+/g)!.map(Number)
  return p.x >= x! && p.x <= x! + w! && p.y >= y! && p.y <= y! + h!
}

/**
 * The record of a session nothing on the page had named is held: the panel waits with all three
 * task controls. The person aims at Files; the record lands and says the session has no task. In no
 * frame does Files move, nothing else on the row moves either, the three are spacers, and the click
 * opens Files. `remounts`: the column is replaced by a new panel under the full id (a prefix deep
 * link), which enters with the columns' own scale-in (auto-animate): the whole panel scales, its row
 * does not change, and the aimed point stays on Files in every frame.
 */
async function aimAtFilesAcrossNoTask(page: Page, panel: Locator, panelSel: string, hold: Hold, when: string, shot?: string, remounts = false): Promise<string> {
  await expect.poll(() => hold.held(), { message: `${when}: the record is on its way` }).toBeGreaterThan(0)
  await settle(page)
  const fork = panel.getByRole('button', { name: 'Fork session into a child task' })
  await expect(fork, `${when}: nothing on the page named the session, so it waits with the task controls`).toBeDisabled()
  await expect(fork).toHaveAccessibleDescription(WAITING.fork!)
  await expect(panel.getByTestId('session-board-chip')).toBeDisabled()
  await expect(panel.getByTestId('session-panel-locate')).toBeDisabled()
  await page.mouse.move(0, 0)
  const before = await rowBoxes(panel)
  if (shot) await shootHeader(page, panel, `${shot}-held`)
  const box = (await panel.locator('button[data-header-id="files"]').boundingBox())!
  const aim = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const stop = await traceFiles(page, panelSel)

  hold.release()
  await expect(panel.locator(TASK_CONTROLS), `${when}: the record says no task`).toHaveCount(0, { timeout: 15_000 })
  await expect(panel.locator('.session-panel-badge', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
  await settle(page)
  const after = await rowBoxes(panel)
  const seen = await stop()
  const reading = `${shown(before)} -> ${shown(after)} moved ${JSON.stringify(moved(before, after))} files-frames ${JSON.stringify(seen)}`
  expect(moved(before, after), `${when}: nothing on the row moves when the record says no task`).toEqual([])
  const b = before.files!
  if (remounts) {
    expect(seen.filter((key) => !boxHolds(key, aim)), `${when}: the aimed point is on Files in every frame`).toEqual([])
  } else {
    expect(seen, `${when}: Files sits still in every frame`).toEqual([`${b.x},${b.y} w${b.w} h${b.h}`])
  }
  await expectSpacers(page, panel, when)
  if (shot) await shootHeader(page, panel, `${shot}-loaded`)

  await page.mouse.click(aim.x, aim.y)
  await expect(panel.locator('.session-action-chip-active'), `${when}: the click aimed at Files opens Files`).toHaveText(['Files'])
  await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 10_000 })
  return reading
}

/** Close every session column, so the next round starts from none. */
async function closeAllColumns(page: Page) {
  const panels = page.locator('.main-page-session-column .session-panel')
  for (let i = 0; i < 6; i++) {
    const open = await panels.count()
    if (open === 0) break
    const panel = panels.first()
    // An open view (Files) takes the panel full screen, where Close gives way to Exit full screen:
    // its own chip closes the view first.
    const active = panel.locator('.session-meta-row-2 .session-action-chip-active')
    if (await active.count()) {
      await active.first().click()
      await expect(active).toHaveCount(0)
    }
    await panel.getByRole('button', { name: 'Close session panel' }).click()
    // A closing column animates out before it leaves the DOM: wait for it to go.
    await expect(panels).toHaveCount(open - 1)
  }
  await expect(panels).toHaveCount(0)
}

/** A real session with a real task of its own (quick-start, the mock CLI), for a test that deletes the task. */
async function seedTaskSession(page: Page, label: string): Promise<{ sid: string; taskId: string }> {
  const res = await page.request.post('/api/sessions/quick-start', {
    // A real folder, as every launch has: Fork needs one to act.
    data: { cwd: process.cwd(), message: `header fixture ${label} ${Date.now()}`, project: 'Header Fixture' },
  })
  expect(res.status(), await res.text()).toBe(200)
  const { sessionId: sid, taskId } = await res.json() as { sessionId: string; taskId: string }
  // The record is written once the spawn is confirmed.
  await expect.poll(async () => (await page.request.get(`/api/sessions/${sid}`)).status(), { timeout: 30_000 }).toBe(200)
  return { sid, taskId }
}

/** Open a seeded session's column from its task row. */
async function openSeededFromTaskRow(page: Page, seeded: { sid: string; taskId: string }): Promise<Locator> {
  await page.locator('.todo-search-input').fill(seeded.taskId)
  const task = page.locator(`.todo-panel-item[data-task-id="${seeded.taskId}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = column(page, seeded.sid)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

/** The ids drawn on a row, in a log line. */
const shown = (boxes: Record<string, Box>) => Object.keys(boxes).join(',')

/** A crop of the panel's two header rows. */
async function shootHeader(page: Page, panel: Locator, name: string) {
  const box = await panel.locator('.session-panel-header').boundingBox()
  if (!box) return
  await page.screenshot({
    path: `${SHOT_DIR}/${test.info().project.name}-${name}.png`,
    clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: Math.min(box.width + 8, 1280), height: box.height + 8 },
  })
}

test.beforeEach(async ({ page }) => {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  // Keep this page's view prefs off the shared fixture server, both ways.
  await page.route(/\/api\/ui-prefs(\?|$)/, (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { prefs: {} } })
    : route.fulfill({ json: { ok: true } }))
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* storage off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('a click aimed at Files while the session record loads opens Files', async ({ page }) => {
  const hold = await holdRecord(page, SESSION_ID)
  try {
    const panel = await openFromTaskRow(page)
    const files = panel.locator('button[data-header-id="files"]')
    await expect(files).toBeVisible()
    await expect.poll(() => hold.held(), { message: 'the record is still on its way while the person aims' }).toBeGreaterThan(0)
    const before = await rowBoxes(panel)
    const box = (await files.boundingBox())!
    const aim = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

    // The hand is on its way; the record lands first.
    hold.release()
    await expect(panel.locator('[data-header-id="fork"] button:enabled')).toBeVisible({ timeout: 15_000 })
    await expect(panel.locator('button[data-header-id="locate"]:enabled')).toBeVisible()
    await settle(page)
    const after = await rowBoxes(panel)
    console.log(`AIMED ${test.info().project.name} files ${JSON.stringify(before.files)} -> ${JSON.stringify(after.files)} moved=${JSON.stringify(moved(before, after))}`)

    await page.mouse.click(aim.x, aim.y)
    await expect(panel.locator('.session-action-chip-active'), 'the chip under the click is the one the person aimed at').toHaveText(['Files'])
    await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 10_000 })
    expect(moved(before, after), 'nothing on the tool row moves when the record lands').toEqual([])
  } finally {
    await hold.dispose()
  }
})

test('Fork, Board and Locate wait disabled in their places, then work once the record lands', async ({ page }) => {
  const hold = await holdRecord(page, SESSION_ID)
  try {
    const panel = await openFromTaskRow(page)
    await expect(panel.locator('button[data-header-id="files"]')).toBeVisible()
    const fork = panel.getByRole('button', { name: 'Fork session into a child task' })
    const board = panel.getByTestId('session-board-chip')
    const locate = panel.getByTestId('session-panel-locate')

    // Held: each is on the row, disabled, named for what it does, and says why it waits.
    await expect(fork).toBeVisible()
    await expect(fork).toBeDisabled()
    await expect(fork).toHaveAccessibleDescription('Fork becomes available once the session has loaded')
    await expect(board).toBeVisible()
    await expect(board).toBeDisabled()
    await expect(board).toHaveAccessibleName('Board')
    await expect(board).toHaveAccessibleDescription('The Board becomes available once the session has loaded')
    await expect(locate).toBeVisible()
    await expect(locate).toBeDisabled()
    await expect(locate).toHaveAccessibleName('Locate task')
    await expect(locate).toHaveAccessibleDescription('Locate becomes available once the session has loaded')
    // Changed and Files need nothing from the record and stay live.
    await expect(panel.locator('button[data-header-id="changed"]')).toBeEnabled()
    await expect(panel.locator('button[data-header-id="files"]')).toBeEnabled()
    // It looks like it waits: dimmed, no pointer cursor, and no hover wash under the mouse.
    const forkBox = (await fork.boundingBox())!
    await page.mouse.move(forkBox.x + forkBox.width / 2, forkBox.y + forkBox.height / 2)
    const look = await fork.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { opacity: Number(cs.opacity), cursor: cs.cursor, bg: cs.backgroundColor }
    })
    expect(look.opacity, 'a waiting chip is dimmed').toBeLessThan(0.6)
    expect(look.cursor).toBe('default')
    expect(look.bg, 'no hover wash on a waiting chip').toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
    await shootHeader(page, panel, '1-waiting')

    // A press does nothing yet: no fork draft column, no Board pane, no view chip lit.
    for (const el of [fork, board]) {
      const b = (await el.boundingBox())!
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    }
    // Nor does a right-click copy Fork's command: both engines deliver contextmenu to a disabled
    // button, so the chip has to refuse it itself (the label would turn into the wider "CLI
    // copied!" for 1.5 s). Chromium only: a right-click the page leaves alone opens WebKit's own
    // context menu, which in headless Playwright never closes and takes every later mouse event,
    // and WebKit gives the page no clipboard here anyway.
    if (test.info().project.name === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate(() => navigator.clipboard.writeText('clipboard before the right-click'))
      await page.mouse.click(forkBox.x + forkBox.width / 2, forkBox.y + forkBox.height / 2, { button: 'right' })
      await page.waitForTimeout(300)
      // Read once, not retried: a retrying assertion passes again once the copied label reverts.
      expect(await fork.textContent(), 'a right-click on the waiting Fork changes nothing').toBe('Fork')
      expect(await page.evaluate(() => navigator.clipboard.readText()), 'and copies nothing').toBe('clipboard before the right-click')
    }
    await page.waitForTimeout(400)
    await expect(page.locator('.main-page-session-column .draft-session-panel')).toHaveCount(0)
    await expect(page.getByTestId('task-board-pane')).toHaveCount(0)
    await expect(panel.locator('.session-action-chip-active')).toHaveCount(0)
    await page.mouse.move(0, 0)
    const before = await rowBoxes(panel)

    hold.release()
    await expect(fork).toBeEnabled({ timeout: 15_000 })
    await expect(board).toBeEnabled()
    await expect(locate).toBeEnabled()
    await expect(fork).toHaveAccessibleDescription(/^Fork this session into a new draft/)
    await expect(board).toHaveAccessibleDescription(/^The task's Board/)
    await expect(locate).toHaveAccessibleDescription(/^Go to task/)
    await expect.poll(() => fork.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
    await settle(page)
    expect(moved(before, await rowBoxes(panel)), 'the waiting chips were already where they live').toEqual([])
    await shootHeader(page, panel, '2-ready')

    // And now they act: Board opens the task's Board beside the chat.
    await board.click()
    await expect(board).toHaveClass(/session-action-chip-active/)
    await expect(page.getByTestId('task-board-pane')).toBeVisible({ timeout: 15_000 })
  } finally {
    await hold.dispose()
  }
})

test('a plan session: Plan arrives after the chips every session has, and Files stays put', async ({ page }) => {
  const hold = await holdRecord(page, PLAN_SESSION.id)
  try {
    const panel = await openViaFinder(page, PLAN_SESSION.query, PLAN_SESSION.id)
    const files = panel.locator('button[data-header-id="files"]')
    await expect(files).toBeVisible()
    await expect.poll(() => hold.held()).toBeGreaterThan(0)
    await expect(panel.locator('[data-header-id="plan"]'), 'no plan is known before the record').toHaveCount(0)
    const before = await rowBoxes(panel)
    const box = (await files.boundingBox())!

    hold.release()
    const plan = panel.locator('button[data-header-id="plan"]')
    await expect(plan).toBeVisible({ timeout: 15_000 })
    await settle(page)
    const after = await rowBoxes(panel)
    await shootHeader(page, panel, '3-plan')
    expect(moved(before, after), 'Plan joined the row without moving anything on it').toEqual([])
    expect(after.plan!.x, 'Plan sits after Terminal').toBeGreaterThan(after.terminal!.x)

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(panel.locator('.session-action-chip-active')).toHaveText(['Files'])
    await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 10_000 })
    // Plan still opens its popup.
    await plan.click()
    await expect(page.locator('.plan-popup-container')).toBeVisible({ timeout: 5_000 })
  } finally {
    await hold.dispose()
  }
})

test('in a narrow column nothing moves into the "..." menu when the record lands, open after open', async ({ page }) => {
  test.setTimeout(120_000)
  for (const [i, width] of [260, 300, 340, 380, 420].entries()) {
    let reading = `${width}px: no reading`
    await clampColumns(page, width)
    const hold = await holdRecord(page, SESSION_ID)
    try {
      // The first open comes from the task row; a second click on that row's title would
      // rename the task (it is selected now), so the later ones come from the session finder.
      const panel = i === 0 ? await openFromTaskRow(page) : await openViaFinder(page, SESSION_TITLE, SESSION_ID)
      await expect(panel.locator('[data-header-id="close"]')).toBeVisible()
      await settle(page)
      const rowWidth = await panel.locator('.session-meta-row-2').evaluate((row) => Math.round(row.getBoundingClientRect().width))
      const before = await rowBoxes(panel)
      // At 260px the controls folded into "..." include ones that wait: their rows wait too, saying why.
      if (width === 260) await checkFoldedRows(page, panel, false)
      hold.release()
      await expect(panel.locator('[data-header-id="fork"] button:enabled')).toBeAttached({ timeout: 15_000 })
      await expect(panel.locator('button[data-header-id="locate"]:enabled')).toBeAttached()
      await settle(page)
      const after = await rowBoxes(panel)
      if (width === 260) await checkFoldedRows(page, panel, true)
      const diff = moved(before, after)
      const appeared = Object.keys(after).filter((id) => !(id in before) && id !== 'time')
      reading = `${width}px (row ${rowWidth}px): shown ${Object.keys(before).join(',')} | moved ${JSON.stringify(diff)} | appeared ${JSON.stringify(appeared)}`
      expect(diff, `${width}px: nothing on the row moves when the record lands`).toEqual([])
      expect(appeared, `${width}px: nothing but the time joins the row late`).toEqual([])
      if (width === 300) await shootHeader(page, panel, '4-narrow-300')
      // Close it the way a person does, so the next width opens a fresh column.
      await panel.getByRole('button', { name: 'Close session panel' }).click()
      await expect(panel).toHaveCount(0)
    } finally {
      console.log(`NARROW ${test.info().project.name} ${reading}`)
      await hold.dispose()
    }
  }
})

test('a plan session in a narrow column: the late Plan chip joins the "..." menu and moves nothing', async ({ page }) => {
  test.setTimeout(120_000)
  for (const width of [300, 340, 420]) {
    let reading = `${width}px: no reading`
    await clampColumns(page, width)
    const hold = await holdRecord(page, PLAN_SESSION.id)
    try {
      const panel = await openViaFinder(page, PLAN_SESSION.query, PLAN_SESSION.id)
      await expect(panel.locator('[data-header-id="close"]')).toBeVisible()
      await settle(page)
      const before = await rowBoxes(panel)
      hold.release()
      await expect(panel.locator('button[data-header-id="plan"]')).toBeAttached({ timeout: 15_000 })
      await expect(panel.locator('button[data-header-id="locate"]:enabled')).toBeAttached()
      await settle(page)
      const after = await rowBoxes(panel)
      const diff = moved(before, after)
      const appeared = Object.keys(after).filter((id) => !(id in before) && id !== 'time' && id !== 'plan')
      const planShown = 'plan' in after
      reading = `${width}px: shown ${Object.keys(after).join(',')} | moved ${JSON.stringify(diff)} | appeared ${JSON.stringify(appeared)}`
      expect(diff, `${width}px: nothing on the row moves when Plan arrives`).toEqual([])
      expect(appeared, `${width}px: nothing but the time and Plan joins the row late`).toEqual([])
      if (planShown) expect(after.plan!.x, `${width}px: Plan sits after the host chips`).toBeGreaterThan(Math.max(...Object.entries(after).filter(([id]) => !['plan', 'more', 'time', 'locate', 'popout', 'lock', 'expand', 'close'].includes(id)).map(([, b]) => b.x)))
      else {
        // Folded: the "..." menu lists it, and it opens the plan from there.
        await panel.getByTestId('session-header-more-btn').click()
        await page.getByTestId('session-header-more-item-plan').click()
        await expect(page.locator('.plan-popup-container')).toBeVisible({ timeout: 5_000 })
        await page.locator('.plan-popup-close').click()
        await expect(page.locator('.plan-popup-container')).toHaveCount(0)
      }
      await panel.getByRole('button', { name: 'Close session panel' }).click()
      await expect(panel).toHaveCount(0)
    } finally {
      console.log(`NARROW-PLAN ${test.info().project.name} ${reading}`)
      await hold.dispose()
    }
  }
})

test('a record that fails to load leaves the chips in place, saying why they cannot act', async ({ page }) => {
  test.setTimeout(60_000)
  const hold = await holdRecord(page, SESSION_ID, { fail: true })
  try {
    const panel = await openFromTaskRow(page)
    const fork = panel.getByRole('button', { name: 'Fork session into a child task' })
    await expect(fork).toBeVisible()
    const before = await rowBoxes(panel)
    // The panel retries a failed read a few times, then gives up on it.
    await expect(fork).toHaveAccessibleDescription("Fork is unavailable because this session's details did not load", { timeout: 30_000 })
    await expect(fork).toBeDisabled()
    await expect(panel.getByTestId('session-board-chip')).toHaveAccessibleDescription("The Board is unavailable because this session's details did not load")
    await expect(panel.getByTestId('session-panel-locate')).toHaveAccessibleDescription("Locate is unavailable because this session's details did not load")
    expect(hold.held(), 'the panel asked again before giving up').toBeGreaterThan(1)
    await settle(page)
    expect(moved(before, await rowBoxes(panel))).toEqual([])
    // Files reads the folder on its own and still opens.
    await panel.locator('button[data-header-id="files"]').click()
    await expect(panel.locator('.session-action-chip-active')).toHaveText(['Files'])
  } finally {
    await hold.dispose()
  }
})

test('a session known to have no task shows no Fork, Board or Locate, before or after its record', async ({ page }) => {
  await clampColumns(page, 340)
  const hold = await holdRecord(page, TASKLESS.id)
  try {
    // The finder's list names the session and says it has no task, so the panel knows on its first frame.
    const panel = await openViaFinder(page, TASKLESS.query, TASKLESS.id)
    await expect(panel.locator('[data-header-id="close"]')).toBeVisible()
    await expect.poll(() => hold.held(), { message: 'the record is still on its way' }).toBeGreaterThan(0)
    await settle(page)
    await expectNoTaskControls(panel, '340px, record held')
    const before = await rowBoxes(panel)
    await shootHeader(page, panel, '5-taskless-held')

    hold.release()
    await expect(panel.locator('.session-panel-badge', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
    await settle(page)
    await expectNoTaskControls(panel, '340px, record loaded')
    const after = await rowBoxes(panel)
    console.log(`TASKLESS ${test.info().project.name} 340px: held ${shown(before)} | loaded ${shown(after)} | moved ${JSON.stringify(moved(before, after))}`)
    expect(moved(before, after), 'nothing on the row moves when the record lands').toEqual([])
    await shootHeader(page, panel, '6-taskless-loaded')

    // The live chips act as ever.
    await panel.locator('button[data-header-id="files"]').click()
    await expect(panel.locator('.session-action-chip-active')).toHaveText(['Files'])
  } finally {
    await hold.dispose()
  }
})

test('after a reload nothing names the session yet: its column waits with the task controls, and keeps their places if the record says it has no task', async ({ page }) => {
  test.setTimeout(120_000)
  // With a task: nothing moves, the three just start to act.
  await clampColumns(page, 340)
  await openViaFinder(page, SESSION_TITLE, SESSION_ID)
  let hold = await holdRecord(page, SESSION_ID)
  let reading = 'with task: no reading'
  try {
    // The column comes back from sessionStorage before any list has named its session.
    await page.reload()
    await clampColumns(page, 340)
    const panel = column(page, SESSION_ID)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => hold.held(), { message: 'the record is on its way' }).toBeGreaterThan(0)
    await settle(page)
    const fork = panel.getByRole('button', { name: 'Fork session into a child task' })
    await expect(fork).toBeDisabled()
    await expect(fork).toHaveAccessibleDescription(WAITING.fork!)
    await expect(panel.getByTestId('session-board-chip')).toBeDisabled()
    await expect(panel.getByTestId('session-panel-locate')).toBeDisabled()
    const before = await rowBoxes(panel)
    hold.release()
    await expect(panel.locator('[data-header-id="fork"] button:enabled')).toBeAttached({ timeout: 15_000 })
    await expect(panel.locator('button[data-header-id="locate"]:enabled')).toBeAttached()
    await settle(page)
    const after = await rowBoxes(panel)
    reading = `with task 340px: ${shown(before)} -> ${shown(after)} moved ${JSON.stringify(moved(before, after))}`
    expect(moved(before, after), 'a session with a task: nothing moves when its record lands').toEqual([])
    await expect(panel.locator(SPACERS)).toHaveCount(0)
    await closeAllColumns(page)
  } finally {
    console.log(`RELOAD ${test.info().project.name} ${reading}`)
    await hold.dispose()
  }

  // No task: the places stay, and the click aimed at Files opens Files.
  await openViaFinder(page, TASKLESS.query, TASKLESS.id)
  hold = await holdRecord(page, TASKLESS.id)
  reading = 'no task: no reading'
  try {
    await page.reload()
    await clampColumns(page, 340)
    const panel = column(page, TASKLESS.id)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    reading = `no task 340px: ${await aimAtFilesAcrossNoTask(page, panel, `.main-page-session-column .session-panel[data-session-id="${TASKLESS.id}"]`, hold, 'reload, no task', '7-reload-taskless')}`
  } finally {
    console.log(`RELOAD ${test.info().project.name} ${reading}`)
    await hold.dispose()
  }
})

test('a deep link to a session with no task keeps the row still, by its full id and by a prefix', async ({ page }) => {
  test.setTimeout(120_000)
  // A prefix (what the UI shows) makes the panel adopt the full id once the record names it: the
  // column is replaced by a new panel, which must start from the places the first one drew.
  for (const ref of [TASKLESS.id, TASKLESS.id.slice(0, 8)]) {
    const label = ref === TASKLESS.id ? 'full id' : 'prefix'
    const hold = await holdRecord(page, ref)
    let reading = `${label}: no reading`
    try {
      // The deep link is a page load by nature; nothing on the new page has named the session.
      await page.goto(`/sessions?id=${ref}`)
      const panelSel = `.main-page-session-column .session-panel[data-session-id^="${ref}"]`
      const panel = page.locator(panelSel)
      await expect(panel).toBeVisible({ timeout: 20_000 })
      await clampColumns(page, 340)
      reading = `${label} 340px: ${await aimAtFilesAcrossNoTask(page, panel, panelSel, hold, `deep link (${label})`, ref === TASKLESS.id ? '8-deeplink-taskless' : undefined, ref !== TASKLESS.id)}`
      if (ref !== TASKLESS.id) await expect(panel, 'the column took the full id').toHaveAttribute('data-session-id', TASKLESS.id)
      await closeAllColumns(page)
    } finally {
      console.log(`DEEPLINK ${test.info().project.name} ${reading}`)
      await hold.dispose()
    }
  }
})

test('the first chat reference to a session with no task keeps the row still', async ({ page }) => {
  test.setTimeout(90_000)
  // The fixture session's chat gains a reference to the session with no task.
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/history`), async (route) => {
    try {
      const resp = await route.fetch()
      const body = JSON.stringify(await resp.json()).replace(
        'if you want the source.',
        `if you want the source. Compare <session-ref id=\\"${TASKLESS.id}\\" label=\\"Ref with no task\\"/>.`,
      )
      await route.fulfill({ response: resp, json: JSON.parse(body) })
    } catch { /* the page is gone */ }
  })
  await clampColumns(page, 340)
  const host = await openFromTaskRow(page)
  const ref = host.locator(`a.session-link[data-session-id="${TASKLESS.id}"]`).first()
  await expect(ref).toBeVisible({ timeout: 20_000 })
  const hold = await holdRecord(page, TASKLESS.id)
  let reading = 'no reading'
  try {
    await ref.click()
    const panelSel = `.main-page-session-column .session-panel[data-session-id="${TASKLESS.id}"]`
    const panel = page.locator(panelSel)
    await expect(panel).toBeVisible({ timeout: 20_000 })
    reading = await aimAtFilesAcrossNoTask(page, panel, panelSel, hold, 'chat reference, no task', '9-chatref-taskless')
  } finally {
    console.log(`CHATREF ${test.info().project.name} 340px: ${reading}`)
    await hold.dispose()
  }
})

test('a prefix chat reference to a session already open folds into its column and moves nothing there', async ({ page }) => {
  test.setTimeout(120_000)
  // The r3 gate's sequence (L-17). The chat names the session by the 8 characters the UI shows.
  const prefix = TASKLESS.id.slice(0, 8)
  await page.route(new RegExp(`/api/sessions/${SESSION_ID}/history`), async (route) => {
    try {
      const resp = await route.fetch()
      const body = JSON.stringify(await resp.json()).replace(
        'if you want the source.',
        `if you want the source. Compare <session-ref id=\\"${prefix}\\" label=\\"Ref by prefix\\"/>.`,
      )
      await route.fulfill({ response: resp, json: JSON.parse(body) })
    } catch { /* the page is gone */ }
  })
  await page.setViewportSize({ width: 1900, height: 900 })
  await clampColumns(page, 420)
  const host = await openFromTaskRow(page)
  const ref = host.locator(`a.session-link[data-session-id="${prefix}"]`).first()
  await expect(ref).toBeVisible({ timeout: 20_000 })
  // The full id, opened from the finder: known to have no task, so no Fork, Board or Locate, and no places.
  const openSel = `.main-page-session-column .session-panel[data-session-id="${TASKLESS.id}"]`
  const open = await openViaFinder(page, TASKLESS.query, TASKLESS.id)
  await expect(open.locator('.session-panel-badge', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
  await settle(page)
  await expectNoTaskControls(open, 'open from the finder')
  await page.mouse.move(0, 0)
  const before = await rowBoxes(open)
  const box = (await open.locator('button[data-header-id="files"]').boundingBox())!
  const trace = await traceRow(page, openSel)

  // The reference opens a column under the prefix, which waits with the three (nothing on the page
  // named the prefix), then adopts the full id and folds into the open column.
  const prefixPanel = page.locator(`.main-page-session-column .session-panel[data-session-id="${prefix}"]`)
  const hold = await holdRecord(page, prefix)
  let reading = 'no reading'
  try {
    await ref.click()
    await expect(prefixPanel).toBeVisible({ timeout: 20_000 })
    await expect(prefixPanel.getByRole('button', { name: 'Fork session into a child task' })).toBeDisabled()
    hold.release()
    await expect(prefixPanel).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator(openSel)).toHaveCount(1)
    await trace.mark()
    // The r3 hand-over showed at the open panel's next render: about 2.5 s later in Chromium, the
    // click on Files in WebKit.
    await page.waitForTimeout(3_000)
    await settle(page)
    const after = await rowBoxes(open)
    const seen = await trace.stop()
    reading = `${shown(before)} -> ${shown(after)} moved ${JSON.stringify(moved(before, after))} row ${JSON.stringify(seen)}`
    expect(moved(before, after), 'nothing on the open row moves').toEqual([])
    // The column slides while the prefix column comes and goes; once at rest, its row is as before.
    expect(rowLayoutChanges(seen.rest), 'the open row at rest is the same in every frame').toEqual([])
    // The frames after the fold were looked at (a check that skipped them all would prove nothing).
    // About 180 in 3 s on an idle machine; a loaded one draws fewer.
    expect(seen.restFramesAfterMark, 'frames at rest after the fold').toBeGreaterThanOrEqual(5)
    await expectNoTaskControls(open, 'after the fold')
    await shootHeader(page, open, '11-prefix-folded')

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(open.locator('.session-action-chip-active'), 'the click aimed at Files opens Files').toHaveText(['Files'])
    // Closing Files renders the panel again: still nothing drawn for the three, nothing moved.
    await open.locator('.session-meta-row-2 .session-action-chip-active').click()
    await expect(open.locator('.session-action-chip-active')).toHaveCount(0)
    await settle(page)
    await page.mouse.move(0, 0)
    await expectNoTaskControls(open, 'after Files')
    expect(moved(before, await rowBoxes(open)), 'nothing moved after Files').toEqual([])
  } finally {
    console.log(`PREFIXFOLD ${test.info().project.name} 420px: ${reading}`)
    await hold.dispose()
  }

  // Closed and opened again from the finder: a fresh panel for a session known to have no task.
  await closeAllColumns(page)
  const again = await openViaFinder(page, TASKLESS.query, TASKLESS.id)
  await expect(again.locator('.session-panel-badge', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
  await settle(page)
  await expectNoTaskControls(again, 'reopened from the finder')
  await shootHeader(page, again, '12-prefix-reopened')
})

test('a task deleted while its session is open: Fork, Board and Locate stop acting and keep their places', async ({ page }) => {
  test.setTimeout(150_000)
  // 340 px folds Locate into "..."; 760 px keeps it on the row, where its spacer must sit where it was.
  for (const px of [340, 760]) {
    const seeded = await seedTaskSession(page, `open ${px}`)
    await clampColumns(page, px)
    const panel = await openSeededFromTaskRow(page, seeded)
    await expect(panel.locator('[data-header-id="fork"] button:enabled')).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByTestId('session-board-chip')).toBeEnabled()
    await expect(panel.locator('button[data-header-id="locate"]:enabled')).toBeAttached()
    await settle(page)
    await page.mouse.move(0, 0)
    const before = await rowBoxes(panel)
    const box = (await panel.locator('button[data-header-id="files"]').boundingBox())!
    const revision = ((await (await page.request.get(`/api/sessions/${seeded.sid}`)).json()) as { session: { statusRevision: number } }).session.statusRevision
    const stop = await traceFiles(page, `.main-page-session-column .session-panel[data-session-id="${seeded.sid}"]`)

    // Anything the page writes to the deleted task (it answers 500 and raises an error card).
    const writes: string[] = []
    const onRequest = (req: import('@playwright/test').Request) => {
      if (req.method() !== 'GET' && new URL(req.url()).pathname.startsWith(`/api/tasks/${seeded.taskId}`)) writes.push(`${req.method()} ${req.postData() ?? ''}`)
    }
    page.on('request', onRequest)

    // Deleted elsewhere (another window, an agent): the page hears it only from the server.
    const del = await page.request.delete(`/api/tasks/${seeded.taskId}?force=true`)
    expect(del.status(), await del.text()).toBe(204)
    await expect(panel.locator(TASK_CONTROLS), 'the session has no task now, and the open panel hears it').toHaveCount(0, { timeout: 15_000 })
    await settle(page)
    const after = await rowBoxes(panel)
    const seen = await stop()
    console.log(`DELETED ${test.info().project.name} ${px}px: ${shown(before)} -> ${shown(after)} moved ${JSON.stringify(moved(before, after))} files-frames ${JSON.stringify(seen)}`)
    expect(moved(before, after), `${px}px: nothing on the row moves`).toEqual([])
    expect(seen).toEqual([`${before.files!.x},${before.files!.y} w${before.files!.w} h${before.files!.h}`])
    // At 760 px all three were on the row: each spacer has its control's box (moved() compares them).
    if (px === 760) expect(Object.keys(before), 'Fork, Board and Locate on the row').toEqual(expect.arrayContaining(['fork', 'board', 'locate']))
    await expectSpacers(page, panel, `task deleted, ${px}px`)
    await shootHeader(page, panel, px === 340 ? '10-task-deleted' : '10-task-deleted-760')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(panel.locator('.session-action-chip-active')).toHaveText(['Files'])
    // A click in the panel marks its task read: never the deleted one (until 2026-10-11 the panel kept
    // its fetched copy of the task and sent it a write on every click).
    await page.waitForTimeout(500)
    page.off('request', onRequest)
    expect(writes, `${px}px: nothing is written to the deleted task`).toEqual([])

    // The server's record says the same, under a newer status revision.
    const record = ((await (await page.request.get(`/api/sessions/${seeded.sid}`)).json()) as { session: { taskId?: string | null; statusRevision: number } }).session
    expect(record.taskId ?? null).toBeNull()
    expect(record.statusRevision).toBeGreaterThan(revision)
    await closeAllColumns(page)
  }
})

test('a record that left the server before the task was deleted cannot bring its controls back', async ({ page }) => {
  test.setTimeout(90_000)
  const seeded = await seedTaskSession(page, 'stale')
  // The record as the server sent it before the delete: an older status revision, naming the task.
  const stale = await (await page.request.get(`/api/sessions/${seeded.sid}`)).json() as { session: { taskId: string; statusRevision: number } }
  expect(stale.session.taskId).toBe(seeded.taskId)
  let answer!: () => void
  const gate = new Promise<void>((resolve) => { answer = resolve })
  let held = 0
  const url = new RegExp(`/api/sessions/${seeded.sid}(\\?|$)`)
  await page.route(url, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    held++
    await gate
    await route.fulfill({ json: stale }).catch(() => undefined)
  })
  try {
    const panel = await openSeededFromTaskRow(page, seeded)
    await expect.poll(() => held, { message: 'the record is on its way' }).toBeGreaterThan(0)
    // The task list named the task: the three wait, disabled.
    await expect(panel.locator('[data-header-id="fork"] button')).toBeDisabled()
    await settle(page)
    await page.mouse.move(0, 0)
    const before = await rowBoxes(panel)

    const del = await page.request.delete(`/api/tasks/${seeded.taskId}?force=true`)
    expect(del.status(), await del.text()).toBe(204)
    // The page hears the delete (a newer revision, no task) while the record is still on its way.
    await expect(panel.locator(TASK_CONTROLS)).toHaveCount(0, { timeout: 15_000 })
    // Then the record lands, older and naming the deleted task: the newer status still decides.
    answer()
    await expect(panel.locator('.session-panel-badge', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
    await settle(page)
    await expect(panel.locator(TASK_CONTROLS), 'the stale record does not bring Fork, Board or Locate back').toHaveCount(0)
    const after = await rowBoxes(panel)
    console.log(`STALE ${test.info().project.name}: ${shown(before)} -> ${shown(after)} moved ${JSON.stringify(moved(before, after))}`)
    expect(moved(before, after)).toEqual([])
    await expectSpacers(page, panel, 'stale record after the delete')
    await closeAllColumns(page)
  } finally {
    answer()
    await page.unroute(url).catch(() => undefined)
  }
})

test('a task deleted while the socket was down is caught up when it comes back, in place', async ({ page }) => {
  test.setTimeout(90_000)
  const seeded = await seedTaskSession(page, 'outage')
  // The page's socket goes through the test, which can drop what the server sends and cut the line.
  const sockets: WebSocketRoute[] = []
  let outage = false
  await page.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((message) => { if (!outage) ws.send(message) })
    ws.onMessage((message) => server.send(message))
    sockets.push(ws)
  })
  await page.reload()
  await page.waitForLoadState('networkidle')
  expect(sockets.length, 'the page socket runs through the test').toBeGreaterThan(0)
  const panel = await openSeededFromTaskRow(page, seeded)
  await expect(panel.locator('[data-header-id="fork"] button:enabled')).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('button[data-header-id="locate"]:enabled')).toBeAttached()
  await settle(page)
  await page.mouse.move(0, 0)
  const before = await rowBoxes(panel)

  // The outage: the server's events stop reaching the page, and the task is deleted meanwhile.
  outage = true
  const del = await page.request.delete(`/api/tasks/${seeded.taskId}?force=true`)
  expect(del.status(), await del.text()).toBe(204)
  await page.waitForTimeout(1_500)
  await expect(panel.locator(TASK_CONTROLS), 'the page has not heard of the delete').toHaveCount(3)

  // The line drops and the socket reconnects: the panel asks for its record again.
  const reread = page.waitForResponse((res) => new URL(res.url()).pathname === `/api/sessions/${seeded.sid}` && res.request().method() === 'GET', { timeout: 20_000 })
  outage = false
  await sockets.at(-1)!.close()
  await reread
  await expect(panel.locator(TASK_CONTROLS), 'caught up after the reconnect').toHaveCount(0, { timeout: 15_000 })
  await settle(page)
  const after = await rowBoxes(panel)
  console.log(`OUTAGE ${test.info().project.name}: sockets ${sockets.length} | ${shown(before)} -> ${shown(after)} moved ${JSON.stringify(moved(before, after))}`)
  expect(sockets.length, 'the page opened a new socket').toBeGreaterThan(1)
  expect(moved(before, after), 'nothing on the row moves').toEqual([])
  await expectSpacers(page, panel, 'caught up after an outage')
  await closeAllColumns(page)
})
