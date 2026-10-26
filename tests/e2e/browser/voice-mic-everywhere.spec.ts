/**
 * The composer's mic on every free-prose box (web/src/components/common/BoxMic.tsx).
 *
 * Each test reaches its box the way a user does (from '/', real clicks), then pins
 * the shape the user sees:
 *  - the box and its mic are both drawn, and the mic is the topmost element at its
 *    own centre (not clipped, not under another layer);
 *  - a `BoxMic` sits in the box's own row and never on top of the box;
 *  - a `MicField` mic sits inside the box's rect, and the box keeps room on its right
 *    (padding-right at least the mic's width, its content edge left of the mic), so
 *    typed text never runs under it.
 * Every check saves a cropped shot to /tmp/voice-mic-everywhere/<engine>-<name>.png.
 *
 * Two real dictation round trips run in Chromium only (a fake capture device, canned
 * engine answers, the same recipe as session-voice-selection.spec.ts): the inbox
 * letter reply box and the Board card composer. The words must land in that box and
 * nowhere else, a send must clear them, and a recording cut off by a send must stop
 * and post no more audio.
 *
 * The fixture server is shared: this file makes its own letters, tasks and sessions
 * under a per-run stamp, removes the tasks it made, and never saves a setting.
 */
import fs from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { stubSttStatus } from './voice-selection-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
/** Shots land here; VOICE_MIC_SHOTS moves them (a remote run keeps them under test-results). */
const SHOTS = process.env.VOICE_MIC_SHOTS ?? '/tmp/voice-mic-everywhere'
// Both engines may load this file close together: the pid keeps their seeds apart.
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`

/** What the mocked engine hears: the final text, and the live preview of it. */
const DICTATED = 'why does phase two matter'
const DRAFTED = 'why does phase'
/** The stop's tail pass rides the draft route, so the landed text may be either. */
const ANY_WORDS = /why does phase/

/** A fake capture device for the dictation tests. File level, because Playwright
 *  refuses launchOptions inside a describe; WebKit ignores these Chromium args. The
 *  microphone PERMISSION is granted per test: WebKit rejects that name outright. */
test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
})

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true })
})

// ── Geometry ────────────────────────────────────────────────────────────────

interface Rect { x: number; y: number; width: number; height: number }

async function rectOf(loc: Locator, what: string): Promise<Rect> {
  const r = await loc.boundingBox()
  expect(r, `${what} has no box on screen`).not.toBeNull()
  return r as Rect
}

function union(...rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

function expectInside(inner: Rect, outer: Rect, what: string): void {
  const tol = 1
  expect(inner.x, `${what}: left edge`).toBeGreaterThanOrEqual(outer.x - tol)
  expect(inner.y, `${what}: top edge`).toBeGreaterThanOrEqual(outer.y - tol)
  expect(inner.x + inner.width, `${what}: right edge`).toBeLessThanOrEqual(outer.x + outer.width + tol)
  expect(inner.y + inner.height, `${what}: bottom edge`).toBeLessThanOrEqual(outer.y + outer.height + tol)
}

function overlaps(a: Rect, b: Rect): boolean {
  const e = 0.5
  return a.x < b.x + b.width - e && b.x < a.x + a.width - e && a.y < b.y + b.height - e && b.y < a.y + a.height - e
}

/** The mic is what a press at its centre would hit: not clipped, not under a layer. */
async function expectMicOnTop(mic: Locator, what: string): Promise<void> {
  const hit = await mic.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return top ? (el === top || el.contains(top) ? 'mic' : `${top.tagName.toLowerCase()}.${String(top.className)}`) : 'nothing'
  })
  expect(hit, `${what}: a press on the mic lands on the mic`).toBe('mic')
}

/** A crop around the box and its mic, clamped to the viewport. */
async function crop(page: Page, name: string, around: Rect): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 }
  const pad = 24
  const x = Math.max(0, Math.floor(around.x - pad))
  const y = Math.max(0, Math.floor(around.y - pad))
  const right = Math.min(vp.width, Math.ceil(around.x + around.width + pad))
  const bottom = Math.min(vp.height, Math.ceil(around.y + around.height + pad))
  const engine = test.info().project.name
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, clip: { x, y, width: right - x, height: bottom - y } })
}

/** A BoxMic beside its box: drawn, inside the box's row, never on top of the box. */
async function expectBoxMic(page: Page, name: string, box: Locator, row: Locator): Promise<void> {
  const mic = row.locator('.box-mic .mic-btn')
  await expect(box, `${name}: the box`).toBeVisible()
  await expect(mic, `${name}: the mic`).toHaveCount(1)
  await expect(mic, `${name}: the mic`).toBeVisible()
  await mic.scrollIntoViewIfNeeded()
  const b = await rectOf(box, `${name} box`)
  const m = await rectOf(mic, `${name} mic`)
  const r = await rectOf(row, `${name} row`)
  expectInside(m, r, `${name}: the mic sits in the box's row`)
  expect(overlaps(m, b), `${name}: the mic is drawn on top of the box`).toBe(false)
  await expectMicOnTop(mic, name)
  await crop(page, name, union(b, m, r))
}

