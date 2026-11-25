/**
 * A Threads list never moves what he reads while he is at it (web/src/components/org/useThreadsHold.ts;
 * 2026-11-23, the user: "keep this location from changing, or it keeps flashing"; 2026-11-25, again:
 * a new card above "still pushes my page out").
 *
 * The whole matrix, on both surfaces with his Threads flags on: the session's Threads pane (the
 * plain list) and the Org page's rail of a lead (the groups, brief_off). Each cell is
 *
 *   where he is scrolled     the very top / a little down / the middle
 *   × where he is            pointer on a card / typing in a card's Follow up box (pointer away) / away
 *   × what changes above     every entry of CHANGES (a new card in a group above, in his card's own
 *                            group, in Watching; a card above grows, leaves, moves to another group;
 *                            a folded group above gets its first card; a move line shows or fades;
 *                            the list read again after a reconnect)
 *
 * and passes when the card he reads (the one under the pointer, the one he types in, or, away, the
 * one at the top of the view) stays where it was on screen to under 1 px in EVERY frame of the
 * change (sampled after each frame's paint, so a move put back a frame later still fails), and the
 * box he types in keeps the focus and the caret. Away at the very top nothing is held (new cards
 * show at the top, as before): those cells are recorded, not judged. A cell where the content above
 * got shorter than the room the box has to scroll up is LIMIT (no scroll can hold it).
 *
 * A new kind of change above a card is one more entry of CHANGES, and so a new column of cells.
 * The table is written to $WALNUT_TASK_DIR/hold-matrix-<surface>-<engine>.json and the log.
 * Run in WebKit too (no CSS scroll anchoring there): `walnut-dev webkit tests/e2e/browser/threads-hold-matrix.spec.ts`.
 *
 * Every run takes the cells of what he reported (inRun: at the list at the very top, and the
 * pointer on a card in the middle), about two minutes; THREADS_HOLD_MATRIX=1 runs the whole matrix,
 * about six minutes a browser, after any change to the hold, the anchor or what a Threads list
 * draws (tests/web/threads-hold.test.ts fails when the list draws something the matrix has no
 * column for). The flags are the server's own and other Threads specs put theirs back while this
 * one runs, so the page reads his flags whatever the server says meanwhile (pinHisFlags).
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Orchard hold ${STAMP}`
const OUT = process.env.WALNUT_TASK_DIR ?? 'test-results'
const WHY = { user_kind: 'user_own', user_kind_why: 'It is his own garden.' }
/** Each row is its own decision (the server folds one matter asked twice). */
const SEPARATE = { separate_reason: 'Each garden row is its own decision.' }
/** His Threads flags (the view he uses: the groups on the Org page, the one card, Watching, ...). */
const HIS_FLAGS = ['task_threads', 'threads_pop_up', 'letters_as_threads', 'top_thread', 'reply_thread_line', 'ack_means_known', 'threads_one_card', 'brief_off', 'org_leaders', 'quiet_rail', 'topics'] as const
const made: string[] = []
const ids = { task: '', sid: '', lead: '', leadSid: '' }
/**
 * The ones the server itself reads for what this spec writes (a task's threads, his Acknowledge);
 * the rest only choose what the page draws, and the page reads them pinned (pinHisFlags), so they
 * are never set on the server: putting them back at the end changed the view under another Threads
 * spec still running (the groups left thread-groups-folds' rail).
 */
const SERVER_FLAGS = ['task_threads', 'letters_as_threads', 'reply_thread_line', 'ack_means_known', 'org_leaders']
let flagsWere: Record<string, boolean> = {}
let n = 0

// One worker: the flags are the server's own, set for the whole file and put back at its end.
test.describe.configure({ mode: 'serial' })
test.setTimeout(45 * 60_000)
test.use({ viewport: { width: 1280, height: 1000 } })

