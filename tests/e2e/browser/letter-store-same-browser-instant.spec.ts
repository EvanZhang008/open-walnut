/**
 * One browser, one letter store: pinning or reading a letter on ANY surface reaches
 * the others without waiting for the server.
 *
 * Regression guarded: the notification rail's Inbox and a session panel's Inbox tab
 * ran TWO parallel client stores (a private `useState` pair in useHumanInbox and a
 * module singleton in useSessionLetters), and the reader kept a THIRD copy of the
 * envelope. `pinned` had no WS echo AT ALL — the server's setPinned wrote to disk
 * and emitted nothing — so the only thing that ever reconciled the copies was a
 * debounced full re-GET fired by some UNRELATED letter event. Pinning in the rail
 * left the session tab showing "Pin", no glyph, and the old date order (pinned
 * sorts FIRST) until a reload.
 *
 * Two tests, because the two surfaces cannot be clicked at the same time (opening
 * a session's Inbox tab promotes the panel to fullscreen, which covers the bell,
 * and exiting fullscreen closes the tab):
 *
 *   1. SAME FRAME, both surfaces mounted: the reader on top of the rail list. The
 *      write is held at the network layer, so the list behind can only have learned
 *      from the shared store.
 *   2. THE REPORTED SYMPTOM: pin in the rail, then hop into the session's Inbox tab
 *      with every list re-read STALLED. The tab has no way to ask the server, so a
 *      pinned row there is proof the two surfaces share one store.
 *
 * Nothing is route-mocked for state: letters are created the way an agent creates
 * them (`POST /api/v1/human-inbox` + the caller-sid header the ops executor adds),
 * and the sender is a real quick-start session.
 */
import fs from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/letter-store-sync'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
/** Provenance header the ops executor sets (src/ops: CALLER_SID_HEADER). */
const CALLER_SID_HEADER = 'x-walnut-caller-sid'
/** One nonce per run: subjects are how every assertion below scopes itself. */
const NONCE = Date.now().toString(36)
const HOLD_MS = 3000
/** How long a same-frame update may take to reach the other surface. Far below
 *  HOLD_MS, so passing proves the update did not wait for the server. */
const INSTANT_MS = 700

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/**
 * A REAL session to be the letter's sender. quick-start with an EMPTY message is
 * an init-only spawn: the mock CLI boots and parks on its FIFO.
 */
async function startSession(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: '' },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const { sessionId } = await res.json() as { sessionId?: string }
  expect(sessionId, 'quick-start returned no sessionId').toBeTruthy()
  return sessionId as string
}