/** A MicField: the mic inside the box's right edge, and the text kept clear of it. */
async function expectMicField(page: Page, name: string, field: Locator): Promise<void> {
  const box = field.locator(':scope > textarea, :scope > input').first()
  const mic = field.locator('.mic-field-mic .mic-btn')
  await expect(box, `${name}: the box`).toBeVisible()
  await expect(mic, `${name}: the mic`).toHaveCount(1)
  await expect(mic, `${name}: the mic`).toBeVisible()
  await mic.scrollIntoViewIfNeeded()
  const b = await rectOf(box, `${name} box`)
  const m = await rectOf(mic, `${name} mic`)
  expectInside(m, b, `${name}: the mic sits inside the box`)
  const style = await box.evaluate((el) => {
    const s = getComputedStyle(el)
    return { padRight: parseFloat(s.paddingRight), borderRight: parseFloat(s.borderRightWidth) }
  })
  expect(style.padRight, `${name}: padding-right ${style.padRight}px vs mic ${m.width}px`).toBeGreaterThanOrEqual(m.width)
  const contentRight = b.x + b.width - style.borderRight - style.padRight
  expect(contentRight, `${name}: typed text runs under the mic`).toBeLessThanOrEqual(m.x + 0.5)
  await expectMicOnTop(mic, name)
  await crop(page, name, union(b, m))
}

// ── Navigation ──────────────────────────────────────────────────────────────

/** The one direct load every test makes; everything after it is a click. */
async function home(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await stubSttStatus(page)
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 60_000 })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openSettings(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
}

/** Agents, Skills and Commands are links out of Settings; the first click can land
 *  before the page is ready, so it is retried until the URL moves. */
async function settingsLinkTo(page: Page, id: string, url: string): Promise<void> {
  const link = page.getByTestId(`settings-nav-${id}`)
  await expect(link).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => {
    if (!page.url().includes(url)) await link.click({ timeout: 5000 }).catch(() => undefined)
    return page.url()
  }, { timeout: 30_000 }).toContain(url)
}

async function settingsPane(page: Page, id: string): Promise<Locator> {
  const item = page.getByTestId(`settings-nav-${id}`)
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  const section = page.locator(`[id="${id}"].settings-section`)
  await expect(section).toBeVisible({ timeout: 20_000 })
  return section
}

// ── Seeding ─────────────────────────────────────────────────────────────────

async function post<T>(request: APIRequestContext, url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request.post(url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function put(request: APIRequestContext, url: string, data: unknown, headers?: Record<string, string>): Promise<void> {
  const res = await request.put(url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true)
}

async function createTask(request: APIRequestContext, made: string[], body: Record<string, unknown>): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { source: 'local', pinned: false, ...body })
  made.push(task.id)
  return task.id
}

async function startSession(request: APIRequestContext, cwd: string, taskId: string, message: string): Promise<string> {
  const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message, taskId })
  return sessionId
}

async function removeTasks(request: APIRequestContext, made: string[]): Promise<void> {
  for (const id of [...made].reverse()) {
    const got = await request.get(`/api/tasks/${id}`).catch(() => null)
    const task = got?.ok() ? ((await got.json()) as { task?: { session_id?: string } }).task : undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } }).catch(() => undefined)
    await request.delete(`/api/v1/tasks/${id}/board`).catch(() => undefined)
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
}

/** A letter the way an agent sends one (`human_inbox_send`). */
async function sendLetter(request: APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const res = await request.post('/api/v1/human-inbox', { data: body })
  expect(res.status(), await res.text()).toBe(201)
}