type Pos = 'top' | 'little' | 'middle'
type Presence = 'pointer' | 'typing' | 'away'
const POSITIONS: Pos[] = ['top', 'little', 'middle']
const PRESENCES: Presence[] = ['pointer', 'typing', 'away']
/** The whole matrix, or in every run the cells of what he reported: at the list at the very top, and the pointer on a card in the middle. */
const WHOLE = !!process.env.THREADS_HOLD_MATRIX
const inRun = (pos: Pos, presence: Presence) => WHOLE || (pos === 'top' ? presence !== 'away' : pos === 'middle' && presence === 'pointer')

interface Node { task: string; sid: string }
interface Ctx { page: Page; request: APIRequestContext; node: Node; target: string | null; targetGroup: string | null; box: string }
interface Run { done: () => Promise<boolean>; cleanup?: () => Promise<void> }
interface Change {
  name: string
  /** Which surface draws it: the plain list has no groups, folds or lines. */
  on: ReadonlyArray<'pane' | 'rail'>
  /** It acts on the card right above the one he reads. */
  target?: boolean
  /** He reads a card of this group (the rail): a folded group's head only stands above an opened fold's cards. */
  readIn?: string
  /** Not at the very top: nothing of the kind can stand above a card there. */
  scrolledOnly?: boolean
  run: (c: Ctx) => Promise<Run>
}
interface Cell { surface: string; pos: Pos; presence: Presence; change: string; verdict: 'PASS' | 'FAIL' | 'LIMIT' | 'INFO' | 'NA'; maxDev: number; final: number; frames: number; focus?: boolean; caret?: boolean; note?: string; scroll?: string; reading?: string }