/** `POST /api/v1/human-inbox` — exactly what `walnut tools call human_inbox_send` hits. */
async function sendLetter(
  request: APIRequestContext,
  body: Record<string, unknown>,
  callerSid: string,
): Promise<string> {
  const res = await request.post('/api/v1/human-inbox', {
    data: body,
    headers: { [CALLER_SID_HEADER]: callerSid },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { id } = await res.json() as { id: string }
  return id
}

interface InboxGate {
  /** Hold every human-inbox request until this timestamp. */
  holdUntil: number
  /** Stall every LIST re-read from here on (writes still go through). */
  stallReads: boolean
  /** POST paths the server actually received. */
  writes: string[]
  /** List GETs the server actually answered. */
  reads: number
}

/**
 * Hold every human-inbox request for HOLD_MS from now, and forget the writes seen
 * so far.
 *
 * Both halves matter. The hold covers the debounced list re-read as well as the
 * write, so a peer spec's letter event landing mid-window cannot overwrite the
 * optimistic patch under assertion (and no WS echo can arrive either: the server
 * never sees the write until the window closes). The reset is because reaching
 * each UI state already sent a read POST of its own.
 */
function freezeInbox(gate: InboxGate): void {
  gate.writes.length = 0
  gate.holdUntil = Date.now() + HOLD_MS
}

async function routeInbox(page: Page): Promise<InboxGate> {
  const gate: InboxGate = { holdUntil: 0, stallReads: false, writes: [], reads: 0 }
  await page.route('**/api/v1/human-inbox**', async (route) => {
    const req = route.request()
    const isListRead = req.method() === 'GET' && new URL(req.url()).pathname.endsWith('/human-inbox')
    if (gate.stallReads && isListRead) {
      // Never answered: the store keeps whatever it already holds, so anything
      // the UI shows from here on came from memory and not from the server.
      await new Promise((r) => setTimeout(r, 60_000))
      await route.abort()
      return
    }
    const wait = gate.holdUntil - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    if (req.method() === 'POST') gate.writes.push(new URL(req.url()).pathname)
    if (isListRead) gate.reads += 1
    await route.continue()
  })
  return gate
}

/** Open the notification center and switch to its cross-session Inbox rail. */
async function openCenterInbox(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  await expect(panel.locator('.hib-toolbar')).toBeVisible()
  return panel
}

const rowFor = (host: Locator, subject: string): Locator =>
  host.locator('.hib-row').filter({ hasText: subject })

const moreMenu = (page: Page): Locator => page.locator('.task-kebab-menu:visible')

async function openMoreActions(panel: Locator): Promise<Locator> {
  await panel.getByRole('button', { name: 'More actions' }).click()
  const menu = moreMenu(panel.page())
  await expect(menu).toBeVisible({ timeout: 15_000 })
  return menu
}

async function closeMoreActions(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'More actions' }).click()
  await expect(moreMenu(panel.page())).toHaveCount(0)
}

const inboxItem = (menu: Locator): Locator =>
  menu.locator('.task-kebab-item').filter({ hasText: 'Inbox' })

// ── 1. Two surfaces mounted at once: the reader over the rail list ──

test('a pin taken in the reader reaches the rail list before the server answers', async ({ page, request }) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  const subject = `PW LETTER STORE reader ${NONCE}`
  const sid = await startSession(request)
  const letterId = await sendLetter(request, {
    subject,
    type: 'info',
    markdown: `## Nightly index rebuild\n\nFinished clean (${NONCE}).`,
    text: `Nightly index rebuild finished clean (${NONCE}).`,
  }, sid)

  const gate = await routeInbox(page)

  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })

  const center = await openCenterInbox(page)
  const railRow = rowFor(center, subject)
  await expect(railRow).toBeVisible({ timeout: 20_000 })
  await expect(railRow.getByRole('button', { name: 'Pin', exact: true })).toBeVisible()

  // The reader is its own portal ABOVE the panel, so both surfaces are mounted and
  // the top one is the clickable actor.
  await railRow.click()
  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 20_000 })
  const readerPin = reader.getByRole('button', { name: 'Pin', exact: true })
  await expect(readerPin).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-reader-over-rail-list.png` })

  freezeInbox(gate)
  await readerPin.click()

  // The rail row underneath: same frame, with the POST still on the wire.
  await expect(railRow.getByRole('button', { name: 'Unpin' })).toBeVisible({ timeout: INSTANT_MS })
  await expect(railRow).toHaveClass(/hib-pinned/, { timeout: INSTANT_MS })
  await expect(railRow.locator('.hib-pin')).toBeVisible()
  // …and the reader itself flipped to the opposite action, from the same store.
  await expect(reader.getByRole('button', { name: 'Unpin' })).toBeVisible()
  expect(gate.writes, 'the server has not even seen the pin POST yet').toEqual([])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-reader-pin-reached-rail-list.png` })

  // Release: the round-trip and its echo only CONFIRM.
  await expect.poll(() => gate.writes.length, { timeout: HOLD_MS * 4 }).toBeGreaterThanOrEqual(1)
  expect(gate.writes.some(p => p.endsWith(`/human-inbox/${letterId}/pin`))).toBe(true)
  await page.waitForTimeout(1500)
  await expect(railRow.getByRole('button', { name: 'Unpin' })).toBeVisible()
  await expect(railRow).toHaveClass(/hib-pinned/)
  const stored = await request.get(`/api/v1/human-inbox/${letterId}`)
  expect(((await stored.json()) as { letter: { pinned: boolean } }).letter.pinned).toBe(true)

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})

