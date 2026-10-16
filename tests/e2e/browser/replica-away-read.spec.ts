/**
 * The console through a host replica while the Mac sleeps
 * (docs/plan/walnut-replica-servers-impl.md, WP7; rows R1, R2, R4 of section 10).
 * Fixture: replica-server.ts (a real Mac, a host daemon twin, the replica it
 * supervises, a fake tunnel in front of the replica); config replica.config.ts.
 *
 *   1. through the tunnel: sign in with a code the Mac made (real clicks); the
 *      board answers from the Mac (forwarded), no away line
 *   2. the Mac sleeps (SIGSTOP) with /ws spliced to it: the away line appears
 *      within LEADER_QUIET_MS + 5 s with no user action, the spliced socket was
 *      closed 4001 (the browser's own log line says so), and the line names the
 *      copies' age ("the copy on devbox from ...": the replica sends it)
 *   3. away, from the copies: the task rows (a Unicode title, matched exactly), an
 *      edit says "Needs your Mac" and changes nothing (the row stays open, the
 *      replica's copy too), on a phone a rename in Details too; a Mac session
 *      keeps its composer mounted but cannot send; a task's Board page opens (a
 *      view never loaded before, x-walnut-offline on its request); this host's
 *      session shows its history and keeps its composer; the notes tree, a note
 *      and a notes search; the inbox
 *   4. the Mac wakes (SIGCONT): the line goes away with no reload (a `window`
 *      marker survives), no host problem card, and live data resumes on the
 *      spliced socket: an edit made on the Mac shows up by itself
 *
 * Through the whole test: every 503 is one the console was expected to get (the
 * writes it made, a Mac session's reads, a session's budget: expected503), no
 * GET is ever answered 504, and no
 * other 5xx. A second test keeps a draft typed before the Mac slept through the
 * sleep and the wake, then sends it (the person's words land before the reply,
 * and the session goes idle). A third loads the page while the Mac sleeps, so
 * nothing on it can be the Mac's own answer: the Routines page, Settings (where a
 * save says "Needs your Mac" with the reason and changes nothing), the favorites
 * and the layout come from the WP5 copies. A fourth measures the away load (worst of 5).
 *
 * The first load of the tunnel address is a `goto`: opening a link is what the
 * person does. Everything after it is a click.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page, type Response } from '@playwright/test'
import { openListProject } from './todo-panel-helpers'

test.setTimeout(300_000)

const PORT = Number(process.env.PW_TEST_PORT ?? 3472)
const CONTROL = `http://127.0.0.1:${PORT + 1}`
const SHOTS = path.join('/tmp/replica-plan', path.basename(import.meta.filename, '.spec.ts'))
/** WALNUT_LEADER_QUIET_MS of the fixture (tests/helpers/replica-cluster.ts WINDOWS). */
const QUIET_MS = 6_000
// A Unicode title, as test data (\u escapes).
const UNICODE_TITLE = 'Fix the flaky build \u00e9t\u00e9'
const NEEDS_MAC = 'Needs your Mac. Changing a task needs your Mac for now.'
/** A settings save away: the why's words (web/src/api/leader-presence.ts), shown as they are. */
const NEEDS_MAC_SETTINGS = 'Needs your Mac. Changing settings needs your Mac.'

interface Ready {
  ids: { board: string; other: string; macSid: string; hostSid: string }
  hostTurn: { asked: string; answered: string }
  note: { path: string; name: string; text: string }
  letter: { subject: string; text: string }
  routine: { name: string; text: string }
  favorites: { projects: string[]; notes: string[] }
  theme: { key: string; value: string }
  userName: string
}

