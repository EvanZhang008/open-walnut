/**
 * A Threads list never moves what he reads while he is at it (web/src/components/org/useThreadsHold.ts;
 * 2026-11-23, the user: "keep this location from changing, or it keeps flashing"; 2026-11-25, again:
 * a new card above "still pushes my page out").
 *
 * The whole matrix, on both surfaces with his Threads flags on: the session's Threads pane (the
 * plain list) and the Org page's rail of a lead (the groups, brief_off). Each cell is
 *
 *   where he is scrolled     the very top / a little down / the middle / the end
 *   × where he is            pointer on a card / pointer on a fold's head below every card / pointer
 *                            between cards (a group's head between groups, a gap) / typing in a card's
 *                            Follow up box (pointer away) / away
 *   × what changes above     every entry of CHANGES (a new card in a group above, in his card's own
 *                            group, in Watching; a card above grows, leaves, moves to another group;
 *                            a folded group above gets its first card; a move line shows or fades;
 *                            the list read again after a reconnect; the card he reads itself moves to
 *                            another group, as a Needs you card he answers does)
 *
 * and passes when the card he reads (the one under the pointer, the one right above it below every
 * card, the one right below it between cards, the one he types in, or, away, the one at the top of
 * the view; when that card itself moves away, the card that stood right before it, else right after
 * it) stays where it was on screen to under 1 px in EVERY frame of the
 * change (sampled after each frame's paint, so a move put back a frame later still fails), and the
 * box he types in keeps the focus and the caret. Away at the very top nothing is held (new cards
 * show at the top, as before): those cells are recorded, not judged. What stands above got shorter
 * than the box can scroll up (a card above leaving near the top): the box keeps room at its top while
 * he is at the list, so those cells are judged too. A change with a `leave` check judges his leaving
 * as well: begun at the very top, the list goes back to the top and what arrived shows; elsewhere
 * nothing on screen moves.
 *
 * A new kind of change above a card is one more entry of CHANGES (threads-hold-changes.ts, with the
 * writes that make each change), and so a new column of cells; the page probes (which card he reads,
 * the card's top in every frame) are in threads-hold-page.ts.
 * The table is written to $WALNUT_TASK_DIR/hold-matrix-<surface>-<engine>.json and the log.
 * Run in WebKit too (no CSS scroll anchoring there): `walnut-dev webkit tests/e2e/browser/threads-hold-matrix.spec.ts`.
 *
 * Every run takes the cells of what he reported (inRun: at the list at the very top, the pointer on
 * a card in the middle, the pointer on a folded group's head under the cards at the end, and on a
 * group's head at the top and a little down), about four minutes; THREADS_HOLD_MATRIX=1 runs the whole matrix,
 * about six minutes a browser, after any change to the hold, the anchor or what a Threads list
 * draws (tests/web/threads-hold.test.ts fails when the list draws something the matrix has no
 * column for). The flags are the server's own and other Threads specs put theirs back while this
 * one runs, so the page reads his flags whatever the server says meanwhile (pinHisFlags).
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { CHANGES, STAMP, call, nodeThread, patchThread, sel, selRef, toOtherGroup, type Change, type Ctx, type Node } from './threads-hold-changes'
import { keepSocket, pickReading, setPosition, settled, startSampling, stopSampling, typingState, type Pos, type Presence } from './threads-hold-page'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'
import { pinPageFlags } from './page-flags'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const PROJECT = `Orchard hold ${STAMP}`
const OUT = process.env.WALNUT_TASK_DIR ?? 'test-results'
/** His Threads flags (the view he uses: the groups on the Org page, the one card, Watching, ...). */
const HIS_FLAGS = ['task_threads', 'threads_pop_up', 'letters_as_threads', 'top_thread', 'reply_thread_line', 'ack_means_known', 'threads_one_card', 'brief_off', 'org_leaders', 'quiet_rail', 'topics'] as const
const made: string[] = []
const ids = { task: '', sid: '', lead: '', leadSid: '' }
/**
 * The ones the server itself reads for what this spec writes (a task's threads, his Acknowledge);
 * the rest only choose what the page draws, and the page reads them pinned (pinHisFlags), so they
 * are never set on the server: putting them back at the end changed the view under another Threads
 * spec still running (the groups left thread-groups-folds' rail). Not ack_means_known: on the server
 * for this whole run, it made thread-groups-folds' Closed card land in Acknowledged; his Acknowledge
 * here (the cleanups) leaves no line either way.
 */
