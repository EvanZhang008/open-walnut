import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'

/**
 * The page's memory under a realistic multi-hour push load (2026-11-09: the Mac app's page
 * reached 2.1 GB, mostly because every `cron:job-*` push refetched the whole 1.2 MB routines
 * list, 12 to 30 times a minute).
 *
 * The fixture (page-memory-soak-server.ts) seeds a board as dense as the real one (about 180
 * routines with a list over 1 MB, about 300 tasks, a session on a task with a trigger) and, on
 * request, replays a compressed three hours of the push mix measured on the real page through the
 * server's real push paths. The page is opened the way a person keeps it: Home with the task list
 * and that session's column, then the Routines page, so every `cron:job-*` subscriber is live
 * (Home stays mounted under it).
 *
 * What fails it: a push handler that refetches a big list (bytes fetched per push, and how many
 * list-sized responses), the page keeping memory per event once the column is closed (JS heap after
 * a forced GC, Chromium only: WebKit has no heap reading a test runner can take; DOM nodes), or the
 * open column adding DOM per readout event (nodes per chat row). The open column's own heap is
 * recorded, not budgeted: it keeps every row it drew while live, about 1 MB a chat row in the dev
 * build this fixture serves, so its growth follows the content.
 *
 * Measured (2026-11-09, 3 hours in about 10 minutes): fixed code 770 B per push in WebKit, 600 to
 * 1,200 in Chromium, about 6 MB heap and 0 nodes kept; with the per-push list refetch put back,
 * 81 KB per push in WebKit (1,312 list reads, 1.9 GB) and 8.4 KB in Chromium (133 list reads, its
 * main thread held by the column).
 * PW_SOAK_HOURS shortens the replay; PW_SOAK_HEAP_DIFF=1 prints what grew by constructor (Chromium).
 */

const HOURS = Number(process.env.PW_SOAK_HOURS ?? 3)
/** Bytes the page may fetch per push, on average, every push counted (about 25,000). Fixed code reads
 *  one routine (about 10 KB) per cron push, one push in nineteen: under 1.2 KB a push. */
const BYTES_PER_PUSH_BUDGET = 4 * 1024
/** A list-sized response: the routines list is over 1 MB, the biggest routine about 20 KB, a page of
 *  the session's history well under this. */
const SINGLE_RESPONSE_CAP = 256 * 1024
/** List-sized responses allowed per cron push. The store still reads the whole list for a burst of
 *  over 20 jobs (a page whose main thread was held for seconds) and after a socket reconnect, so a
 *  few happen; a handler that refetches per push makes about one per push. */
const BIG_RESPONSES_PER_CRON_PUSH = 1 / 50
/** JS heap the page keeps after a forced GC once the column is closed: the stores hold the same
 *  routines and tasks before and after, and the session's three hours of turns are a few hundred KB
 *  of text; a store or listener that keeps something per push (1,320 cron pushes, 25,000 in all)
 *  goes far over this. */
const HEAP_GROWTH_BUDGET = 25 * 1024 * 1024
/** DOM nodes the page keeps once the column is closed: the task list and the Routines page draw the
 *  same rows before and after, so anything here grew per event. */
const DOM_GROWTH_BUDGET = 1_500
/** The open column keeps every row it drew (it never unmounts rows from the top while live), about
 *  30 nodes per chat row today; a readout event (speed, usage, live activity, ...) that added a node
 *  would add about 10 per row. */
const NODES_PER_CHAT_ROW_BUDGET = 60

interface SoakFixture { port: number; home: string; liveTaskId: string; liveSessionId: string; liveTitle: string; listBytes: number }