// ── 2. The reported symptom: rail → the session panel's Inbox tab ──

test('a pin taken in the rail is already on the session Inbox tab, with no list re-read possible', async ({ page, request }) => {
  // A real CLI spawn, the deep-link hop, and a stalled read lane.
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  const subject = `PW LETTER STORE tab ${NONCE}`
  const sid = await startSession(request)
  const letterId = await sendLetter(request, {
    subject,
    type: 'info',
    markdown: `## Backup volume\n\nAt 70% (${NONCE}).`,
    text: `Backup volume at 70% (${NONCE}).`,
  }, sid)

  const gate = await routeInbox(page)

  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })

  // ── Pin it in the rail, and let the write land for real ──
  const center = await openCenterInbox(page)
  const railRow = rowFor(center, subject)
  await expect(railRow).toBeVisible({ timeout: 20_000 })
  await railRow.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(railRow.getByRole('button', { name: 'Unpin' })).toBeVisible({ timeout: INSTANT_MS })
  await expect.poll(async () => {
    const res = await request.get(`/api/v1/human-inbox/${letterId}`)
    return ((await res.json()) as { letter: { pinned: boolean } }).letter.pinned
  }, { timeout: 20_000 }).toBe(true)

  // ── From here the session tab CANNOT ask the server what it missed ──
  gate.stallReads = true
  const readsBefore = gate.reads

  // The hop: rail row → reader → "Open session ↗" (real clicks only; the URL is
  // the transport, never a page.goto).
  await railRow.click()
  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 20_000 })
  await reader.getByRole('button', { name: 'Open session ↗' }).click()
  await expect(reader).toHaveCount(0, { timeout: 20_000 })

  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const pane = panel.locator('.session-inbox-pane')
  await expect(pane).toBeVisible({ timeout: 20_000 })
  await pane.getByRole('button', { name: '← Letters' }).click()

  // THE regression: this row used to say "Pin", with no glyph and in plain date
  // order, because the tab had its own copy of the list.
  const paneRow = rowFor(pane, subject)
  await expect(paneRow).toBeVisible({ timeout: 20_000 })
  await expect(paneRow.getByRole('button', { name: 'Unpin' })).toBeVisible({ timeout: 5_000 })
  await expect(paneRow).toHaveClass(/hib-pinned/)
  await expect(paneRow.locator('.hib-pin')).toBeVisible()
  expect(gate.reads, 'no list re-read answered — the tab read the shared store')
    .toBe(readsBefore)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-session-tab-already-pinned.png` })

  // ── And back the other way, same frame: the tab writes, and the Inbox entry in
  //    the ⋮ menu (a separate subscriber) follows before the route answers ──
  const menu = await openMoreActions(panel)
  const badge = inboxItem(menu).locator('.session-action-chip-count')
  await expect(badge).toHaveCount(0)
  await closeMoreActions(panel)

  freezeInbox(gate)
  await paneRow.getByRole('button', { name: 'Mark unread' }).click()

  // Straight back into the menu — that is the badge's only home now, and the write
  // is still on hold, so whatever it shows came from the shared store.
  await openMoreActions(panel)
  await expect(badge).toHaveText('1', { timeout: INSTANT_MS })
  await expect(paneRow).toHaveClass(/hib-unread/, { timeout: INSTANT_MS })
  await expect(pane.locator('.session-inbox-bar-sub')).toContainText('1 unread', { timeout: INSTANT_MS })
  expect(gate.writes, 'the unread POST is still held').toEqual([])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-tab-unread-moved-menu-badge.png` })
  await closeMoreActions(panel)

  await expect.poll(() => gate.writes.length, { timeout: HOLD_MS * 4 }).toBeGreaterThanOrEqual(1)
  await page.waitForTimeout(1500)
  await openMoreActions(panel)
  await expect(badge).toHaveText('1')
  await expect(paneRow).toHaveClass(/hib-unread/)

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})