const SERVER_FLAGS = ['task_threads', 'letters_as_threads', 'reply_thread_line', 'org_leaders']
let flagsWere: Record<string, boolean> = {}

// One worker: the flags are the server's own, set for the whole file and put back at its end.
test.describe.configure({ mode: 'serial' })
test.setTimeout(45 * 60_000)
test.use({ viewport: { width: 1280, height: 1000 } })

const POSITIONS: Pos[] = ['top', 'little', 'middle', 'end']
const PRESENCES: Presence[] = ['pointer', 'head', 'gap', 'typing', 'away']
/**
 * The whole matrix, or in every run the cells of what he reported: at the list at the very top, the
 * pointer on a card in the middle, (2026-11-25, a review) the pointer on a folded group's head under
 * the cards at the end, where the list itself was held and a new card above pushed everything, and
 * (2026-11-25, the next review) the pointer on a group's head at the top and a little down: a
 * card above changing group was read there to push his card 186px, which was his own card changing
 * group (the pointer had come to rest on it), now its own column.
 */
const WHOLE = !!process.env.THREADS_HOLD_MATRIX
const inRun = (pos: Pos, presence: Presence) => WHOLE || (pos === 'top' ? presence === 'pointer' || presence === 'typing' || presence === 'gap' : pos === 'little' ? presence === 'gap' : pos === 'middle' ? presence === 'pointer' : pos === 'end' && presence === 'head')

interface Cell { surface: string; pos: Pos; presence: Presence; change: string; verdict: 'PASS' | 'FAIL' | 'INFO' | 'NA'; maxDev: number; final: number; frames: number; focus?: boolean; caret?: boolean; note?: string; scroll?: string; reading?: string }