/** Bell, Inbox, the letter's row: the reader. */
async function openLetter(page: Page, subject: string): Promise<Locator> {
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  await expect(panel.locator('.nfc-rail-btn', { hasText: 'Inbox' })).toHaveAttribute('aria-current', 'true')
  const row = panel.locator('.hib-row').filter({ hasText: subject })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.locator('.hib-subject').click()
  const reader = page.locator('.hib-reader')
  await expect(reader.locator('.hib-reader-subject')).toHaveText(subject)
  return reader
}

// ── Dictation ───────────────────────────────────────────────────────────────

/** Canned words for both engine lanes, answered at once; returns the posts seen, so
 *  a test can prove the recorder really sent audio (and later that it stopped). */
async function stubDictation(page: Page): Promise<{ transcribe: string[]; draft: string[] }> {
  const seen = { transcribe: [] as string[], draft: [] as string[] }
  await page.route('**/api/stt/transcribe', async (route) => {
    seen.transcribe.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DICTATED, durationMs: 120 }) })
  })
  await page.route('**/api/stt/draft', async (route) => {
    seen.draft.push(route.request().url())
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: DRAFTED, durationMs: 90 }) })
  })
  return seen
}

/** Every text box on the page that holds the dictated words, by its class. */
function boxesHoldingWords(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input')]
    .filter((el) => /why does phase/.test(el.value))
    .map((el) => el.className || el.tagName.toLowerCase()))
}

/** Record for a beat and stop; the words land in `box`, and only there. */
async function dictateInto(page: Page, box: Locator, mic: Locator, boxClass: string, seen: { transcribe: string[]; draft: string[] }): Promise<void> {
  await mic.click()
  await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await page.waitForTimeout(1200)
  await mic.click()
  await expect(box).toHaveValue(ANY_WORDS, { timeout: 30_000 })
  await expect(mic).not.toHaveClass(/mic-recording/, { timeout: 15_000 })
  expect(seen.transcribe.length + seen.draft.length, 'the recorder posted audio').toBeGreaterThan(0)
  expect(await boxesHoldingWords(page), 'the words landed in this box and no other').toEqual([boxClass])
}

/** A recording still running when the send goes: the send takes the typed text, the
 *  recording stops, and no more audio is posted. */
async function sendCutsRecording(
  page: Page, box: Locator, mic: Locator, send: () => Promise<void>, seen: { transcribe: string[]; draft: string[] },
): Promise<void> {
  await box.fill(`sent while recording ${STAMP}`)
  await mic.click()
  await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await page.waitForTimeout(500)
  await send()
  await expect(box).toHaveValue('', { timeout: 20_000 })
  await expect(page.locator('.mic-recording')).toHaveCount(0, { timeout: 10_000 })
  const posts = seen.transcribe.length + seen.draft.length
  await page.waitForTimeout(5000)
  expect(seen.transcribe.length + seen.draft.length, 'no audio posted after the send cut the recording').toBe(posts)
  await expect(box).toHaveValue('')
  expect(await boxesHoldingWords(page), 'no late words landed anywhere').toEqual([])
}

// ── Inbox ───────────────────────────────────────────────────────────────────