let fixture: SoakFixture | null = null
let child: ChildProcessWithoutNullStreams | null = null

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function startFixture(): Promise<SoakFixture> {
  const port = await reservePort()
  let output = ''
  child = spawn(bunRuntime(), ['tests/e2e/browser/page-memory-soak-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_SOAK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // PW_SOAK_LOG=<file> keeps the fixture's whole output, for a run that needs reading.
  const logFile = process.env.PW_SOAK_LOG
  const keep = (chunk: unknown) => {
    output = `${output}${String(chunk)}`.slice(-20_000)
    if (logFile) void fs.appendFile(logFile, String(chunk))
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  return await new Promise<SoakFixture>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Soak fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /SOAK_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as SoakFixture)
      } else if (child!.exitCode !== null) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Soak fixture exited early (${child!.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

async function stopFixture(): Promise<void> {
  if (!child) return
  const stopped = new Promise<void>((resolve) => {
    if (child!.exitCode !== null || child!.signalCode !== null) resolve()
    else child!.once('exit', () => resolve())
  })
  child.kill('SIGTERM')
  const graceful = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
  ])
  if (!graceful) child.kill('SIGKILL')
  // The fixture removes its data home on exit, but a server killed mid-shutdown leaves it (about
  // 90 MB with its Vite cache); the spec knows the path, so it goes here too.
  if (fixture) await fs.rm(fixture.home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 860 } })

test.beforeAll(async () => {
  test.setTimeout(240_000)
  fixture = await startFixture()
})

test.afterAll(async () => { await stopFixture() })

/** What the page fetched and received while `counting` is on. */
function watchTraffic(page: Page) {
  const state = { counting: false, bytes: 0, responses: 0, big: 0, largest: { bytes: 0, url: '' }, pushes: 0, lastResponseAt: Date.now(), sockets: 0, byRoute: new Map<string, { n: number; bytes: number }>() }
  page.on('response', async (response) => {
    const type = response.request().resourceType()
    if (type !== 'fetch' && type !== 'xhr') return
    if (!state.counting) return
    let bytes = 0
    try { bytes = (await response.body()).length } catch {
      try { bytes = (await response.request().sizes()).responseBodySize } catch { /* gone */ }
    }
    state.bytes += bytes
    state.responses += 1
    state.lastResponseAt = Date.now()
    const url = response.url().replace(/^https?:\/\/[^/]+/, '')
    if (bytes > state.largest.bytes) state.largest = { bytes, url }
    if (bytes >= SINGLE_RESPONSE_CAP) state.big += 1
    // One row per route (ids and query folded), so a failing run names who fetched the bytes.
    const route = url.split('?')[0]!.replace(/\/(rt|t|sess)-soak-[\w-]+/g, '/:id') + (url.includes('?') ? '?' : '')
    const row = state.byRoute.get(route) ?? { n: 0, bytes: 0 }
    row.n += 1
    row.bytes += bytes
    state.byRoute.set(route, row)
  })
  page.on('websocket', (ws) => {
    if (state.counting) state.sockets += 1
    ws.on('framereceived', (frame) => {
      if (state.counting && typeof frame.payload === 'string' && frame.payload.startsWith('{"type":"event"')) state.pushes += 1
    })
  })
  return state
}

/**
 * Ask the fixture for `hours` of pushes and wait for its done marker. Null when it did not finish in
 * time: a page that fetches a big list per push loads the server until the replay crawls, and the
 * test then reports the bytes it fetched so far instead of a bare timeout.
 */
async function replay(hours: number): Promise<Record<string, number> | null> {
  const done = path.join(fixture!.home, 'soak-replay-done.json')
  await fs.rm(done, { force: true })
  await fs.writeFile(path.join(fixture!.home, 'soak-replay.json'), JSON.stringify({ hours }))
  // Three hours replay in about ten minutes; near twice that is a replay held back by the page.
  const deadline = Date.now() + Math.max(120_000, hours * 6 * 60_000)
  while (Date.now() < deadline) {
    const counts = await fs.readFile(done, 'utf8').then((text) => JSON.parse(text) as Record<string, number>, () => null)
    if (counts) return counts
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return null
}

interface Reading { heap: number | null; nodes: number; classes: Record<string, number> }
let loadsSeen: string[] = []

async function reading(page: Page, cdp: import('@playwright/test').CDPSession | null): Promise<Reading> {
  let heap: number | null = null
  if (cdp) {
    for (let i = 0; i < 3; i += 1) await cdp.send('HeapProfiler.collectGarbage')
    heap = (await cdp.send('Runtime.getHeapUsage')).usedSize
  }
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length).catch((err: Error) => { throw new Error(`${err.message}\nloads: ${JSON.stringify(loadsSeen)}`) })
  // Elements per class name, so a failing run names where the DOM grew.
  const classes = await page.evaluate(() => {
    const counts: Record<string, number> = {}
    for (const el of Array.from(document.getElementsByTagName('*'))) {
      for (const name of Array.from(el.classList)) counts[name] = (counts[name] ?? 0) + 1
    }
    return counts
  })
  return { heap, nodes, classes }
}

function grownClasses(before: Reading, after: Reading, top = 12): string {
  return Object.entries(after.classes)
    .map(([name, n]) => [name, n - (before.classes[name] ?? 0)] as const)
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, d]) => `${name} +${d}`)
    .join(', ')
}

/**
 * PW_SOAK_HEAP_DIFF=1 (Chromium): what grew between two heap snapshots, by constructor, so a heap
 * failure names its cause. Off by default: a snapshot of this page is over 100 MB of JSON.
 */