const inputOf = (box: string, id: string) => `${sel(box, id)} [data-testid="org-thread-follow-input"]`
async function runCell(page: Page, request: APIRequestContext, surface: 'pane' | 'rail', node: Node, box: string, pos: Pos, presence: Presence, ch: Change): Promise<Cell> {
  const cell: Cell = { surface, pos, presence, change: ch.name, verdict: 'NA', maxDev: 0, final: 0, frames: 0 }
  if (ch.scrolledOnly && pos === 'top') return { ...cell, note: 'nothing of the kind stands above a card at the very top' }
  if (ch.self && (presence === 'typing' || presence === 'away')) return { ...cell, note: 'his own card moving is judged where he reads by the pointer' }
  await page.mouse.move(5, 5)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.waitForTimeout(250)
  // A move line from the last cell fades first (its own cell judges that): fading after the point
  // was picked, it moved the list under it, and the pointer rested on another card than the cell names.
  if (ch.name !== 'its move line fades') await expect(page.locator(`${box} [data-testid="org-thread-move-note"]`)).toHaveCount(0, { timeout: 10_000 })
  // The last cell's cleanup drawn (a grown card short again) before the point is picked, for the same reason.
  await settled(page, box)
  await setPosition(page, box, pos)
  const r = await pickReading(page, { box, presence, group: ch.readIn ?? (surface === 'rail' ? 'read' : null), scope: null })
  if (!r || (ch.target && !r.above) || (ch.self && !r.stand)) return { ...cell, note: 'no card to read here with a card above it' }
  const ctx: Ctx = ch.self ? { page, request, node, target: r.id, targetGroup: r.group, box } : { page, request, node, target: r.above, targetGroup: r.aboveGroup, box }
  const card = page.locator(sel(box, r.id))
  // The card judged: the one he reads, or, when that one moves away, the place he read it.
  const judgedCard = ch.self ? page.locator(selRef(box, r.stand!)) : card
  const input = inputOf(box, r.id)
  if (presence === 'pointer') {
    const b = (await card.boundingBox())!
    await page.mouse.move(b.x + 6, b.y + Math.min(48, b.height / 2), { steps: 4 })
  } else if (r.at) {
    await page.mouse.move(r.at.x, r.at.y, { steps: 4 })
    // The cell is about a pointer off the cards: one that came to rest on a card tests another cell.
    const on = await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('[data-testid="org-thread"]'), r.at)
    if (on) return { ...cell, verdict: 'FAIL', note: 'the pointer came to rest on a card, not off them' }
  } else if (presence === 'typing') {
    await page.evaluate((s) => document.querySelector<HTMLElement>(s)?.focus({ preventScroll: true }), input)
    // Keys typed anywhere else would be the page's shortcuts.
    if (!(await typingState(page, input)).focus) return { ...cell, note: 'its Follow up box did not take the focus' }
    await page.keyboard.type('net it', { delay: 5 })
    await page.evaluate((s) => { const el = document.querySelector<HTMLTextAreaElement>(s); el?.setSelectionRange?.(3, 3) }, input)
  }
  if (ch.name === 'its move line fades') {
    // Its line first, untimed: a card above leaves for a fold.
    await patchThread(ctx, r.above!, { state: 'pending' })
    await expect(page.locator(`${box} [data-testid="org-thread-move-note"][data-moved-id="${r.above}"]`)).toHaveCount(1, { timeout: 15_000 })
  }
  await page.waitForTimeout(300)
  const before = presence === 'typing' ? await typingState(page, input) : null
  const startTop = await page.evaluate((b) => document.querySelector<HTMLElement>(b)!.scrollTop, box)
  const y0 = (await judgedCard.boundingBox())!.y
  await startSampling(page, box, ch.self ? selRef(box, r.stand!) : sel(box, r.id))
  const run = await ch.run(ctx)
  await expect.poll(run.done, { timeout: 20_000, message: `${surface} ${pos} ${presence}: ${ch.name}` }).toBe(true)
  await page.waitForTimeout(600)
  const ys = await stopSampling(page)
  const yEnd = (await judgedCard.boundingBox())?.y ?? NaN
  const after = presence === 'typing' ? await typingState(page, input) : null
  const endTop = await page.evaluate((b) => document.querySelector<HTMLElement>(b)!.scrollTop, box)
  const devs = [...ys, yEnd].map((y) => (Number.isNaN(y) ? Infinity : y - y0))
  const worst = devs.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0)
  cell.maxDev = Math.round(worst * 10) / 10
  cell.final = Math.round((yEnd - y0) * 10) / 10
  cell.frames = ys.length
  if (before && after) { cell.focus = after.focus; cell.caret = after.caret === before.caret }
  const held = Math.abs(worst) < 1 && (!after || (after.focus && cell.caret))
  cell.verdict = presence === 'away' && pos === 'top' ? 'INFO' : held ? 'PASS' : 'FAIL'
  cell.scroll = `${startTop}->${endTop}`
  if (run.leave && presence !== 'away') {
    // He leaves: the pointer goes, the box he typed in is left.
    const y1 = (await card.boundingBox())?.y ?? NaN
    await page.mouse.move(5, 5)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
    await page.waitForTimeout(500)
    const wrong = await run.leave({ pos, y0: y1 })
    // Begun elsewhere, his leaving moves nothing on screen.
    const moved = pos === 'top' ? null : Math.abs(((await card.boundingBox())?.y ?? NaN) - y1)
    const fail = wrong ?? (moved !== null && !(moved < 1) ? `the card moved ${Math.round(moved)}px when he left` : null)
    if (fail) { cell.verdict = 'FAIL'; cell.note = fail }
  }
  cell.reading = `${r.id}${r.above ? ` under ${r.above} (${r.aboveGroup})` : ''}${ch.self ? `, judged ${r.stand!.id}` : ''}`
  await page.mouse.move(5, 5)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await run.cleanup?.()
  return cell
}