async function control<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(CONTROL + p, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const json = await res.json() as T
  if (!res.ok) throw new Error(`control ${method} ${p}: ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A task row whose title is exactly `title` (the title element, not any text in the row). */
const row = (page: Page, title: string) => page.locator('.todo-panel .todo-panel-item')
  .filter({ has: page.locator('.todo-item-title', { hasText: new RegExp(`^\\s*${escapeRe(title)}\\s*$`) }) }).first()
const panelOf = (page: Page, sid: string) => page.locator(`.session-panel[data-session-id="${sid}"]`).first()
const isPhone = () => test.info().project.name.endsWith('-phone')

/** A fetch from the page as the console makes it (this browser's device token), with the headers it got. */
async function pageGet(page: Page, url: string): Promise<{ status: number; headers: Record<string, string>; json: any }> {
  return page.evaluate(async (u) => {
    const token = localStorage.getItem('walnut.deviceToken')
    const r = await fetch(u, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    const headers: Record<string, string> = {}
    r.headers.forEach((v, k) => { headers[k] = v })
    let json: unknown = null
    try { json = await r.json() } catch { /* not JSON */ }
    return { status: r.status, headers, json }
  }, url)
}

/** The next GET whose path starts with `prefix`, as the console makes it. */
const nextGet = (page: Page, prefix: string) => page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.startsWith(prefix), { timeout: 30_000 })
const offlineOf = (r: Response) => Number(r.headers()['x-walnut-offline'] ?? NaN)

/**
 * A fresh browser shows the project folded: open it as the person does (kept in
 * this browser). On a phone the whole row is the tap target (phone-pages.css: its
 * chevron and name take no pointer events); on a desktop, the name.
 */
async function openAcme(page: Page): Promise<void> {
  if (!isPhone()) return openListProject(page, 'Acme')
  const header = page.locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name').filter({ hasText: /^Acme$/ }) }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  const chevron = header.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) {
    await header.click()
    await expect(chevron).toHaveClass(/expanded/)
  }
}

/**
 * On a phone a session or a task's detail opens over the task list, as a layer:
 * the top bar's Back closes one (no reload). A session and its Board pane are two.
 * The list stays in the DOM under a layer, so the layers are what is counted.
 */
async function backToTasks(page: Page): Promise<void> {
  if (!isPhone()) {
    // A desktop opens a session's Board full screen, over the list: its x leaves full screen.
    const exit = page.getByRole('button', { name: 'Exit full screen' })
    for (let i = 0; i < 3 && (await exit.count()) > 0; i++) {
      await exit.first().click()
      await page.waitForTimeout(300)
    }
    await expect(exit).toHaveCount(0, { timeout: 15_000 })
    if (!(await page.locator('.todo-panel').isVisible())) await page.locator('#primary-sidebar').getByRole('link', { name: /^(Home|Tasks)$/ }).first().click()
    await expect(row(page, 'Release plan')).toBeVisible({ timeout: 15_000 })
    return
  }
  const layers = page.locator('.is-phone-layer:visible')
  for (let i = 0; i < 4 && (await layers.count()) > 0; i++) {
    const back = page.locator('.phone-topbar').getByRole('button', { name: 'Back' })
    if (await back.isVisible()) await back.click()
    else await page.goBack()
    await page.waitForTimeout(400)
  }
  await expect(layers).toHaveCount(0, { timeout: 15_000 })
  if (!(await row(page, 'Release plan').isVisible())) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('#primary-sidebar').getByRole('link', { name: /^(Home|Tasks)$/ }).first().click()
  }
  await expect(row(page, 'Release plan')).toBeVisible({ timeout: 15_000 })
}

/** The app's own navigation to a page: the phone's drawer, a desktop's sidebar. */
async function navTo(page: Page, name: string): Promise<void> {
  if (isPhone()) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(page.locator('#primary-sidebar')).toHaveClass(/\bopen\b/)
  }
  await page.locator('#primary-sidebar').getByRole('link', { name, exact: true }).first().click()
}

/** The composer of a session panel that cannot send (the Mac away): mounted, the text kept, no send controls. */
async function expectSendBlocked(panel: ReturnType<typeof panelOf>): Promise<void> {
  await expect(panel.getByTestId('mac-away-composer')).toContainText('Your Mac is away.')
  await expect(panel.locator('.session-panel-input textarea').first()).toBeVisible()
  await expect(panel.locator('.session-panel-input .chat-send-btn-icon')).toHaveCount(0)
  await expect(panel.locator('.session-panel-input [data-send-blocked="true"]')).toHaveCount(1)
}

/** The same composer back with the Mac: no notice, nothing blocked, its send button. */
async function expectSendable(panel: ReturnType<typeof panelOf>): Promise<void> {
  await expect(panel.getByTestId('mac-away-composer')).toHaveCount(0, { timeout: 30_000 })
  await expect(panel.locator('.session-panel-input [data-send-blocked]')).toHaveCount(0)
  await expect(panel.locator('.session-panel-input .chat-send-btn-icon').first()).toBeVisible()
}

/** Signs in through the tunnel with a code the Mac made, and opens the project. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 120_000 })
  const before = (await control<{ count: number }>('GET', '/control/devices')).count
  const { code } = await control<{ code: string }>('GET', '/control/code')
  await page.getByTestId('unpaired-code-input').fill(code)
  await page.getByTestId('unpaired-code-submit').click()
  await expect(notice).toBeHidden({ timeout: 60_000 })
  // The device round reaches the replica before the Mac sleeps (it checks this browser's token then).
  await expect.poll(async () => (await control<{ count: number }>('GET', '/control/devices')).count, { timeout: 60_000 }).toBeGreaterThan(before)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 120_000 })
  await openAcme(page)
  await expect(row(page, 'Release plan')).toBeVisible({ timeout: 60_000 })
}

/**
 * Every answer the page got, sorted the way the checks need it: each 503 with
 * its why and who answered it (`x-walnut-answered-via`: the replica's own
 * refusal, or the Mac's answer forwarded), each 504 with its method and whether
 * it was sent before the away line showed, and any other 5xx.
 */
const BODY_UNREAD = Symbol('body-unread')

function watchAnswers(page: Page) {
  const state = { awaySeen: false }
  const sentAway = new WeakSet<object>()
  const why503: Array<{ path: string; why: string; via: string }> = []
  const got504: Array<{ what: string; method: string; beforeAway: boolean }> = []
  const other5xx: string[] = []
  const pending: Array<Promise<void>> = []
  page.on('request', (r) => { if (state.awaySeen) sentAway.add(r) })
  page.on('response', (r) => {
    const status = r.status()
    if (status < 500) return
    const method = r.request().method()
    const what = `${status} ${method} ${new URL(r.url()).pathname}`
    if (status === 503) {
      const via = r.headers()['x-walnut-answered-via'] ?? 'none'
      // Chromium never hands over the body of a fetch the page did not read (a
      // fire-and-forget write): bounded, it is told as `body-unread`.
      const body = Promise.race([r.json(), new Promise((resolve) => setTimeout(() => resolve(BODY_UNREAD), 5_000))])
      pending.push(body.then((j) => {
        if (j === BODY_UNREAD) return void why503.push({ path: what, why: 'body-unread', via })
        const o = j as { error?: { why?: string; code?: string } | string; code?: string }
        const e = typeof o?.error === 'object' ? o.error : undefined
        why503.push({ path: what, why: e?.why ?? e?.code ?? o?.code ?? 'none', via })
      }, () => { why503.push({ path: what, why: 'not-json', via }) }))
    } else if (status === 504) got504.push({ what, method, beforeAway: !sentAway.has(r.request()) })
    else other5xx.push(what)
  })
  return { state, why503, got504, other5xx, settle: () => Promise.all(pending) }
}

/**
 * The 503s the console is expected to get away (`<status> <method> <path>` and
 * the why it is told): its writes (a task edit, a settings save and the layout
 * prefs say why; the background writes of seen marks and read marks carry the
 * presence's own why), the Mac session's reads, a session's budget (the Mac's
 * usage store), and what WP5 does not copy (a chat's messages, the first
 * conversation of an agent with no list).
 */
function expected503(ids: Ready['ids']): Array<{ test: RegExp; whys: string[] }> {
  // These writes have no why of their own (the presence's), and the page never
  // reads their answer: on Chromium their body is never handed over.
  const presence = ['mac-away', 'unreachable', 'body-unread']
  return [
    { test: /^503 (PATCH|POST|PUT|DELETE) \/api\/tasks\//, whys: ['task_writes_need_mac'] },
    // The layout prefs say which store (a row of their own, WP5); the page never reads that answer either.
    { test: /^503 PUT \/api\/ui-prefs$/, whys: ['prefs_writes_need_mac', 'body-unread'] },
    // A settings save (WP5): the Mac owns config.yaml.
    { test: /^503 PUT \/api\/config$/, whys: ['config_writes_need_mac'] },
    { test: /^503 (PUT|POST|PATCH) \/api\/(notifications\/[^/]+|v1\/tasks\/[^/]+\/board\/[^/]+)$/, whys: presence },
    // The console's log lines, posted while its socket is down (a reload away): the
    // old page's keepalive post has no body to read once the page is gone.
    { test: /^503 POST \/api\/browser-logs$/, whys: [...presence, 'not-json'] },
    // The chat list of an agent the Mac keeps no list for yet (the note agent, its
    // Notes page never opened while the Mac answered): its first conversation is
    // made on the Mac (WP5, core/conversations.ts getMainConversationId).
    { test: /^503 GET \/api\/agents\/[^/]+\/conversations$/, whys: ['conversation_writes_need_mac'] },
    // A chat's messages (a task's triage history in its detail): only the lists are
    // copied, the bodies stay on the Mac (WP5, route-table.ts).
    { test: /^503 GET \/api\/chat\/(history|stats|triage)$/, whys: ['conversation_bodies_need_mac'] },
    { test: new RegExp(`^503 GET /api/(v1/)?sessions/${ids.macSid}/`), whys: ['session_on_mac'] },
    { test: /^503 GET \/api\/usage\/sessions\/[^/]+$/, whys: ['usage_needs_mac'] },
  ]
}

/** The close codes of the console's /ws, from its own log line (`[ws] disconnected {code, ...}`). */
function watchWsCloses(page: Page): number[] {
  const codes: number[] = []
  page.on('console', (m) => {
    if (!m.text().startsWith('[ws] disconnected')) return
    const arg = m.args()[1]
    if (arg) void arg.jsonValue().then((v: { code?: number }) => { if (typeof v?.code === 'number') codes.push(v.code) }, () => {})
  })
  return codes
}

// A test that fails while the Mac sleeps must not hand the next one a sleeping Mac.
test.afterEach(async () => {
  const { asleep } = await control<{ asleep: boolean }>('GET', '/control/ready')
  if (asleep) await control('POST', '/control/wake')
})

test('the console reads its copies while the Mac sleeps, and comes back with no reload', async ({ page }) => {
  const { ids, hostTurn, note, letter } = await control<Ready>('GET', '/control/ready')
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const answers = watchAnswers(page)
  const wsCloses = watchWsCloses(page)

  await test.step('1. sign in through the tunnel; the Mac answers', async () => {
    await signIn(page)
    await expect(row(page, UNICODE_TITLE)).toBeVisible()
    await expect(page.getByTestId('away-line')).toHaveCount(0)
    // Forwarded to the Mac while it answers.
    expect((await pageGet(page, '/api/tasks')).headers['x-walnut-answered-via']).toBe('leader')
    // A reload from here on would drop this.
    await page.evaluate(() => { (window as unknown as { __replicaMarker?: string }).__replicaMarker = 'kept' })
    await shot(page, '1-awake')
  })

  await test.step('2. the Mac sleeps: the away line comes by itself; the spliced /ws was closed 4001', async () => {
    const t0 = Date.now()
    const slept = control('POST', '/control/sleep')
    const line = page.getByTestId('away-line')
    await expect(line).toBeVisible({ timeout: QUIET_MS + 5_000 })
    answers.state.awaySeen = true
    expect(Date.now() - t0).toBeLessThan(QUIET_MS + 5_000)
    // The replica sends the copies' age: the line says it.
    await expect(line).toContainText('Your Mac is away. This is the copy on devbox from')
    await expect(line).toContainText('Prompts on devbox are not pushed to your phone.')
    await expect.poll(() => wsCloses.includes(4001), { timeout: 15_000 }).toBe(true)
    await slept
  })

  await test.step('3a. the task rows from the copy, titles exact', async () => {
    await expect(row(page, 'Release plan')).toBeVisible({ timeout: 30_000 })
    await expect(row(page, UNICODE_TITLE)).toBeVisible()
    const tasks = await pageGet(page, '/api/tasks')
    expect(Number(tasks.headers['x-walnut-offline'])).toBeGreaterThan(0)
    expect(tasks.headers['x-walnut-offline-why']).toBe('away')
    await shot(page, '2-away-board')
  })

  await test.step('3b. an edit says "Needs your Mac" and changes nothing', async () => {
    if (isPhone()) {
      // A phone's row circle is a picture (phone-row-behavior.ts): the task is
      // renamed and completed in task detail, from the row's menu.
      await row(page, UNICODE_TITLE).getByRole('button', { name: 'More actions' }).click()
      await page.locator('.task-kebab-item').filter({ has: page.locator('span', { hasText: /^Details$/ }) }).first().click()
      const title = page.locator('.phone-detail-head .phone-detail-title')
      await expect(title).toHaveValue(UNICODE_TITLE)
      await title.fill(`${UNICODE_TITLE}, renamed away`)
      await title.press('Enter')
      await expect(page.getByText(NEEDS_MAC, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
      await expect(title).toHaveValue(UNICODE_TITLE)
      await shot(page, '3-away-rename-needs-mac')
      await page.getByTestId('phone-phase-row').click()
      await page.getByTestId('phone-phase-sheet').getByRole('option', { name: 'Complete' }).click()
      await page.getByTestId('phone-complete-confirm').getByRole('button', { name: 'Complete', exact: true }).click()
    } else {
      await row(page, UNICODE_TITLE).getByRole('button', { name: 'Mark complete' }).click()
    }
    await expect(page.getByText(NEEDS_MAC, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await shot(page, '3-away-needs-mac')
    await backToTasks(page)
    // Nothing changed: the row is still open under its own title, and so is the replica's copy.
    await page.waitForTimeout(1_500)
    await expect(row(page, UNICODE_TITLE)).toBeVisible()
    if (!isPhone()) await expect(row(page, UNICODE_TITLE).getByRole('button', { name: 'Mark complete' })).toBeVisible()
    const stores = await control<{ taskRows: Array<{ id: string; title: string; phase: string }> }>('GET', '/control/stores')
    const copied = stores.taskRows.find((t) => t.id === ids.other)
    expect(copied).toMatchObject({ title: UNICODE_TITLE })
    expect(copied!.phase).not.toBe('COMPLETE')
  })

  await test.step('3c. a Mac session keeps its composer, unable to send; its task\'s Board opens from the copy', async () => {
    await row(page, 'Release plan').locator('.todo-item-title').click()
    const panel = panelOf(page, ids.macSid)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expectSendBlocked(panel)
    await shot(page, '4-away-mac-session')
    // The Board: a view this page never loaded, read from the copy.
    const boardRead = nextGet(page, `/api/v1/tasks/${ids.board}/board`)
    if (isPhone()) {
      await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
      await page.getByTestId('phone-row-board').click()
    } else {
      await panel.getByTestId('session-board-chip').click()
    }
    const pane = page.getByTestId('task-board-pane')
    await expect(pane).toBeVisible({ timeout: 30_000 })
    const custom = pane.getByTestId('board-view-custom')
    await expect(custom).toBeVisible({ timeout: 15_000 })
    if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
    await expect(page.frameLocator('.task-board-frame').locator('#build')).toHaveText('Build: green', { timeout: 30_000 })
    const read = await boardRead
    expect(read.status()).toBe(200)
    expect(offlineOf(read)).toBeGreaterThan(0)
    await shot(page, '5-away-board-page')
  })
  await backToTasks(page)

  await test.step('3d. this host\'s session: its history is read on the host, and it keeps its composer', async () => {
    await row(page, UNICODE_TITLE).locator('.todo-item-title').click()
    const panel = panelOf(page, ids.hostSid)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByText(hostTurn.asked).first()).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByText(hostTurn.answered).first()).toBeVisible()
    await expect(panel.getByTestId('mac-away-composer')).toHaveCount(0)
    await expect(panel.locator('.session-panel-input textarea').first()).toBeVisible()
    await expect(panel.locator('.session-panel-input [data-send-blocked]')).toHaveCount(0)
    await shot(page, '6-away-host-session')
  })
  await backToTasks(page)

  await test.step('3e. the notes tree, a note and a notes search, from the copy', async () => {
    const tree = nextGet(page, '/api/notes-v2')
    await navTo(page, 'Notes')
    await expect(page.locator('.notes-tree-panel, .notes-tree-pane').first()).toBeVisible({ timeout: 30_000 })
    expect(offlineOf(await tree)).toBeGreaterThan(0)
    const folder = page.locator('.notes-tree-folder[data-node-path="Acme"]').first()
    await expect(folder).toBeVisible({ timeout: 30_000 })
    if (!((await folder.locator('.notes-tree-arrow').getAttribute('class')) ?? '').includes('expanded')) await folder.click()
    const content = nextGet(page, '/api/notes-v2/content/')
    await page.locator('.notes-tree-file', { hasText: note.name }).first().click()
    const opened = await content
    expect(opened.status()).toBe(200)
    expect(offlineOf(opened)).toBeGreaterThan(0)
    await expect(page.locator('.notes-editor-pane, .notes-editor').locator('.ProseMirror, .tiptap').first()).toContainText(note.text, { timeout: 15_000 })
    await shot(page, '7-away-note')
    if (isPhone()) {
      const back = page.locator('.phone-topbar').getByRole('button', { name: 'Back' })
      if (await back.isVisible()) await back.click()
    }
    const search = nextGet(page, '/api/notes-v2/search')
    await page.locator('.notes-search-input').first().fill('rollback drill')
    const found = await search
    expect(found.status()).toBe(200)
    expect(offlineOf(found)).toBeGreaterThan(0)
    await expect(page.locator('.notes-search-results .notes-search-result', { hasText: note.name }).first()).toBeVisible({ timeout: 15_000 })
    await shot(page, '8-away-notes-search')
    await page.locator('.notes-search-input').first().fill('')
  })

  await test.step('3f. the inbox, from the copy', async () => {
    if (isPhone()) await page.locator('.phone-topbar').getByTestId('phone-bell').click()
    else await page.getByRole('button', { name: 'Notifications' }).first().click()
    const center = page.locator('.notification-panel')
    await expect(center).toBeVisible({ timeout: 15_000 })
    await center.locator('.nfc-rail-btn', { hasText: 'Inbox' }).first().click()
    await expect(center.locator('.hib-row').filter({ hasText: letter.subject }).first()).toBeVisible({ timeout: 30_000 })
    await shot(page, '9-away-inbox')
    if (isPhone()) await page.locator('.phone-topbar').getByRole('button', { name: 'Back' }).click()
    else await page.keyboard.press('Escape')
    await expect(center).toHaveCount(0, { timeout: 15_000 })
  })

  await test.step('4. the Mac wakes: the line goes, no reload, no host problem, live data again', async () => {
    await navTo(page, 'Home')
    await expect(row(page, 'Release plan')).toBeVisible({ timeout: 30_000 })
    await control('POST', '/control/wake')
    await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 30_000 })
    expect(await page.evaluate(() => (window as unknown as { __replicaMarker?: string }).__replicaMarker)).toBe('kept')
    // The Mac reaches devbox on its link: no card says otherwise.
    await page.waitForTimeout(3_000)
    await expect(page.getByTestId('host-problems')).toHaveCount(0)
    // An edit on the Mac itself reaches this page on the spliced socket.
    const title = `Release plan, live ${Date.now().toString(36)}`
    await control('POST', '/control/mac-edit', { taskId: ids.board, title })
    await expect(row(page, title)).toBeVisible({ timeout: 30_000 })
    expect(await page.evaluate(() => (window as unknown as { __replicaMarker?: string }).__replicaMarker)).toBe('kept')
    await shot(page, '10-back')
    // Put the title back for the next project on this fixture.
    await control('POST', '/control/mac-edit', { taskId: ids.board, title: 'Release plan' })
    await expect(row(page, 'Release plan')).toBeVisible({ timeout: 30_000 })
  })

  await answers.settle()
  expect(pageErrors).toEqual([])
  expect(answers.other5xx).toEqual([])
  // No read is ever cut: a GET in flight at the flip is answered again from the copies.
  expect(answers.got504.filter((r) => r.method === 'GET')).toEqual([])
  // A write in flight at the flip may be cut (504, "Nothing was saved"); one sent away never is.
  expect(answers.got504.filter((r) => !r.beforeAway)).toEqual([])
  // The replica's refusals are the ones expected503 names (the console's writes, a
  // Mac session's reads, a budget read, what WP5 does not copy), nothing else: each
  // matches one expected refusal, and the two the steps made are there.
  const all = JSON.stringify(answers.why503)
  const refused = answers.why503.filter((r) => r.via === 'replica')
  const allowed = expected503(ids)
  expect(refused.filter((r) => !allowed.some((e) => e.test.test(r.path) && e.whys.includes(r.why))), all).toEqual([])
  expect(refused.some((r) => r.why === 'task_writes_need_mac' && !r.path.includes(' GET ')), all).toBe(true)
  expect(refused.some((r) => r.why === 'session_on_mac' && r.path.includes(' GET ')), all).toBe(true)
  // The Mac's own 503s (forwarded while it answers) are its budget reads only: the
  // seeded sessions have no budget on the Mac (its daemon never ran them, and this
  // host's daemon has no budget sidecar), so the Mac says budget_unavailable or
  // budget_needs_upgrade. Anything else the Mac refuses is a finding.
  expect(answers.why503.filter((r) => r.via !== 'replica' && !(/^503 GET \/api\/usage\/sessions\/[^/]+$/.test(r.path) && ['budget_unavailable', 'budget_needs_upgrade'].includes(r.why))), all).toEqual([])
  const cut = answers.got504.map((r) => r.what)
  if (cut.length) test.info().annotations.push({ type: 'cut-at-flip', description: cut.join(', ') })
})

test('a draft typed before the Mac sleeps survives the sleep and the wake, then sends', async ({ page }) => {
  const { ids } = await control<Ready>('GET', '/control/ready')
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await signIn(page)
  await row(page, 'Release plan').locator('.todo-item-title').click()
  const panel = panelOf(page, ids.macSid)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expectSendable(panel)
  const composer = panel.locator('.session-panel-input textarea').first()
  const draft = `A draft from ${test.info().project.name} \u00e9t\u00e9`
  await composer.click()
  await composer.fill(draft)
  // The same element through sleep and wake (no remount): a mark on the node itself.
  await composer.evaluate((el) => { (el as HTMLTextAreaElement & { __draftNode?: string }).__draftNode = 'kept' })
  await shot(page, 'd1-draft-typed')

  await control('POST', '/control/sleep')
  await expect(page.getByTestId('away-line')).toBeVisible({ timeout: QUIET_MS + 5_000 })
  await expectSendBlocked(panel)
  await expect(composer).toHaveValue(draft)
  expect(await composer.evaluate((el) => (el as HTMLTextAreaElement & { __draftNode?: string }).__draftNode)).toBe('kept')
  await shot(page, 'd2-draft-away')

  await control('POST', '/control/wake')
  await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 30_000 })
  await expectSendable(panel)
  await expect(composer).toHaveValue(draft)
  expect(await composer.evaluate((el) => (el as HTMLTextAreaElement & { __draftNode?: string }).__draftNode)).toBe('kept')
  await shot(page, 'd3-draft-back')

  // Sent: the person's words land first, the reply after them (the CLI thinks 300 ms).
  const mine = panel.locator('.session-msg-user').filter({ hasText: draft })
  const reply = panel.getByText(`echo: ${draft}`)
  await composer.press('Enter')
  await expect(mine.first()).toBeVisible({ timeout: 30_000 })
  await expect(reply.first()).toBeVisible({ timeout: 60_000 })
  const order = await page.evaluate(([a, b]) => {
    const user = [...document.querySelectorAll('.session-msg-user')].find((n) => n.textContent?.includes(a))
    const answer = [...document.querySelectorAll('.session-panel *')].find((n) => n.childElementCount === 0 && n.textContent?.includes(b))
    if (!user || !answer) return 'missing'
    return user.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING ? 'user-first' : 'reply-first'
  }, [draft, `echo: ${draft}`] as const)
  expect(order).toBe('user-first')
  await expect(panel.locator('.rich-app-building')).toHaveCount(0)
  await expect.poll(async () => (await pageGet(page, `/api/sessions/${ids.macSid}`)).json?.session?.process_status, { timeout: 60_000 }).toBe('idle')
  await shot(page, 'd4-draft-sent')
  expect(pageErrors).toEqual([])
})

/**
 * WP5: a page loaded while the Mac sleeps holds nothing the Mac answered (its
 * routines store, its config, its favorites and its layout are read at boot), so
 * what it shows is the replica's copies. The theme is taken out of this browser
 * first (it may hold the Mac's from the sign-in): only the prefs copy brings it back.
 */
test('a page loaded while the Mac sleeps shows Routines, Settings, its favorites and its layout from the copies', async ({ page }) => {
  const { ids, favorites, theme, note, routine, userName } = await control<Ready>('GET', '/control/ready')
  const pageErrors: string[] = []
  page.on('pageerror', (e) => { if (!/due to access control checks|Load failed/.test(e.message)) pageErrors.push(e.message) })
  const answers = watchAnswers(page)
  await signIn(page)
  await control('POST', '/control/sleep')
  await expect(page.getByTestId('away-line')).toBeVisible({ timeout: QUIET_MS + 5_000 })
  answers.state.awaySeen = true
  const rawTheme = (remove: boolean) => page.evaluate(([key, drop]) => {
    const raw = (Storage.prototype as unknown as Record<symbol, { get: Storage['getItem']; remove: Storage['removeItem'] } | undefined>)[Symbol.for('open-walnut.ui-prefs-sync.raw-storage')]
    if (!raw) throw new Error('ui-prefs-sync is not running on this page')
    if (drop) raw.remove.call(localStorage, key)
    return raw.get.call(localStorage, key)
  }, [theme.key, remove] as const)
  // Every GET the page loaded away makes, by path: the first answer of each.
  const reads = new Map<string, Response>()
  const keep = (r: Response) => {
    const url = new URL(r.url())
    if (r.request().method() === 'GET' && !reads.has(url.pathname)) reads.set(url.pathname, r)
  }
  const readOf = async (pathname: string) => {
    await expect.poll(() => reads.has(pathname), { timeout: 30_000, message: `GET ${pathname}` }).toBe(true)
    const r = reads.get(pathname)!
    expect([pathname, r.status()]).toEqual([pathname, 200])
    expect(offlineOf(r)).toBeGreaterThan(0)
    return r
  }
  const back = async () => {
    // A Settings pane and the Settings list are layers over a phone's page: Back leaves them.
    if (!isPhone()) return
    const menu = page.getByRole('button', { name: 'Menu', exact: true })
    for (let i = 0; i < 3 && !(await menu.isVisible()); i++) {
      await page.locator('.phone-topbar').getByRole('button', { name: 'Back' }).click()
      await page.waitForTimeout(400)
    }
    await expect(menu).toBeVisible({ timeout: 15_000 })
  }
  let failure: unknown = null
  try {
    expect(await rawTheme(true)).toBeNull()
    page.on('response', keep)
    await page.reload()
    await expect(page.getByTestId('away-line')).toBeVisible({ timeout: 30_000 })
    // The boot merge of the layout prefs and the favorites read: the replica's, from its copy.
    await readOf('/api/ui-prefs')
    await readOf('/api/favorites')
    // The layout: the Mac's theme, adopted before the first render (a view reads it
    // when it mounts: Settings shows it below; the page's own colours take it on the
    // next load, as they do for any window, ui-prefs-sync.ts).
    expect(await rawTheme(false)).toBe(theme.value)
    // The favorites: the Mac's star on its project.
    expect(favorites.projects).toContain('Acme')
    const header = page.locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name').filter({ hasText: /^Acme$/ }) }).first()
    await expect(header).toBeVisible({ timeout: 30_000 })
    const star = header.locator('.todo-group-fav-btn')
    await expect(star).toHaveAttribute('title', 'Unfavorite project')
    await expect(star).toHaveText('\u2605')
    await expect(star).toBeVisible()
    await shot(page, 'f1-away-loaded-favorite')

    // The Routines page: the Mac's routine, from the routines copy.
    await navTo(page, 'Routines')
    const card = page.locator('.routine-card').filter({ has: page.locator('.cron-job-name', { hasText: new RegExp(`^\\s*${escapeRe(routine.name)}\\s*$`) }) })
    await expect(card.first()).toBeVisible({ timeout: 30_000 })
    const listed = await (await readOf('/api/routines')).json() as { jobs?: Array<{ name?: string }> }
    expect(listed.jobs?.map((j) => j.name)).toContain(routine.name)
    await shot(page, 'f2-away-routines')

    // Settings: the Mac's values, from the config copy, and its layout pref.
    await navTo(page, 'Settings')
    await page.getByTestId('settings-nav-general').click()
    const name = page.locator('#settings-name')
    await expect(name).toHaveValue(userName, { timeout: 30_000 })
    const config = await (await readOf('/api/config')).json() as { config?: { user?: { name?: string } } }
    expect(config.config?.user?.name).toBe(userName)
    await expect(page.getByTestId(`settings-theme-${theme.value}`)).toHaveAttribute('aria-checked', 'true')
    // A save: refused with the reason in words, the text kept for the person, nothing written.
    const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/config', { timeout: 30_000 })
    await name.fill(`${userName} away`)
    await name.press('Enter')
    expect((await saved).status()).toBe(503)
    // The row's error sits right after the row (SettingsRow), as an alert.
    const nameError = page.locator('.settings-row:has(#settings-name) + .settings-row-error[role="alert"]')
    await expect(nameError).toHaveText(NEEDS_MAC_SETTINGS, { timeout: 15_000 })
    await expect(page.locator('.settings-row:has(#settings-name)')).toHaveAttribute('data-state', 'error')
    await expect(name).toHaveValue(`${userName} away`)
    await shot(page, 'f3-away-settings-needs-mac')
    // Escape puts the saved value back (the person gives up): nothing is left to save on the way out.
    await name.press('Escape')
    await expect(name).toHaveValue(userName)
    const held = JSON.stringify((await control<{ config: unknown }>('GET', '/control/stores')).config)
    expect(held).toContain(userName)
    expect(held).not.toContain(`${userName} away`)
    await back()

    // The notes bookmark: the Mac's favorite note, under Bookmarks.
    await navTo(page, 'Notes')
    const bookmark = page.locator('.notes-bookmarks-group .notes-bookmark-row', { hasText: note.name }).first()
    await expect(bookmark).toBeVisible({ timeout: 30_000 })
    expect(favorites.notes).toContain(note.path)
    await shot(page, 'f4-away-notes-bookmark')
  } catch (err) {
    failure = err
  }
  page.off('response', keep)
  // The Mac wakes either way (the next test needs it); a failure above is the one reported.
  const woke = await control('POST', '/control/wake').then(() => null, (err: unknown) => err)
  if (failure) {
    if (woke) test.info().annotations.push({ type: 'wake-failed', description: String(woke) })
    throw failure
  }
  if (woke) throw woke
  await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 30_000 })
  await answers.settle()
  expect(pageErrors).toEqual([])
  expect(answers.other5xx).toEqual([])
  expect(answers.got504.filter((r) => r.method === 'GET')).toEqual([])
  const all = JSON.stringify(answers.why503)
  const refused = answers.why503.filter((r) => r.via === 'replica')
  const allowed = expected503(ids)
  expect(refused.filter((r) => !allowed.some((e) => e.test.test(r.path) && e.whys.includes(r.why))), all).toEqual([])
  expect(refused.some((r) => r.why === 'config_writes_need_mac' && r.path === '503 PUT /api/config'), all).toBe(true)
})

/**
 * WP7 acceptance: with the Mac asleep, `/` through the tunnel loads in under 3 s,
 * worst of 5 loads (the board rows from the copy and the away line, what a
 * person waits for). A test's browser context is fresh, so it signs in once
 * with the Mac awake; the five loads after that keep the sign-in. With
 * REPLICA_APP=built the page and every asset come from the replica itself.
 */
test('with the Mac asleep, the console loads through the tunnel in under 3 s (worst of 5)', async ({ page }) => {
  await signIn(page)
  await control('POST', '/control/sleep')
  const errors: string[] = []
  // WebKit reports a fetch that a reload cancelled as a page error; that one is the browser's, not the app's.
  page.on('pageerror', (e) => { if (!/due to access control checks|Load failed/.test(e.message)) errors.push(e.message) })
  const failedAssets: string[] = []
  page.on('response', (r) => { if (r.status() >= 400 && /\/assets\//.test(new URL(r.url()).pathname)) failedAssets.push(`${r.status()} ${r.url()}`) })
  const loads: number[] = []
  try {
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      await page.reload()
      await expect(page.getByTestId('away-line')).toBeVisible({ timeout: 30_000 })
      await expect(row(page, 'Release plan')).toBeVisible({ timeout: 30_000 })
      loads.push(Date.now() - t0)
    }
    await shot(page, '11-away-reloaded')
  } finally {
    await control('POST', '/control/wake')
  }
  const { app } = await control<{ app: string }>('GET', '/control/ready')
  test.info().annotations.push({ type: 'away-load-ms', description: JSON.stringify({ app, loads, worst: Math.max(...loads) }) })
  process.stdout.write(`REPLICA_AWAY_LOADS ${test.info().project.name} ${JSON.stringify({ app, loads, worst: Math.max(...loads) })}\n`)
  expect(errors).toEqual([])
  expect(failedAssets).toEqual([])
  expect(Math.max(...loads)).toBeLessThan(3_000)
})