async function heapByConstructor(cdp: import('@playwright/test').CDPSession): Promise<Map<string, { count: number; size: number }>> {
  const chunks: string[] = []
  const onChunk = (e: { chunk: string }) => { chunks.push(e.chunk) }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  const snap = JSON.parse(chunks.join('')) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }; nodes: number[]; strings: string[]
  }
  const fields = snap.snapshot.meta.node_fields
  const stride = fields.length
  const [typeAt, nameAt, sizeAt] = [fields.indexOf('type'), fields.indexOf('name'), fields.indexOf('self_size')]
  const types = snap.snapshot.meta.node_types[0]
  const out = new Map<string, { count: number; size: number }>()
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const type = types[snap.nodes[i + typeAt]!]!
    const key = type === 'object' || type === 'closure' ? `${type}:${snap.strings[snap.nodes[i + nameAt]!]}` : type
    const row = out.get(key) ?? { count: 0, size: 0 }
    row.count += 1
    row.size += snap.nodes[i + sizeAt]!
    out.set(key, row)
  }
  return out
}

function heapGrowth(before: Map<string, { count: number; size: number }>, after: Map<string, { count: number; size: number }>): string {
  return [...after.entries()]
    .map(([key, row]) => ({ key, size: row.size - (before.get(key)?.size ?? 0), count: row.count - (before.get(key)?.count ?? 0) }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)
    .map((r) => `${r.key} ${(r.size / 1024).toFixed(0)} KB (+${r.count})`)
    .join('\n')
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

test('a compressed three hours of pushes keep the page\'s fetches, heap and DOM under budget', async ({ page, browserName }) => {
  test.setTimeout(45 * 60_000)
  expect(fixture!.listBytes, 'the seeded routines list is as big as the real one').toBeGreaterThan(1_000_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // A reload would start the page's memory over and hide what the replay retained.
  const loads: string[] = []
  page.on('load', () => loads.push(`${new Date().toISOString()} ${page.url()}`))
  loadsSeen = loads
  const notes: string[] = []
  page.on('console', (msg) => { if (/reload|crash-recovery|\[vite\]|\[ws\].*(reconnect|resync|disconnect)/i.test(msg.text())) notes.push(`${new Date().toISOString()} ${msg.text().slice(0, 300)}`) })
  const traffic = watchTraffic(page)

  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', '0')
      sessionStorage.removeItem('open-walnut-home-session-columns')
      localStorage.removeItem('open-walnut-layout:home-columns')
    } catch { /* storage off */ }
  })
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
  const column = page.locator(`.main-page-session-column .session-panel[data-session-id="${fixture!.liveSessionId}"]`)

  /** Home: the session's column, opened from its task row; then the whole list again. */
  const openColumn = async () => {
    await page.getByTestId('sidebar-core-app-home').click()
    const row = page.locator(`.todo-panel-item[data-task-id="${fixture!.liveTaskId}"]:visible`).first()
    await expect(async () => {
      await page.locator('.todo-search-input').fill(fixture!.liveTitle)
      await expect(row).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 40_000 })
    // A click on the row (its Focus label) opens it; a click on its title would start renaming
    // the task once it is already the selected one (the second time here).
    await row.locator('[title="Pinned in Focus"]').first().click()
    await expect(column).toBeVisible({ timeout: 30_000 })
    await expect(column.getByText('soak answer 12').first()).toBeVisible({ timeout: 30_000 })
    await page.locator('.todo-search-input').fill('')
  }
  /** Home: the column closed with its own button. */
  const closeColumn = async () => {
    await page.getByTestId('sidebar-core-app-home').click()
    await column.locator('.session-panel-close').first().click()
    await expect(column).toHaveCount(0)
  }
  /** The Routines page on top, so its subscribers are live too (Home stays mounted under it). */
  const openRoutines = async () => {
    await page.getByTestId('sidebar-core-app-routines').click()
    await expect(page).toHaveURL(/\/routines/)
    await expect(page.getByText('Watch ').first()).toBeVisible({ timeout: 30_000 })
  }
  const settle = () => expect.poll(() => Date.now() - traffic.lastResponseAt, { timeout: 60_000 }).toBeGreaterThan(3_000)
  const chatRows = () => column.locator('.session-msg').count()

  await openColumn()
  await openRoutines()
  const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
  if (cdp) await cdp.send('HeapProfiler.enable')

  // Warm up: a turn and a few minutes of pushes, so first-use caches exist before any baseline.
  expect(await replay(0.1), 'the warm-up replay finished').not.toBeNull()
  await settle()
  // The baseline of what outlives the view: the column closed, the Routines page on top.
  await closeColumn()
  await openRoutines()
  const before = await reading(page, cdp)
  const heapDiff = cdp && process.env.PW_SOAK_HEAP_DIFF === '1'
  const snapBefore = heapDiff ? await heapByConstructor(cdp) : null
  // And with the column open again, for what the open column adds per chat row.
  await openColumn()
  await openRoutines()
  await settle()
  const openBefore = await reading(page, cdp)
  const snapOpenBefore = heapDiff ? await heapByConstructor(cdp) : null
  const rowsBefore = await chatRows()
  const loadsAtBaseline = loads.length

  traffic.counting = true
  const finished = await replay(HOURS)
  const counts = finished ?? { cron: Number.NaN, task: Number.NaN, session: Number.NaN, ms: Number.NaN }
  // Answers to the last pushes land after the replay's end; they belong to it.
  await settle()
  traffic.counting = false
  const loadsDuringReplay = loads.slice(loadsAtBaseline)
  const openAfter = await reading(page, cdp)
  if (snapOpenBefore) {
    // A snapshot past V8's longest string (about 512 MB of JSON) cannot be read whole here.
    const diff = await heapByConstructor(cdp!).then((snap) => heapGrowth(snapOpenBefore, snap), (err: Error) => `not read: ${err.message}`)
    console.log(`[page-memory-soak] open column heap growth by constructor:\n${diff}`)
  }
  const rowsAdded = (await chatRows()) - rowsBefore
  await closeColumn()
  await openRoutines()
  const after = await reading(page, cdp)
  if (snapBefore) console.log(`[page-memory-soak] heap growth by constructor:\n${heapGrowth(snapBefore, await heapByConstructor(cdp!))}`)

  const pushes = traffic.pushes
  const perPush = pushes > 0 ? traffic.bytes / pushes : 0
  const openNodesPerRow = (openAfter.nodes - openBefore.nodes) / Math.max(1, rowsAdded)
  const record = {
    browser: browserName, hours: HOURS, replayMs: counts.ms, sent: { cron: counts.cron, task: counts.task, session: counts.session },
    pushesReceived: pushes, socketsOpened: traffic.sockets, responses: traffic.responses, fetched: mb(traffic.bytes), bytesPerPush: Math.round(perPush),
    largestResponse: traffic.largest, bigResponses: traffic.big,
    byRoute: [...traffic.byRoute.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)
      .map(([route, r]) => `${route} x${r.n} ${mb(r.bytes)}`),
    retained: {
      heap: before.heap === null ? 'not readable in this browser' : { before: mb(before.heap), after: mb(after.heap!), growth: mb(after.heap! - before.heap) },
      nodes: { before: before.nodes, after: after.nodes, growth: after.nodes - before.nodes, grewMost: grownClasses(before, after) },
    },
    openColumn: {
      chatRowsAdded: rowsAdded,
      heap: openBefore.heap === null ? null : { before: mb(openBefore.heap), after: mb(openAfter.heap!), growth: mb(openAfter.heap! - openBefore.heap) },
      nodes: { before: openBefore.nodes, after: openAfter.nodes, perChatRow: Math.round(openNodesPerRow), grewMost: grownClasses(openBefore, openAfter) },
    },
  }
  console.log(`[page-memory-soak] ${JSON.stringify(record)}`)
  if (notes.length) console.log(`[page-memory-soak] page notes:\n${notes.join('\n')}`)

  // A replay that did not finish was held back by the page: its fetches say why, so they go first.
  if (!finished) {
    expect(perPush, 'bytes fetched per push so far, the replay unfinished: a push handler refetches a big list').toBeLessThan(BYTES_PER_PUSH_BUDGET)
    expect(finished, 'the replay finished').not.toBeNull()
  }
  expect(loadsDuringReplay, 'the page loaded again during the replay').toEqual([])
  // The replay really reached the page, and its turns reached the column.
  expect(pushes).toBeGreaterThan(counts.cron)
  expect(rowsAdded).toBeGreaterThan(0)
  expect(perPush, 'bytes fetched per push: a push handler refetches a big list').toBeLessThan(BYTES_PER_PUSH_BUDGET)
  expect(traffic.big, `responses over ${SINGLE_RESPONSE_CAP / 1024} KB during the replay (largest: ${traffic.largest.url})`)
    .toBeLessThanOrEqual(Math.ceil(counts.cron * BIG_RESPONSES_PER_CRON_PUSH))
  if (before.heap !== null) {
    expect(after.heap! - before.heap, 'JS heap the page kept after the replay, its column closed').toBeLessThan(HEAP_GROWTH_BUDGET)
  }
  expect(after.nodes - before.nodes, 'DOM nodes the page kept after the replay, its column closed').toBeLessThan(DOM_GROWTH_BUDGET)
  expect(openNodesPerRow, 'DOM nodes the open column added per chat row: a readout event that adds a node').toBeLessThan(NODES_PER_CHAT_ROW_BUDGET)
  expect(errors).toEqual([])
})