async function runMatrix(page: Page, request: APIRequestContext, surface: 'pane' | 'rail', node: Node, box: string): Promise<Cell[]> {
  const cells: Cell[] = []
  for (const ch of CHANGES.filter((c) => c.on.includes(surface))) {
    if (ch.readIn) {
      // His card is in that opened fold.
      const head = page.locator(`${box} [data-testid="org-thread-group"][data-group="${ch.readIn}"] [data-testid="org-thread-group-head"]`)
      if ((await head.getAttribute('aria-expanded')) === 'false') await head.click()
      await page.waitForTimeout(800)
    }
    for (const pos of POSITIONS) {
      for (const presence of PRESENCES) {
        if (!inRun(pos, presence) || (!WHOLE && ch.self && pos === 'end')) continue
        const c = await runCell(page, request, surface, node, box, pos, presence, ch)
        console.log(`[cell] ${surface} ${c.verdict} ${pos} ${presence} ${ch.name}: dev ${c.maxDev} scroll ${c.scroll ?? ''} ${c.reading ?? ''} ${c.note ?? ''}`)
        cells.push(c)
      }
    }
  }
  const engine = test.info().project.name
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(`${OUT}/hold-matrix-${surface}-${engine}${process.env.MATRIX_LABEL ? `-${process.env.MATRIX_LABEL}` : ''}.json`, JSON.stringify(cells, null, 1))
  console.log(`\n${surface} (${engine})\n${cells.map((c) => `${c.verdict.padEnd(5)} ${c.pos.padEnd(6)} ${c.presence.padEnd(7)} ${c.change.padEnd(42)} dev ${c.maxDev} end ${c.final} scroll ${c.scroll ?? ''}${c.focus === false ? ' FOCUS LOST' : ''}${c.caret === false ? ' CARET MOVED' : ''}${c.note ? ` (${c.note})` : ''}`).join('\n')}`)
  return cells
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(400_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  flagsWere = Object.fromEntries(SERVER_FLAGS.map((f) => [f, cfg.config?.experimental?.[f] === true]))
  const on = await request.put('/api/config', { data: { experimental: Object.fromEntries(SERVER_FLAGS.map((f) => [f, true])) } })
  expect(on.ok(), await on.text()).toBe(true)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  // The session pane: a task with Threads on.
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Garden ${STAMP}`, project: PROJECT, source: 'local' })
  made.push(task.id)
  ids.task = task.id
  await call(request, 'patch', `/api/tasks/${task.id}`, { threads_on: true })
  await call(request, 'post', '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: task.id })
  await expect.poll(async () => (ids.sid = (await (await request.get(`/api/tasks/${task.id}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  // The rail: a lead (a project with two teams) with Needs you, a long Done, and Waiting.
  made.push((await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Prune the pears ${STAMP}`, project: PROJECT, source: 'local' })).task.id)
  ids.lead = (await call<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  await call(request, 'post', '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  const pane = { task: ids.task, sid: ids.sid }
  const lead = { task: ids.lead, sid: ids.leadSid }
  for (let i = 0; i < 14; i++) await nodeThread(request, pane)
  for (let i = 0; i < 2; i++) await nodeThread(request, lead, 'needs')
  for (let i = 0; i < 14; i++) await nodeThread(request, lead)
  for (let i = 0; i < 4; i++) { const id = await nodeThread(request, lead); await call(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${id}`, { state: 'pending' }, ids.leadSid) }
})