test.describe('Inbox letter', () => {
  test('the reply box has the mic in its row', async ({ page, request }) => {
    test.setTimeout(120_000)
    const subject = `Voice mic reply ${STAMP}`
    await sendLetter(request, { subject, type: 'info', markdown: 'A short status note.', text: 'A short status note.' })
    await home(page)
    const reader = await openLetter(page, subject)
    await expectBoxMic(page, 'inbox-reply', reader.locator('.hib-composer-input'), reader.locator('.hib-composer'))
  })

  test('the optional note beside a choice has the mic inside it', async ({ page, request }) => {
    test.setTimeout(120_000)
    const subject = `Voice mic choice ${STAMP}`
    await sendLetter(request, {
      subject, type: 'action_required', markdown: 'Pick one.', text: 'Pick one.',
      actions: [
        { id: 'ship', label: 'Ship it now', description: 'Roll out tonight' },
        { id: 'hold', label: 'Hold for review', description: 'Wait for a second look' },
      ],
    })
    await home(page)
    const reader = await openLetter(page, subject)
    const field = reader.locator('.hib-actions .mic-field').filter({ has: page.locator('.hib-freetext') })
    await expect(field.locator('.hib-freetext')).toHaveAttribute('placeholder', 'Optional note to send with your choice')
    await expectMicField(page, 'inbox-choice-note', field)
  })

  test('dictation into the reply box lands there, a send clears it, a send mid-recording stops it', async ({ page, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs a fake audio capture device')
    test.setTimeout(180_000)
    await page.context().grantPermissions(['microphone'])
    const seen = await stubDictation(page)
    const subject = `Voice mic dictation ${STAMP}`
    await sendLetter(request, { subject, type: 'info', markdown: 'Dictate a reply.', text: 'Dictate a reply.' })
    await home(page)
    const reader = await openLetter(page, subject)
    const box = reader.locator('.hib-composer-input')
    const mic = reader.locator('.hib-composer .box-mic .mic-btn')
    await dictateInto(page, box, mic, 'hib-composer-input', seen)
    await crop(page, 'dictation-inbox-landed', union(await rectOf(box, 'reply box'), await rectOf(mic, 'reply mic')))
    const words = await box.inputValue()
    await reader.locator('.hib-send-btn').click()
    await expect(box).toHaveValue('', { timeout: 20_000 })
    await expect(reader.locator('.hib-thread')).toContainText(words, { timeout: 20_000 })
    await sendCutsRecording(page, box, mic, () => reader.locator('.hib-send-btn').click(), seen)
    await crop(page, 'dictation-inbox-after-send', await rectOf(reader.locator('.hib-composer'), 'reply row'))
  })
})

// ── Board: project card, kanban composer, kanban summary ────────────────────

test.describe('Board', () => {
  const made: string[] = []
  const seed = { project: '', leader: '', leaderSid: '', worker: '', workerSid: '' }
  const AREA = 'voice-area'

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000)
    const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
    const cwd = `${fixtureRoot}/projects/walnut`
    seed.project = `Voice mic board ${STAMP}`
    seed.leader = await createTask(request, made, { title: `Voice mic lead ${STAMP}`, project: seed.project })
    seed.leaderSid = await startSession(request, cwd, seed.leader, 'snapshot-clean-turn:Lead ready')
    seed.worker = await createTask(request, made, { title: `Voice mic worker ${STAMP}`, project: seed.project, parent_task_id: seed.leader })
    seed.workerSid = await startSession(request, cwd, seed.worker, 'snapshot-clean-turn:Worker ready')
    const lead = { 'x-walnut-caller-sid': seed.leaderSid }
    // The leader's first card write makes the board file; a project needs one.
    await put(request, `/api/v1/tasks/${seed.leader}/board/cards/${seed.worker}`, { summary: 'Checking the export window.' }, lead)
    await put(request, `/api/v1/tasks/${seed.leader}/board/projects/${AREA}`, { title: 'Export lag', status: 'wip', tasks: [seed.worker] }, lead)
  })

  test.afterAll(async ({ request }) => {
    await removeTasks(request, made)
  })

  /** The leader's row, its session panel, its Board chip. */
  async function openBoard(page: Page): Promise<{ pane: Locator; panel: Locator }> {
    await presetPanelView(page, { section: 'all', project: seed.project })
    await home(page)
    const row = page.locator(`.todo-panel-item[data-task-id="${seed.leader}"]`)
    await expect(row).toBeVisible({ timeout: 90_000 })
    await row.locator('.todo-item-title').click()
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${seed.leaderSid}"]`)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await panel.getByTestId('session-board-chip').click()
    const pane = page.getByTestId('task-board-pane')
    await expect(pane.getByTestId('board-view-toggle')).toBeVisible({ timeout: 30_000 })
    return { pane, panel }
  }

  async function openAsk(pane: Locator): Promise<Locator> {
    await expect(pane.getByTestId('board-view-projects')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
    const card = pane.locator(`[data-testid="board-card"][data-card-id="${AREA}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.getByTestId('board-card-ask').click()
    const composer = card.getByTestId('board-card-composer')
    await expect(composer.locator('textarea')).toBeFocused()
    return composer
  }

  async function cardsView(pane: Locator): Promise<Locator> {
    await pane.getByTestId('board-view-cards').click()
    await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
    const card = pane.locator(`[data-testid="kanban-card"][data-task-id="${seed.worker}"]`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    return card
  }

  test('the project card "Ask a question" composer has the mic in its row', async ({ page }) => {
    test.setTimeout(180_000)
    const { pane } = await openBoard(page)
    const composer = await openAsk(pane)
    await expectBoxMic(page, 'board-card-ask', composer.locator('textarea'), composer)
  })

  test('the kanban card composer (key m) has the mic in its row', async ({ page }) => {
    test.setTimeout(180_000)
    const { pane } = await openBoard(page)
    const card = await cardsView(pane)
    await card.focus()
    await page.keyboard.press('m')
    const composer = card.getByTestId('kanban-card-composer')
    const input = composer.getByTestId('kanban-card-composer-input')
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expectBoxMic(page, 'kanban-composer', input, composer.locator('.kanban-composer-row'))
    await input.press('Escape')
    await expect(input).toHaveCount(0)
  })

  test('the kanban "Edit summary" box has the mic in its foot', async ({ page }) => {
    test.setTimeout(180_000)
    const { pane } = await openBoard(page)
    const card = await cardsView(pane)
    await card.hover()
    await card.getByTestId('kanban-card-more').click()
    await page.getByTestId('kanban-card-menu-summary').click()
    const editor = card.getByTestId('kanban-card-summary-editor')
    const input = editor.getByTestId('kanban-card-summary-input')
    await expect(input).toBeFocused({ timeout: 15_000 })
    await expectBoxMic(page, 'kanban-summary', input, editor)
    await input.press('Escape')
    await expect(editor).toHaveCount(0)
  })

  test('dictation into the card composer lands there, a send clears it, a send mid-recording stops it', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs a fake audio capture device')
    test.setTimeout(240_000)
    await page.context().grantPermissions(['microphone'])
    const seen = await stubDictation(page)
    const { pane, panel } = await openBoard(page)
    const composer = await openAsk(pane)
    const box = composer.locator('textarea')
    const mic = composer.locator('.box-mic .mic-btn')
    await dictateInto(page, box, mic, 'bpc-composer-input', seen)
    await expect(panel.locator('.chat-input-textarea').first(), 'the session composer stays empty').toHaveValue('')
    await crop(page, 'dictation-board-landed', await rectOf(composer, 'card composer'))
    const card = pane.locator(`[data-testid="board-card"][data-card-id="${AREA}"]`)
    await composer.getByTestId('board-card-send').click()
    await expect(box).toHaveValue('', { timeout: 20_000 })
    await expect(card.getByTestId('board-card-message').first()).toBeVisible({ timeout: 20_000 })
    // The thread now has a message, so the composer stays open as its reply box.
    const reply = card.getByTestId('board-card-composer')
    await expect(reply).toBeVisible()
    await sendCutsRecording(page, reply.locator('textarea'), reply.locator('.box-mic .mic-btn'),
      () => reply.getByTestId('board-card-send').click(), seen)
    await expect(panel.locator('.chat-input-textarea').first()).toHaveValue('')
    await crop(page, 'dictation-board-after-send', await rectOf(card, 'project card'))
  })
})

// ── Org page ────────────────────────────────────────────────────────────────

test.describe('Org page', () => {
  const made: string[] = []
  const project = `Voice mic org ${STAMP}`

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000)
    const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
    await createTask(request, made, { title: `Voice mic org work ${STAMP}`, project })
    const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: project })
    made.push(contact.task.id)
    await startSession(request, `${fixtureRoot}/projects/walnut`, contact.task.id, `Org lead ready ${STAMP}`)
    await put(request, `/api/v1/tasks/${contact.task.id}/board`, { html: `<h1>Org</h1><p>Voice mic board ${STAMP}</p>` })
  })

  test.afterAll(async ({ request }) => {
    await removeTasks(request, made)
  })

  test('the composer to a lead has the mic in its row', async ({ page }) => {
    test.setTimeout(120_000)
    await home(page)
    await page.getByTestId('sidebar-org').click()
    await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click()
    const detail = page.getByTestId('org-detail')
    await detail.getByTestId('org-tab-board').click()
    const composer = detail.getByTestId('org-composer')
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await expectBoxMic(page, 'org-composer', composer.locator('textarea'), composer)
  })
})

// ── Tasks ───────────────────────────────────────────────────────────────────

test.describe('Tasks', () => {
  const made: string[] = []

  test.afterAll(async ({ request }) => {
    await removeTasks(request, made)
  })

  async function openTasksPage(page: Page): Promise<void> {
    await home(page)
    await expandSidebar(page)
    await page.getByTestId('sidebar-core-app-tasks').click()
    await expect(page.getByTestId('tasks-table')).toBeVisible({ timeout: 30_000 })
  }

  test('the task page "Add to note..." input has the mic in its row', async ({ page, request }) => {
    test.setTimeout(120_000)
    const title = `Voice mic detail ${STAMP}`
    const id = await createTask(request, made, { title })
    await openTasksPage(page)
    await page.locator('.tp-search').fill(title)
    await page.locator(`.tp-row[data-task-id="${id}"] .tp-row-title`).click()
    await expect(page.locator('.tdv2-title')).toHaveText(title, { timeout: 30_000 })
    const input = page.locator('.tdv2-main').getByPlaceholder('Add to note...')
    await expectBoxMic(page, 'task-detail-add-note', input, input.locator('xpath=..'))
  })

  test('the "+ Task" form has the mic beside its title and its note', async ({ page }) => {
    test.setTimeout(120_000)
    await openTasksPage(page)
    await page.locator('.tp-newtask-btn').click()
    const form = page.locator('form.modal.card')
    await expect(form).toBeVisible()
    const title = form.locator('#task-title')
    const note = form.locator('#task-note')
    await expectBoxMic(page, 'task-form-title', title, title.locator('xpath=..'))
    await expectBoxMic(page, 'task-form-note', note, note.locator('xpath=..'))
    await form.getByRole('button', { name: 'Cancel' }).click()
    await expect(form).toHaveCount(0)
  })

  test('the calendar quick create sentence has the mic inside it', async ({ page }) => {
    test.setTimeout(120_000)
    await page.addInitScript(() => localStorage.setItem('open-walnut-calendar-grid-settings', JSON.stringify({ zoom: 1, fullDay: true })))
    await home(page)
    await expandSidebar(page)
    await page.locator('a[href="/calendar"]').first().click()
    await expect(page.locator('.cal-toolbar')).toBeVisible({ timeout: 30_000 })
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const hour = 14
    await page.locator('.cal-grid-scroll').evaluate((el, h) => { el.scrollTop = h * 48 - el.clientHeight / 2 }, hour)
    const col = await rectOf(page.locator(`.cal-day-col[data-day="${today}"]`), 'today column')
    await page.mouse.click(col.x + col.width / 2, col.y + hour * 48 + 1)
    const composer = page.locator('.cal-create-popover .quick-task-composer')
    await expect(composer).toBeVisible()
    await expectMicField(page, 'calendar-quick-create', composer.locator('.qtc-mic-field'))
  })
})

// ── Routines ────────────────────────────────────────────────────────────────

test.describe('Routines', () => {
  async function openRoutines(page: Page): Promise<Locator> {
    await home(page)
    await expandSidebar(page)
    await page.getByTestId('sidebar-core-app-routines').click()
    await expect(page.locator('.page-title')).toContainText('Routines', { timeout: 30_000 })
    return page.locator('.routines-view:not(.routines-view-compact)')
  }

  test('the routine composer has the mic inside it', async ({ page }) => {
    test.setTimeout(120_000)
    const view = await openRoutines(page)
    await expect(view.getByPlaceholder('What do you want automated?')).toBeVisible()
    await expectMicField(page, 'routine-composer', view.locator('.routine-composer .mic-field'))
  })

  test('"Build it myself": Description has the mic inside it, Instructions in its foot', async ({ page }) => {
    test.setTimeout(120_000)
    await openRoutines(page)
    await page.getByRole('button', { name: 'Build it myself' }).click()
    const form = page.locator('.routine-modal')
    await expect(form).toBeVisible()
    await expectMicField(page, 'routine-description', form.locator('.mic-field').filter({ has: page.locator('#routine-description') }))
    const instructions = form.locator('#routine-f-instructions')
    await expectBoxMic(page, 'routine-instructions', instructions, form.locator('.routine-instructions-box'))
    await form.getByRole('button', { name: 'Cancel' }).click()
    await expect(form).toHaveCount(0)
  })
})

// ── Settings ────────────────────────────────────────────────────────────────

test.describe('Settings', () => {
  test('the Heartbeat checklist has the mic inside it', async ({ page }) => {
    test.setTimeout(120_000)
    await home(page)
    await openSettings(page)
    const section = await settingsPane(page, 'heartbeat')
    // Only looked at, never focused: the checklist saves on blur.
    await expectMicField(page, 'settings-heartbeat', section.locator('.mic-field').filter({ has: page.locator('#heartbeat-editor') }))
  })

  test('a skill\'s content has the mic inside it', async ({ page }) => {
    test.setTimeout(120_000)
    await home(page)
    await openSettings(page)
    await settingsLinkTo(page, 'skills', '/skills')
    await expect(page.locator('.skills-page')).toBeVisible({ timeout: 30_000 })
    await page.locator('.skill-card').filter({ hasText: 'walnut-routines' }).first().click()
    const field = page.locator('.mic-field').filter({ has: page.locator('.skill-detail-textarea') })
    await expect(field.locator('.skill-detail-textarea')).not.toHaveValue('', { timeout: 20_000 })
    // Looked at only: a save would write a shipped skill.
    await expectMicField(page, 'skill-content', field)
  })

  test('a new agent\'s system prompt has the mic inside it', async ({ page }) => {
    test.setTimeout(120_000)
    await home(page)
    await openSettings(page)
    await settingsLinkTo(page, 'agents', '/agents')
    await expect(page.locator('.page-title')).toContainText('Agents', { timeout: 20_000 })
    await page.getByRole('button', { name: '+ New Agent' }).click()
    const form = page.locator('.agent-form')
    await expect(form).toBeVisible()
    await expectMicField(page, 'agent-system-prompt', form.locator('.mic-field').filter({ has: page.locator('#agent-prompt') }))
  })

  test('a new command\'s content has the mic inside it', async ({ page }) => {
    test.setTimeout(120_000)
    await home(page)
    await openSettings(page)
    await settingsLinkTo(page, 'commands', '/commands')
    await expect(page.locator('.page-title')).toContainText('Commands', { timeout: 20_000 })
    await page.getByRole('button', { name: '+ New Command' }).click()
    const form = page.locator('form.cmd-form')
    await expect(form).toBeVisible()
    await expectMicField(page, 'command-content', form.locator('.mic-field').filter({ has: page.locator('#cmd-content') }))
  })

  test('"Build a plugin" has the mic inside its describe box', async ({ page }) => {
    test.setTimeout(120_000)
    await home(page)
    await openSettings(page)
    await page.getByTestId('settings-nav-plugin-store').click()
    // Settings' Plugins entry either holds the card itself, or (once plugins moved to
    // the Apps page) links to /apps, whose manual path leads to the card's own page.
    const card = page.getByTestId('build-plugin-card')
    const apps = page.getByTestId('apps-make-card')
    await expect(card.or(apps)).toBeVisible({ timeout: 30_000 })
    if (await apps.isVisible()) {
      // The Apps page's own one-sentence box has the mic in its row, before Build it.
      const ask = apps.getByTestId('build-plugin-request')
      await expect(ask).toBeVisible()
      const askMic = apps.locator('.apps-make-ask .box-mic .mic-btn')
      await expect(askMic).toBeVisible()
      const [askBox, micBox, goBox] = await Promise.all([ask.boundingBox(), askMic.boundingBox(), apps.getByTestId('build-plugin-start').boundingBox()])
      expect(micBox!.x, 'the mic sits right of the box').toBeGreaterThanOrEqual(askBox!.x + askBox!.width - 1)
      expect(micBox!.x + micBox!.width, 'and left of Build it').toBeLessThanOrEqual(goBox!.x + 1)
      await apps.locator('.apps-make-ask').scrollIntoViewIfNeeded()
      await crop(page, 'apps-make-describe', await rectOf(apps.locator('.apps-make-ask'), 'apps make form'))
      await apps.getByTestId('apps-make-manual').locator('summary').click()
      await apps.getByTestId('build-plugin-guide').click()
      await expect(page.getByTestId('create-plugin-page')).toBeVisible({ timeout: 30_000 })
    }
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expectMicField(page, 'build-plugin', card.locator('.mic-field').filter({ has: page.getByTestId('build-plugin-request') }))
  })
})