async function call<T>(request: APIRequestContext, method: 'post' | 'put' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

const longReply = (k: number, lines = 4) => Array.from({ length: lines }, (_, i) => `Row ${k}, check ${i + 1}: the soil is moist, the seedlings are up and the netting holds against the birds.`).join('\n')

/** The node opens a thread for him: answered (Done), needs (Needs you) or working. */
async function nodeThread(request: APIRequestContext, node: Node, state: 'answered' | 'needs' | 'working' = 'answered', title = `Row ${++n} ${STAMP}`): Promise<string> {
  const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${node.task}/threads/open`, { title, text: `${title}: where it stands.`, from: 'node', state: state === 'working' ? 'answered' : state, ...(state === 'needs' ? { ...WHY, ...SEPARATE } : {}) }, node.sid)
  const reply = state === 'needs' ? `Net the row now or in May? ${STAMP}` : longReply(n, state === 'answered' ? 4 : 1)
  await call(request, 'patch', `/api/v1/tasks/${node.task}/threads/${thread.id}`, { reply, state, ...(state === 'needs' ? { ...WHY, ...SEPARATE } : {}) }, node.sid)
  return thread.id
}
const patchThread = (c: Ctx, id: string, data: Record<string, unknown>, asHim = false) =>
  call(c.request, 'patch', `/api/v1/tasks/${c.node.task}/threads/${id}`, data, asHim ? undefined : c.node.sid)
/** His own Acknowledge: the card leaves with no line (thread-moves.ts), so a cleanup leaves nothing to fade. */
const ack = (c: Ctx, id: string) => patchThread(c, id, { close: 'acked' }, true)
const sel = (box: string, id: string) => `${box} [data-testid="org-thread"][data-thread-id="${id}"]:not([data-copy])`
const present = (c: Ctx, id: string) => async () => (await c.page.locator(sel(c.box, id)).count()) === 1
const gone = (c: Ctx, id: string) => async () => (await c.page.locator(sel(c.box, id)).count()) === 0

const CHANGES: Change[] = [
  {
    name: 'new card in a group above', on: ['pane', 'rail'],
    run: async (c) => { const id = await nodeThread(c.request, c.node, 'needs'); return { done: present(c, id), cleanup: () => ack(c, id) } },
  },
  {
    name: 'new card in his group', on: ['pane', 'rail'],
    run: async (c) => { const id = await nodeThread(c.request, c.node, 'answered'); return { done: present(c, id) } },
  },
  {
    name: 'a card is watched (Watching, above all)', on: ['pane', 'rail'], target: true,
    run: async (c) => {
      await patchThread(c, c.target!, { watch: true })
      return {
        done: async () => (await c.page.locator(`${c.box} [data-testid="org-thread"][data-copy="watching"][data-thread-id="${c.target}"]`).count()) === 1,
        cleanup: async () => { await patchThread(c, c.target!, { watch: false }) },
      }
    },
  },
  {
    name: 'a card above grows', on: ['pane', 'rail'], target: true,
    run: async (c) => {
      const words = `Grown ${++n} ${STAMP}`
      const keep = c.targetGroup === 'needs' ? { state: 'needs', ...WHY, ...SEPARATE } : { state: 'answered' }
      await patchThread(c, c.target!, { reply: `${words}\n${longReply(n, 6)}`, ...keep })
      return {
        done: async () => (await c.page.locator(`${sel(c.box, c.target!)} [data-testid="org-thread-reply"]`).textContent({ timeout: 2_000 }).catch(() => ''))?.includes(words) ?? false,
        // Short again, so the next cells read a list of the same density.
        cleanup: async () => { await patchThread(c, c.target!, { reply: c.targetGroup === 'needs' ? `Net the row now or in May? ${STAMP}` : longReply(n), ...keep }) },
      }
    },
  },
  {
    // Out of the open list (the pane) or into a fold with a line in its place (the rail).
    name: 'a card above leaves', on: ['pane', 'rail'], target: true,
    run: async (c) => { await patchThread(c, c.target!, { state: 'pending' }); return { done: gone(c, c.target!) } },
  },
  {
    name: 'its move line fades', on: ['rail'], target: true,
    run: async (c) => {
      const line = c.page.locator(`${c.box} [data-testid="org-thread-move-note"]`)
      return { done: async () => (await line.count()) === 0 }
    },
  },
  {
    name: 'a card above moves to another group', on: ['rail'], target: true,
    run: async (c) => {
      const to = c.targetGroup === 'needs' ? 'answered' : 'needs'
      await patchThread(c, c.target!, { state: to, ...(to === 'needs' ? { ...WHY, ...SEPARATE, reply: `Net it now or in May? ${STAMP}` } : { reply: longReply(n) }) })
      const now = to === 'needs' ? 'needs' : 'read'
      return {
        done: async () => (await c.page.locator(`${c.box} [data-testid="org-thread-group"][data-group="${now}"] [data-thread-id="${c.target}"]:not([data-copy])`).count()) === 1,
        cleanup: async () => { if (to === 'needs') await ack(c, c.target!) },
      }
    },
  },
  {
    name: 'a folded group above gets its first card', on: ['rail'], readIn: 'waiting', scrolledOnly: true,
    run: async (c) => {
      const id = await nodeThread(c.request, c.node, 'working')
      return {
        done: async () => (await c.page.locator(`${c.box} [data-testid="org-thread-group"][data-group="working"]`).count()) === 1,
        cleanup: () => ack(c, id),
      }
    },
  },
  {
    // The read after a reconnect brings what changed while the link was down (a new card, a grown one).
    name: 'the list is read again after a reconnect', on: ['pane', 'rail'], target: true,
    run: async (c) => {
      const url = `/api/v1/tasks/${c.node.task}/threads`
      const stale = await (await c.request.get(url)).text()
      const route = `**${url}`
      await c.page.route(route, (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 200, contentType: 'application/json', body: stale }) : r.continue()))
      const id = await nodeThread(c.request, c.node, 'needs')
      const fresh = await nodeThread(c.request, c.node, 'answered')
      await patchThread(c, c.target!, { reply: `Reconnected ${STAMP}\n${longReply(n, 7)}`, state: c.targetGroup === 'needs' ? 'needs' : 'answered', ...(c.targetGroup === 'needs' ? { ...WHY, ...SEPARATE } : {}) })
      await c.page.waitForTimeout(800)
      await c.page.unroute(route)
      await c.page.evaluate(() => {
        const s = (window as Window & { holdTestSocket?: WebSocket }).holdTestSocket
        s?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: '_ws:reconnected', data: {} }) }))
      })
      return { done: async () => (await present(c, id)()) && (await present(c, fresh)()), cleanup: () => ack(c, id) }
    },
  },
]

/**
 * Everything a Threads list draws that can stand above a card, and the change of CHANGES that moves
 * it there. tests/web/threads-hold.test.ts reads these two tables: a new element kind drawn by
 * OrgThreadsByState or OrgThreadsWatching, or a new group, fails it until it has a row here, and
 * its row names a change below (a new kind of change is a new entry of CHANGES: a new column).
 */
const ABOVE_A_CARD: Record<string, string> = {
  'org-thread': 'new card in his group',
  'org-thread-head': 'a card above grows',
  'org-thread-list': 'new card in a group above',
  'org-thread-group': 'new card in a group above',
  'org-thread-group-head': 'a folded group above gets its first card',
  'org-thread-group-count': 'a folded group above gets its first card',
  'org-thread-move-note': 'a card above leaves',
  'org-thread-move-show': 'its move line fades',
  'org-thread-groups': 'the list is read again after a reconnect',
  'org-threads-empty-row': 'none: drawn only when there is no card',
  'org-threads-empty': 'none: drawn only when there is no card',
}
/** Every group, and the change that brings one above a card (a fold's head shows the same for each). */
const GROUPS_ABOVE: Record<string, string> = {
  watching: 'a card is watched (Watching, above all)',
  needs: 'new card in a group above',
  read: 'new card in his group',
  working: 'a folded group above gets its first card',
  waiting: 'a folded group above gets its first card',
  known: 'a folded group above gets its first card',
  done: 'a folded group above gets its first card',
  archived: 'a folded group above gets its first card',
}
void ABOVE_A_CARD
void GROUPS_ABOVE

/** Page side: the card he reads, and the card right above it (not a Watching copy). */
function pickReading(page: Page, a: { box: string; presence: Presence; group: string | null; scope: string | null }) {
  return page.evaluate((a) => {
    const box = document.querySelector<HTMLElement>(a.box)!
    const br = box.getBoundingClientRect()
    const cards = [...box.querySelectorAll<HTMLElement>('[data-testid="org-thread"]:not([data-copy])')]
    const groupOf = (el: Element) => el.closest<HTMLElement>('[data-testid="org-thread-group"]')?.dataset.group ?? null
    let pick = -1
    if (a.presence === 'away') {
      // Away: the card at the top of the view, the one the list holds.
      pick = cards.findIndex((el) => el.getBoundingClientRect().bottom > br.top + 0.5)
    } else {
      // At the list: a card in the upper half of the view with a card above it (its group's when
      // one asked; any other when none of that group is there), the box he types in in view.
      const want = br.top + br.height * 0.4
      const fits = (el: HTMLElement, i: number) => {
        if (i < 1) return false
        const r = el.getBoundingClientRect()
        const input = el.querySelector('[data-testid="org-thread-follow-input"]')?.getBoundingClientRect()
        if (r.top < br.top + 2 || r.top > br.bottom - 80) return false
        return a.presence !== 'typing' || (!!input && input.top >= br.top && input.bottom <= br.bottom)
      }
      for (const only of a.group ? [a.group, null] : [null]) {
        let best = Infinity
        cards.forEach((el, i) => {
          if (only && groupOf(el) !== only) return
          if (!fits(el, i)) return
          const d = Math.abs(el.getBoundingClientRect().top - want)
          if (d < best) { best = d; pick = i }
        })
        if (pick >= 0) break
      }
    }
    if (pick < 0) return null
    const above = pick > 0 ? cards[pick - 1] : null
    return { id: cards[pick].dataset.threadId!, above: above?.dataset.threadId ?? null, aboveGroup: above ? groupOf(above) : null }
  }, a)
}

/**
 * The card's top as each frame paints it: read in the frame's rAF, then read again in a
 * ResizeObserver made after the page's own (callbacks run in the order they were made, after
 * layout and before paint), so a frame whose size change the page puts right in its observer
 * counts as what it painted.
 */
const startSampling = (page: Page, box: string, cardSel: string) => page.evaluate(({ box, s }) => {
  const w = window as Window & { holdSampler?: { on: boolean; ys: number[]; ro: ResizeObserver } }
  const read = () => { const el = document.querySelector(s); return el ? el.getBoundingClientRect().top : NaN }
  const ro = new ResizeObserver(() => { if (st.on && st.ys.length) st.ys[st.ys.length - 1] = read() })
  const st = w.holdSampler = { on: true, ys: [] as number[], ro }
  for (const c of Array.from(document.querySelector(box)?.children ?? [])) ro.observe(c)
  const tick = () => requestAnimationFrame(() => { if (!st.on) return; st.ys.push(read()); tick() })
  tick()
}, { box, s: cardSel })
const stopSampling = (page: Page) => page.evaluate(() => {
  const w = window as Window & { holdSampler?: { on: boolean; ys: number[]; ro: ResizeObserver } }
  w.holdSampler!.on = false
  w.holdSampler!.ro.disconnect()
  return w.holdSampler!.ys
})

async function setPosition(page: Page, box: string, pos: Pos): Promise<void> {
  await page.evaluate(({ box, pos }) => {
    const el = document.querySelector<HTMLElement>(box)!
    el.scrollTop = pos === 'top' ? 0 : pos === 'little' ? 60 : Math.round((el.scrollHeight - el.clientHeight) / 2)
  }, { box, pos })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

const inputOf = (box: string, id: string) => `${sel(box, id)} [data-testid="org-thread-follow-input"]`
const typingState = (page: Page, inputSel: string) => page.evaluate((s) => {
  const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(s)
  const a = document.activeElement
  return { focus: !!el && (a === el || el.contains(a)), caret: (a as HTMLTextAreaElement | null)?.selectionStart ?? null }
}, inputSel)

async function runCell(page: Page, request: APIRequestContext, surface: 'pane' | 'rail', node: Node, box: string, pos: Pos, presence: Presence, ch: Change): Promise<Cell> {
  const cell: Cell = { surface, pos, presence, change: ch.name, verdict: 'NA', maxDev: 0, final: 0, frames: 0 }
  if (ch.scrolledOnly && pos === 'top') return { ...cell, note: 'nothing of the kind stands above a card at the very top' }
  await page.mouse.move(5, 5)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.waitForTimeout(250)
  await setPosition(page, box, pos)
  const r = await pickReading(page, { box, presence, group: ch.readIn ?? (surface === 'rail' ? 'read' : null), scope: null })
  if (!r || (ch.target && !r.above)) return { ...cell, note: 'no card to read here with a card above it' }
  const ctx: Ctx = { page, request, node, target: r.above, targetGroup: r.aboveGroup, box }
  const card = page.locator(sel(box, r.id))
  const input = inputOf(box, r.id)
  if (presence === 'pointer') {
    const b = (await card.boundingBox())!
    await page.mouse.move(b.x + 6, b.y + Math.min(48, b.height / 2), { steps: 4 })
  } else if (presence === 'typing') {
    await page.evaluate((s) => document.querySelector<HTMLElement>(s)?.focus({ preventScroll: true }), input)
    // Keys typed anywhere else would be the page's shortcuts.
    if (!(await typingState(page, input)).focus) return { ...cell, note: 'its Follow up box did not take the focus' }
    await page.keyboard.type('net it', { delay: 5 })
    await page.evaluate((s) => { const el = document.querySelector<HTMLTextAreaElement>(s); el?.setSelectionRange?.(3, 3) }, input)
  }
  // A move line from the last cell fades first (its own cell judges that).
  if (ch.name !== 'its move line fades') await expect(page.locator(`${box} [data-testid="org-thread-move-note"]`)).toHaveCount(0, { timeout: 10_000 })
  else {
    // Its line first, untimed: a card above leaves for a fold.
    await patchThread(ctx, r.above!, { state: 'pending' })
    await expect(page.locator(`${box} [data-testid="org-thread-move-note"][data-moved-id="${r.above}"]`)).toHaveCount(1, { timeout: 15_000 })
  }
  await page.waitForTimeout(300)
  const before = presence === 'typing' ? await typingState(page, input) : null
  const startTop = await page.evaluate((b) => document.querySelector<HTMLElement>(b)!.scrollTop, box)
  const y0 = (await card.boundingBox())!.y
  await startSampling(page, box, sel(box, r.id))
  const run = await ch.run(ctx)
  await expect.poll(run.done, { timeout: 20_000, message: `${surface} ${pos} ${presence}: ${ch.name}` }).toBe(true)
  await page.waitForTimeout(600)
  const ys = await stopSampling(page)
  const yEnd = (await card.boundingBox())?.y ?? NaN
  const after = presence === 'typing' ? await typingState(page, input) : null
  const endTop = await page.evaluate((b) => document.querySelector<HTMLElement>(b)!.scrollTop, box)
  const devs = [...ys, yEnd].map((y) => (Number.isNaN(y) ? Infinity : y - y0))
  const worst = devs.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0)
  cell.maxDev = Math.round(worst * 10) / 10
  cell.final = Math.round((yEnd - y0) * 10) / 10
  cell.frames = ys.length
  if (before && after) { cell.focus = after.focus; cell.caret = after.caret === before.caret }
  const held = Math.abs(worst) < 1 && (!after || (after.focus && cell.caret))
  // Content above got shorter than the room there was to scroll up: no scroll can hold it.
  const limit = !held && worst < 0 && startTop < Math.abs(worst) + 1
  cell.verdict = presence === 'away' && pos === 'top' ? 'INFO' : held ? 'PASS' : limit ? 'LIMIT' : 'FAIL'
  if (limit) cell.note = `scrollTop was ${startTop}`
  cell.scroll = `${startTop}->${endTop}`
  cell.reading = `${r.id}${r.above ? ` under ${r.above} (${r.aboveGroup})` : ''}`
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
        if (!inRun(pos, presence)) continue
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

/** The page's own socket, so a reconnect can be told to it (file-live-edit.spec.ts does the same). */
async function keepSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.WebSocket
    class Kept extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as Window & { holdTestSocket?: WebSocket }).holdTestSocket = this
      }
    }
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) Object.defineProperty(Kept, k, { value: Native[k] })
    window.WebSocket = Kept
  })
}

/**
 * His flags as this page reads them, whatever the server says meanwhile: they are the server's own,
 * and another Threads spec that ends while this one runs puts them back (the groups left the rail
 * mid-run that way). Only the page's reads: the server keeps what beforeAll set.
 */
async function pinHisFlags(page: Page): Promise<void> {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json() as { config?: { experimental?: Record<string, boolean> } }
    body.config = { ...body.config, experimental: { ...body.config?.experimental, ...Object.fromEntries(HIS_FLAGS.map((f) => [f, true])) } }
    await route.fulfill({ response: res, json: body })
  })
}

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

const judged = (cells: Cell[]) => cells.filter((c) => c.verdict === 'FAIL').map((c) => `${c.surface} / ${c.pos} / ${c.presence} / ${c.change}: moved ${c.maxDev}px${c.focus === false ? ', focus lost' : ''}${c.caret === false ? ', caret moved' : ''}`)

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