test.afterAll(async ({ request }) => {
  await request.put('/api/config', { data: { experimental: flagsWere } })
  for (const id of [...made].reverse()) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

/** His flags as this page reads them, whatever the server says meanwhile (page-flags.ts). */
const pinHisFlags = (page: Page) => pinPageFlags(page, HIS_FLAGS)

/** The list is drawn once it holds this many of the 14 seeded cards: the matrix run before the proof moves a card or two out of Done. */
const LIST_MIN = 10

async function openPane(page: Page): Promise<string> {
  await seedColumns(page, [ids.sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`)
  const chip = panel.getByTestId('session-threads-chip')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click()
  await expect.poll(() => panel.getByTestId('session-threads-pane').locator('[data-testid="org-thread"]').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(LIST_MIN)
  return `.main-page-session-column .session-panel[data-session-id="${ids.sid}"] .session-threads-body`
}

async function openRail(page: Page): Promise<string> {
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.trim().toLowerCase()}"]`).click()
  await expect(page.getByTestId('org-detail').getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await expect(page.getByTestId('org-thread-groups')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-testid="org-thread-group"][data-group="read"] [data-testid="org-thread"]').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(LIST_MIN)
  return '[data-testid="org-rail"] .org-rail-body:has(> .org-threads)'
}

const judged = (cells: Cell[]) => cells.filter((c) => c.verdict === 'FAIL').map((c) => `${c.surface} / ${c.pos} / ${c.presence} / ${c.change}: moved ${c.maxDev}px${c.focus === false ? ', focus lost' : ''}${c.caret === false ? ', caret moved' : ''}${c.note ? `, ${c.note}` : ''}`)

// Both surfaces in one test, judged together at the end: a surface that fails still lets the other run.
test('nothing above the card he reads moves it, in the session pane and the Org rail', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await pinHisFlags(page)
  await keepSocket(page)
  const all: Cell[] = []
  for (const surface of ['pane', 'rail'] as const) {
    const box = surface === 'pane' ? await openPane(page) : await openRail(page)
    expect(await page.evaluate((b) => { const el = document.querySelector<HTMLElement>(b)!; return el.scrollHeight > el.clientHeight * 2 }, box), `${surface}: the list scrolls`).toBe(true)
    const node = surface === 'pane' ? { task: ids.task, sid: ids.sid } : { task: ids.lead, sid: ids.leadSid }
    const cells = await runMatrix(page, request, surface, node, box)
    expect(cells.filter((c) => c.verdict === 'PASS').length, `${surface}: the matrix ran`).toBeGreaterThan(10)
    all.push(...cells)
  }
  expect(judged(all)).toEqual([])
  expect(pageErrors).toEqual([])
})

/** The reported case, in every run: a new card arrives above while he reads at the very top, then while he types; nothing moves. */
test('a new card above does not move the card he reads at the very top, or the box he types in', async ({ page, request }) => {
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await pinHisFlags(page)
  const box = await openRail(page)
  const lead = { task: ids.lead, sid: ids.leadSid }
  await page.evaluate((b) => { document.querySelector<HTMLElement>(b)!.scrollTop = 0 }, box)
  const r = (await pickReading(page, { box, presence: 'pointer', group: 'read', scope: null }))!
  const card = page.locator(sel(box, r.id))
  const b = (await card.boundingBox())!
  await page.mouse.move(b.x + 6, b.y + 40, { steps: 8 })
  await video.caption('At the very top, reading a Done card with the pointer on it')
  await video.hold(1500)
  const y0 = (await card.boundingBox())!.y
  const fresh = await nodeThread(request, lead, 'needs')
  await expect(page.locator(sel(box, fresh))).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(400)
  expect(Math.abs((await card.boundingBox())!.y - y0)).toBeLessThan(1)
  await video.caption('A new card arrived in Needs you above it: the card he reads did not move')
  await video.hold(2500)
  // Typing in its Follow up box, the pointer away.
  await page.mouse.move(5, 5, { steps: 8 })
  const input = page.locator(inputOf(box, r.id))
  await input.focus()
  await page.keyboard.type('Net it in May', { delay: 40 })
  await video.caption('Typing a follow-up, the pointer away from the list')
  await video.hold(1200)
  const y1 = (await card.boundingBox())!.y
  const another = await nodeThread(request, lead, 'needs')
  await expect(page.locator(sel(box, another))).toHaveCount(1, { timeout: 15_000 })
  await page.keyboard.type(' please', { delay: 40 })
  expect(Math.abs((await card.boundingBox())!.y - y1)).toBeLessThan(1)
  await expect(input).toBeFocused()
  await video.caption('Another card arrived above: the box did not move and kept every key')
  await video.hold(2500)
  await video.stop('threads-hold-matrix-new-card-above')
})

/** The pointer on a Done card that has a card above it, the list at the very top. */
async function readAtTop(page: Page, box: string) {
  await page.mouse.move(5, 5)
  await page.evaluate((b) => { document.querySelector<HTMLElement>(b)!.scrollTop = 0 }, box)
  await page.waitForTimeout(300)
  const r = (await pickReading(page, { box, presence: 'pointer', group: 'read', scope: null }))!
  const card = page.locator(sel(box, r.id))
  const b = (await card.boundingBox())!
  await page.mouse.move(b.x + 6, b.y + 40, { steps: 8 })
  return { r, card }
}

/** No scroll can hold this one: the box keeps room at its top while he reads, and lets it go when he leaves. */
test('a card above leaving while he reads near the top does not move his card', async ({ page, request }) => {
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await pinHisFlags(page)
  const box = await openRail(page)
  const lead = { task: ids.lead, sid: ids.leadSid }
  const { r, card } = await readAtTop(page, box)
  await video.caption('Near the top, reading a Done card with the pointer on it')
  await video.hold(1500)
  const y0 = (await card.boundingBox())!.y
  await call(request, 'patch', `/api/v1/tasks/${lead.task}/threads/${r.above}`, { state: 'pending' }, lead.sid)
  await expect(page.locator(sel(box, r.above!))).toHaveCount(0, { timeout: 15_000 })
  await page.waitForTimeout(400)
  expect(Math.abs((await card.boundingBox())!.y - y0)).toBeLessThan(1)
  await video.caption('The card above it left: his card did not move (the list keeps the room at its top)')
  await video.hold(2500)
  await page.mouse.move(5, 5, { steps: 8 })
  await page.waitForTimeout(400)
  expect(await page.evaluate((b) => document.querySelector<HTMLElement>(b)!.style.paddingTop, box)).toBe('')
  await video.caption('He left the list: the room goes')
  await video.hold(1500)
  await video.stop('threads-hold-card-above-leaves')
})

/** Held out of view above while he read at the very top, the new card shows once he leaves. */
test('a new card that came above while he read at the very top shows once he leaves', async ({ page, request }) => {
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await pinHisFlags(page)
  const box = await openRail(page)
  const lead = { task: ids.lead, sid: ids.leadSid }
  const { card } = await readAtTop(page, box)
  await video.caption('At the very top, reading a Done card with the pointer on it')
  await video.hold(1500)
  const y0 = (await card.boundingBox())!.y
  const fresh = await nodeThread(request, lead, 'needs')
  await expect(page.locator(sel(box, fresh))).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(400)
  expect(Math.abs((await card.boundingBox())!.y - y0)).toBeLessThan(1)
  await video.caption('A new card came in Needs you: his card held still, the new one is above the view')
  await video.hold(2000)
  await page.mouse.move(5, 5, { steps: 8 })
  await expect.poll(() => page.evaluate((b) => document.querySelector<HTMLElement>(b)!.scrollTop, box)).toBe(0)
  await expect(page.locator(sel(box, fresh))).toBeInViewport()
  await video.caption('He left the list: it went back to the top, and the new card shows')
  await video.hold(2500)
  await video.stop('threads-hold-new-card-shows-after')
})

/** The pointer away, every move line faded and the list drawn, then at `pos`: a clean start for each step of a proof. */
async function freshAt(page: Page, box: string, pos: Pos) {
  await page.mouse.move(5, 5, { steps: 6 })
  await expect(page.locator(`${box} [data-testid="org-thread-move-note"]`)).toHaveCount(0, { timeout: 15_000 })
  await settled(page, box)
  await setPosition(page, box, pos)
}

/**
 * 2026-11-25, the review's item a: the pointer resting off the cards (a group's head) while a card
 * above changes group, and the pointer on a Needs you card he answers, which goes to Done; then the
 * earlier report, the pointer on a folded group's head under every card while a new card arrives.
 */
test('a card changing group, or a new one, moves nothing he sees while the pointer rests on a group head', async ({ page, request }) => {
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await pinHisFlags(page)
  const box = await openRail(page)
  const lead = { task: ids.lead, sid: ids.leadSid }
  const ctx = (target: string, targetGroup: string | null): Ctx => ({ page, request, node: lead, target, targetGroup, box })
  const still = async (s: string, y0: number) => expect(Math.abs((await page.locator(s).boundingBox())!.y - y0)).toBeLessThan(1)

  // The pointer on the head of Done, a Needs you card right above it: the list scrolled so that head
  // stands at 40% of the view (Needs you can be taller than the view after the matrix ran).
  await freshAt(page, box, 'top')
  await page.evaluate((b) => {
    const el = document.querySelector<HTMLElement>(b)!
    const head = el.querySelector('[data-testid="org-thread-group"][data-group="read"] [data-testid="org-thread-group-head"]')!
    el.scrollTop += head.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight * 0.4
  }, box)
  await settled(page, box)
  const a = (await pickReading(page, { box, presence: 'gap', group: null, scope: null }))!
  expect(a.aboveGroup).toBe('needs')
  await page.mouse.move(a.at!.x, a.at!.y, { steps: 10 })
  // The pointer rests on Done's own head, no card and no other line.
  expect(await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('[data-testid="org-thread-group"]')?.dataset.group === 'read' && !!document.elementFromPoint(p.x, p.y)?.closest('[data-testid="org-thread-group-head"]'), a.at!)).toBe(true)
  await video.caption('The pointer rests on the head of Done, under a Needs you card')
  await video.hold(1500)
  const ya = (await page.locator(sel(box, a.id)).boundingBox())!.y
  const moved = await toOtherGroup(ctx(a.above!, 'needs'))
  await expect.poll(moved.done, { timeout: 20_000 }).toBe(true)
  await page.waitForTimeout(600)
  await still(sel(box, a.id), ya)
  await video.caption('That card went to Done, right under the head: the card he reads did not move')
  await video.hold(2500)
  await moved.cleanup!()

  // The pointer on a Needs you card he answers: it goes to Done, the card before it keeps his place.
  await freshAt(page, box, 'top')
  const b = (await pickReading(page, { box, presence: 'pointer', group: 'needs', scope: null }))!
  expect(b.group).toBe('needs')
  const bb = (await page.locator(sel(box, b.id)).boundingBox())!
  await page.mouse.move(bb.x + 6, bb.y + Math.min(48, bb.height / 2), { steps: 10 })
  await video.caption('The pointer on a Needs you card, which he answers')
  await video.hold(1500)
  const yb = (await page.locator(selRef(box, b.stand!)).boundingBox())!.y
  const answered = await toOtherGroup(ctx(b.id, 'needs'))
  await expect.poll(answered.done, { timeout: 20_000 }).toBe(true)
  await page.waitForTimeout(600)
  await still(selRef(box, b.stand!), yb)
  await video.caption('It went to Done and left its line in its place: the cards above did not move')
  await video.hold(2500)
  await answered.cleanup!()

  // The earlier report: at the end, the pointer on a folded group's head under every card.
  await freshAt(page, box, 'end')
  const c = (await pickReading(page, { box, presence: 'head', group: null, scope: null }))!
  await page.mouse.move(c.at!.x, c.at!.y, { steps: 10 })
  await video.caption('At the end, the pointer on a folded group\'s head under every card')
  await video.hold(1500)
  const yc = (await page.locator(sel(box, c.id)).boundingBox())!.y
  const fresh = await nodeThread(request, lead, 'needs')
  await expect(page.locator(sel(box, fresh))).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(600)
  await still(sel(box, c.id), yc)
  await video.caption('A new card arrived in Needs you above: nothing he sees moved')
  await video.hold(2500)
  await video.stop('threads-hold-group-head')
})
