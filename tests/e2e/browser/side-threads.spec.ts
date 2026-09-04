/**
 * Playwright browser test: side THREADS — the "btw" drawer as a multi-turn mini-chat.
 *
 * What it pins (each is a real regression the unit tier can't see):
 *   - opening the drawer fires the standby prewarm and refreshes the thread list
 *   - asking creates a thread chip AND mounts that thread's own conversation,
 *     whose answer STREAMS in (the body is a real SessionChatHistory on the
 *     thread's session id — the whole point of the fork design)
 *   - a follow-up goes to the THREAD session, not the parent
 *   - chips switch which conversation is mounted, and only ONE is mounted
 *   - "Inject to chat" flattens the thread's Q&A into the MAIN composer via the
 *     prefill driver (and reveals it), which is what makes a side thread useful
 *   - promote shows the ✓task badge; the chip × and the actions-row button ARCHIVE
 *     (the row survives, moves to a collapsed shelf, opens read-only, restores),
 *     and permanent delete exists only inside that shelf
 *   - a 409 `fork_unsupported` degrades to an inline notice, not a dead drawer
 *
 * ── What is REAL here vs stubbed, and why ────────────────────────────────────
 * The five `/side-threads*` endpoints are FULFILLED BY THE TEST. That is not a
 * shortcut around the frontend: it is forced by the fixture. A side thread is a
 * hidden `--fork-session` spawn, and `tests/providers/mock-claude.mjs` does not
 * know `--fork-session` / `--resume-session-at` — its arg loop treats the unknown
 * flag as the user MESSAGE, so a real fork under the fixture answers
 * "I processed your message: --fork-session" and then EXITS (no live hidden
 * session at all). `draft-session-seeds.spec.ts:409` stubs the fork route for the
 * same reason.
 *
 * So the stub plays the backend's part, and hands the drawer the id of a session
 * that is REAL: the create handler spawns one through `quick-start` with the
 * QUESTION as its first message — which is exactly the shape the real fork takes
 * (`side-thread-manager.createThread` → `forkSideThreadSession(..., { message:
 * question })`), minus the `--fork-session` flag. Everything the frontend owns
 * therefore runs unmocked: the thread body's own stream subscription, history,
 * absorption, the answer rendering, and the send hook addressing the THREAD
 * session id.
 *
 * (Why not an empty-message init-only spawn, which parks on its FIFO? Under this
 * fixture it does not park: walnut appends `--permission-prompt-tool stdio`, the
 * mock's arg loop treats the unknown flag's VALUE as the user message, and the
 * spawn runs a bogus "stdio" turn and exits. Observed, not assumed.)
 *
 * BLOCKED (deliberately not asserted): that the thread session really is a FORK
 * of the parent (shared prompt-cache prefix, parent transcript visible to the
 * thread). That needs `--fork-session` support in mock-claude.mjs; until then it
 * belongs to the server tier / the live tier.
 */
import fs from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'

const SCREENSHOT_DIR = '/tmp/side-threads'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** Seeded session record that owns the column the drawer hangs off. */
const PARENT_SID = 'pw-normal-session'

const FIRST_Q = 'why is this test flaky'
const SECOND_Q = 'which env var controls the retry'
const FOLLOW_UP = 'and what changes it'

/** Stands in for the real digest prompt, which the SERVER owns (the frontend only
 *  POSTs to /digest). Short so the mock CLI's echo is a readable assertion. */
const DIGEST_STANDIN = 'summarize this aside'

/** The mock CLI's echo prefix — the answer text every assertion looks for. */
const answerFor = (prompt: string) => `I processed your message: ${prompt}`

/**
 * The digest reply's required first line. The real server sends its own wording and
 * the drawer accepts ONLY a reply starting with whatever the response carried, so a
 * fixture whose "model" just echoes can still exercise the real marker-gated path:
 * hand back the echo prefix as the marker.
 */
const DIGEST_MARKER = 'Hello! I processed your message:'

let fixtureRoot = ''

// The drawer is a singleton per browser context and the fixture server is shared:
// keep these tests off each other's session pool.
test.describe.configure({ mode: 'serial' })

interface StubThread {
  id: string
  title: string
  threadSessionId: string
  createdAt: string
  promotedTaskId?: string
  /** The user filed it away (the row survives — this is not a delete). */
  archivedAt?: string
  /** The session RECORD is archived, i.e. its CLI process is gone. Distinct from
   *  `archivedAt`: the reaper archives records the user never filed. */
  archived?: boolean
}

interface StubState {
  threads: StubThread[]
  /** Threads the drawer asked to create, in order. */
  created: string[]
  standbyCalls: number
  /** Typing-triggered cache warm-ups (POST /standby/warm). */
  warmCalls: number
  deleted: string[]
  /** Threads filed away / brought back (POST /:id/archive · /restore), in order. */
  archived: string[]
  restored: string[]
  /** Threads asked to summarize themselves (POST /:id/digest), in order. */
  digested: string[]
  /** When set, POST /side-threads answers 409 fork_unsupported. */
  forkUnsupported: boolean
  /** The marker the digest response claims to have demanded of the reply. */
  digestMarker: string
}

function freshStub(threads: StubThread[] = []): StubState {
  return {
    threads, created: [], standbyCalls: 0, warmCalls: 0, deleted: [],
    archived: [], restored: [], digested: [],
    forkUnsupported: false, digestMarker: DIGEST_MARKER,
  }
}

/**
 * A real session to back a thread: quick-start with the QUESTION as its first
 * message, the same shape the real fork takes. The mock CLI echoes it, so the
 * drawer has a deterministic answer to render.
 */
async function startThreadSession(request: APIRequestContext, question: string): Promise<string> {
  const res = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: question },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const { sessionId } = await res.json() as { sessionId?: string }
  expect(sessionId, 'quick-start returned no sessionId').toBeTruthy()
  return sessionId as string
}

/**
 * Play the backend for the five side-thread endpoints. On create, spawn the real
 * session that stands in for the fork (see the header).
 */
async function installSideThreadRoutes(
  page: Page,
  request: APIRequestContext,
  stub: StubState,
): Promise<void> {
  await page.route('**/api/sessions/*/side-threads**', async (route) => {
    const req = route.request()
    const method = req.method()
    const rest = new URL(req.url()).pathname.split('/side-threads')[1] ?? ''

    if (method === 'GET' && rest === '') {
      await route.fulfill({ json: { threads: stub.threads, legacy: [] } })
      return
    }
    if (method === 'POST' && rest === '/standby') {
      stub.standbyCalls++
      await route.fulfill({ json: { ok: true } })
      return
    }
    if (method === 'POST' && rest === '/standby/warm') {
      stub.warmCalls++
      await route.fulfill({ json: { warmed: true } })
      return
    }
    if (method === 'POST' && rest === '') {
      const { question } = (req.postDataJSON() ?? {}) as { question?: string }
      if (stub.forkUnsupported) {
        await route.fulfill({ status: 409, json: { error: 'fork_unsupported' } })
        return
      }
      const threadSessionId = await startThreadSession(request, question ?? '')
      const thread: StubThread = {
        id: `st-${stub.threads.length + 1}`,
        title: (question ?? '').slice(0, 40),
        threadSessionId,
        createdAt: new Date().toISOString(),
      }
      stub.threads.push(thread)
      stub.created.push(question ?? '')
      await route.fulfill({ json: { thread } })
      return
    }
    const promote = /^\/([^/]+)\/promote$/.exec(rest)
    if (method === 'POST' && promote) {
      const target = stub.threads.find((t) => t.id === promote[1])
      if (target) target.promotedTaskId = 'pw-task-001'
      await route.fulfill({ json: { taskId: 'pw-task-001' } })
      return
    }
    const digest = /^\/([^/]+)\/digest$/.exec(rest)
    if (method === 'POST' && digest) {
      const target = stub.threads.find((t) => t.id === digest[1])
      if (!target) {
        await route.fulfill({ status: 404, json: { error: 'Side thread not found' } })
        return
      }
      stub.digested.push(target.id)
      await route.fulfill({
        status: 202,
        json: {
          requested: true, threadSessionId: target.threadSessionId, replyMarker: stub.digestMarker,
        },
      })
      // Play the server's part: the real route enqueues the tagged summary ask on
      // the THREAD's session, and the drawer waits for that turn's session:result.
      // A REST send produces the same real turn (the mock CLI echoes it).
      await request.post('/api/v1/messages', {
        data: { to: target.threadSessionId, text: DIGEST_STANDIN },
      })
      return
    }
    // Archive / restore: the row SURVIVES either way — only the stamp moves. The
    // real server also retires (archive) / un-archives (restore) the thread's
    // session record, which is what locks and unlocks the follow-up composer.
    const archive = /^\/([^/]+)\/archive$/.exec(rest)
    if (method === 'POST' && archive) {
      const target = stub.threads.find((t) => t.id === archive[1])
      if (!target) {
        await route.fulfill({ status: 404, json: { error: 'Side thread not found' } })
        return
      }
      stub.archived.push(target.id)
      target.archivedAt = target.archivedAt ?? new Date().toISOString()
      if (!target.promotedTaskId) target.archived = true
      await route.fulfill({ json: { archived: true, archivedAt: target.archivedAt } })
      return
    }
    const restore = /^\/([^/]+)\/restore$/.exec(rest)
    if (method === 'POST' && restore) {
      const target = stub.threads.find((t) => t.id === restore[1])
      if (!target) {
        await route.fulfill({ status: 404, json: { error: 'Side thread not found' } })
        return
      }
      stub.restored.push(target.id)
      delete target.archivedAt
      target.archived = false
      await route.fulfill({ json: { archived: false } })
      return
    }
    const del = /^\/([^/]+)$/.exec(rest)
    if (method === 'DELETE' && del) {
      stub.deleted.push(del[1])
      stub.threads = stub.threads.filter((t) => t.id !== del[1])
      await route.fulfill({ json: { ok: true } })
      return
    }
    await route.fulfill({ status: 404, json: { error: `unhandled ${method} ${rest}` } })
  })
}

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Does this session's persisted history contain `needle`? (HTTP truth, so a
 *  delivery assertion doesn't depend on the mock's echo timing.) */
async function historyContains(
  request: APIRequestContext, sessionId: string, needle: string,
): Promise<boolean> {
  const res = await request.get(`/api/sessions/${sessionId}/history`)
  if (!res.ok()) return false
  return JSON.stringify(await res.json()).includes(needle)
}

/** The parent session's home column. */
async function openParentColumn(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await seedColumns(page, [PARENT_SID])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${PARENT_SID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('textarea.chat-input-textarea').first()).toBeVisible({ timeout: 20_000 })
  return panel
}

/** `.side-question-pill` is shared with the Notes pill — filter on the label. */
const btwPill = (panel: Locator): Locator =>
  panel.locator('.side-question-pill', { hasText: 'btw' }).first()

async function openDrawer(panel: Locator): Promise<Locator> {
  await btwPill(panel).click()
  const popover = panel.locator('.side-question-popover').first()
  await expect(popover).toBeVisible({ timeout: 10_000 })
  return popover
}

/**
 * Chips for LIVE threads only. Must exclude "+ New" AND the "Archived (n)" toggle,
 * which shares `.side-thread-chip` — counting it as a thread is exactly how an
 * archive assertion accidentally passes.
 */
const liveChips = (popover: Locator): Locator => popover.locator(
  '.side-thread-chips .side-thread-chip:not(.side-thread-chip-new):not(.side-thread-chip-archived-toggle)',
)

/** The drawer's composer is the app's real ChatInput, so its control is the
 *  ChatInput TEXTAREA (scoped to the popover — the panel also has the main one). */
const drawerInput = (popover: Locator): Locator =>
  popover.locator('.side-question-composer textarea.chat-input-textarea')

async function ask(popover: Locator, text: string): Promise<void> {
  const input = drawerInput(popover)
  await input.fill(text)
  await input.press('Enter')
}

test('a thread streams its answer, follows up, switches, and injects into the composer', async ({ page, request }) => {
  test.setTimeout(240_000)
  const stub = freshStub()
  await installSideThreadRoutes(page, request, stub)

  const panel = await openParentColumn(page)
  const popover = await openDrawer(panel)

  // Header + hint: the drawer must read as "multi-turn, kept out of the chat".
  await expect(popover.locator('.side-question-popover-title')).toHaveText('Side threads')
  await expect(popover.locator('.side-question-popover-hint')).toContainText('multi-turn')
  // Prewarm is what makes the first ask instant — assert it actually fired.
  await expect.poll(() => stub.standbyCalls, { timeout: 10_000 }).toBeGreaterThan(0)
  // Empty state, and the only chip is "+ New".
  await expect(popover.locator('.side-thread-chip')).toHaveCount(1)
  await expect(popover.locator('.side-thread-chip-new')).toBeVisible()

  // ── The drawer's composer is the real one: every control the main composer has
  //    EXCEPT "btw" itself — a side thread of a side thread is not a feature. ──
  const composer = popover.locator('.side-question-composer')
  await expect(composer.locator('.mic-btn-wrapper button')).toBeVisible()
  // Mode pill (first .mode-toggle-pill; the output-mode pill shares the class).
  const modePill = composer.locator('.mode-toggle-pill').first()
  await expect(modePill).toBeVisible()
  const modeBefore = await modePill.locator('.mode-toggle-pill-label').innerText()
  await modePill.click()
  await expect(modePill.locator('.mode-toggle-pill-label')).not.toHaveText(modeBefore)
  await modePill.click()
  // Output-mode (Rich/MD) pill — flips locally before a thread exists; the pick
  // rides the create request, so nothing is PATCHed against a session id that
  // has not been minted yet.
  // Matched by title: the button's TEXT is the mode itself ("MD"/"Rich"), which is
  // also its accessible name, so a name-based locator would chase the value.
  const richPill = composer.locator('button[title^="Output mode"]')
  await expect(richPill).toBeVisible()
  const richBefore = await richPill.innerText()
  await richPill.click()
  await expect(richPill).not.toHaveText(richBefore)
  await richPill.click()
  await expect(richPill).toHaveText(richBefore)
  // Model + effort pill — the same control (and picker) as the main composer.
  await expect(composer.locator('.composer-model-pill')).toBeVisible()
  // A note annotates an existing thread, so the pill is absent until one exists.
  await expect(composer.locator('.session-notes-pill')).toHaveCount(0)
  // NO recursive "btw": the drawer must never host another side-thread pill.
  await expect(popover.locator('.side-question-pill', { hasText: 'btw' })).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/drawer-composer.png`, fullPage: true })

  // ── Typing a few characters warms the standby's cache BEFORE Enter ──
  // (one request per parent, not one per keystroke)
  await drawerInput(popover).pressSequentially('why does ', { delay: 20 })
  await expect.poll(() => stub.warmCalls, { timeout: 10_000 }).toBe(1)
  await drawerInput(popover).pressSequentially('hasPipe', { delay: 20 })
  await page.waitForTimeout(500)
  expect(stub.warmCalls).toBe(1)
  await drawerInput(popover).fill('')

  // ── Ask: a chip appears, and the thread's OWN conversation mounts ──
  await ask(popover, FIRST_Q)
  const chips = liveChips(popover)
  // The chip is OPTIMISTIC — it exists before the create call resolves, which is
  // why the server-side assertion is a poll and the chip check is not.
  await expect(chips).toHaveCount(1, { timeout: 15_000 })
  await expect(chips.first()).toContainText(FIRST_Q.slice(0, 20))
  await expect.poll(() => stub.created, { timeout: 30_000 }).toEqual([FIRST_Q])

  const body = popover.locator('.side-thread-body')
  await expect(body).toBeVisible({ timeout: 20_000 })
  // With a live thread the Note pill joins the row (its subject now exists), and
  // there is STILL no nested "btw".
  await expect(composer.locator('.session-notes-pill')).toBeVisible({ timeout: 15_000 })
  await expect(popover.locator('.side-question-pill', { hasText: 'btw' })).toHaveCount(0)
  // THE assertion this spec exists for: the answer streams into the DRAWER.
  await expect(body.getByText(answerFor(FIRST_Q), { exact: false }).first())
    .toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/thread-answered.png`, fullPage: true })

  // The parent conversation must NOT have gained the question (that's the feature).
  // `.first()` is the panel's OWN transcript: DOM order puts it before the
  // composer, and therefore before the drawer's popover (which holds the
  // thread's `.session-history`).
  await expect(panel.locator('.session-history').first().getByText(FIRST_Q, { exact: false }))
    .toHaveCount(0)

  // ── Follow-up: same thread, addressed to the THREAD session id ──
  // Asserted over HTTP, not on the mock's echo: the contract is "the follow-up
  // goes to the thread, never the parent", and that is exactly what the two
  // history checks below pin.
  await expect(drawerInput(popover)).toHaveAttribute('placeholder', 'Follow up…')
  const firstThreadSid = stub.threads[0].threadSessionId
  await ask(popover, FOLLOW_UP)
  await expect.poll(
    () => historyContains(request, firstThreadSid, FOLLOW_UP),
    { timeout: 60_000, message: 'follow-up never reached the thread session' },
  ).toBe(true)
  expect(await historyContains(request, PARENT_SID, FOLLOW_UP)).toBe(false)

  // ── "+ New" → second thread; chips switch which body is mounted ──
  await popover.locator('.side-thread-chip-new').click()
  await expect(drawerInput(popover)).toHaveAttribute('placeholder', 'Ask a side question…')
  await ask(popover, SECOND_Q)
  await expect(chips).toHaveCount(2, { timeout: 15_000 })
  await expect(body.getByText(answerFor(SECOND_Q), { exact: false }).first())
    .toBeVisible({ timeout: 60_000 })

  // Only ONE thread body is ever mounted (two would mean two stream
  // subscriptions for one session id — a documented bug class).
  await expect(popover.locator('.side-thread-body')).toHaveCount(1)
  // Back to thread 1: its answer returns, thread 2's is gone from the DOM.
  // ── Notes are PER THREAD: B's note must never seed A's editor ──
  // The note editor seeds itself from the mounted record, so holding the previous
  // thread's record across a switch made one thread's note save onto the other.
  const notePill = composer.locator('.session-notes-pill')
  await notePill.click()
  const noteBox = popover.locator('.session-notes-textarea')
  await expect(noteBox).toBeVisible({ timeout: 10_000 })
  await noteBox.fill('this note belongs to thread two')
  await expect(popover.locator('.session-notes-status')).toBeVisible({ timeout: 10_000 })
  // Leave edit mode first: while the editor is open the note card's outside-click
  // closer eats the next pointerdown, so a chip click would only collapse it.
  await noteBox.press('Escape')
  await expect(popover.locator('.session-notes-textarea')).toHaveCount(0)

  // A has no note of its own: its entry point is the PILL again and no note row
  // renders. B keeps its own. (This pins the SETTLED state. The narrow window while
  // a thread's record read is in flight is not observable from the browser tier —
  // the guard for it is that the drawer clears the record unconditionally on switch,
  // before the read, so the previous thread's note can never seed the new one.)
  await chips.first().click()
  await expect(notePill).toBeVisible({ timeout: 10_000 })
  await expect(popover.locator('.session-notes')).toHaveCount(0)
  await chips.nth(1).click()
  await expect(popover.locator('.session-notes')).toBeVisible({ timeout: 10_000 })
  await chips.first().click()

  await expect(body.getByText(answerFor(FIRST_Q), { exact: false }).first())
    .toBeVisible({ timeout: 30_000 })
  await expect(body.getByText(answerFor(SECOND_Q), { exact: false })).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/two-threads.png`, fullPage: true })

  // ── Mid-turn, the summary button REFUSES rather than reading a stale snapshot ──
  // "Which message is the summary" is decided against the newest message at request
  // time; asking during a running turn would take that snapshot mid-flight.
  const summaryButton = popover.getByRole('button', { name: /Inject summary/ })
  await ask(popover, 'slow:6000 one more thing')
  await expect(summaryButton).toBeDisabled({ timeout: 20_000 })
  await expect(summaryButton).toHaveAttribute('title', /Wait for this thread to finish/)
  await expect(summaryButton).toBeEnabled({ timeout: 90_000 })

  // ── Inject SUMMARY: the thread writes it, and only the summary lands ──
  // Deliberately first: it must NOT close over the full-inject path, and the
  // composer must hold the summary alone (not the transcript).
  await summaryButton.click()
  const composerBox = panel.locator('textarea.chat-input-textarea').first()
  await expect(composerBox)
    .toHaveValue(new RegExp(`\\[Summary of side thread "${FIRST_Q}"\\]`), { timeout: 30_000 })
  // The marker line is STRIPPED before injecting: the header already says where the
  // text came from, so the machine first line must not survive into the composer.
  const injected = await composerBox.inputValue()
  const summaryBody = injected.slice(injected.indexOf('\n') + 1)
  expect(summaryBody.startsWith(DIGEST_MARKER)).toBeFalsy()
  expect(summaryBody).toContain(DIGEST_STANDIN)
  // The SUMMARY variant, not the transcript one: no Q/A rows, no other header.
  await expect(composerBox).not.toHaveValue(/From side thread/)
  expect(stub.digested).toEqual(['st-1'])
  await composerBox.fill('')

  // ── A reply that does NOT carry the marker is REFUSED, not pasted ──
  // The whole point of the marker: before it existed, a read that raced the
  // transcript flush injected the PREVIOUS answer labelled as a summary. Here the
  // "server" demands a marker the thread never writes, so the drawer must end with
  // an error and an EMPTY composer rather than a confident wrong paste.
  stub.digestMarker = 'THREAD-NEVER-WRITES-THIS:'
  await panel.locator('.side-question-pill', { hasText: 'btw' }).first().click()
  await expect(popover).toBeVisible({ timeout: 10_000 })
  await liveChips(popover).first().click()
  await popover.getByRole('button', { name: /Inject summary/ }).click()
  // It accepted the click and is polling…
  await expect(popover.getByRole('button', { name: /Summarizing/ })).toBeVisible({ timeout: 15_000 })
  // …and the thread's real reply (which does not carry this marker) lands during that
  // window, yet NOTHING is pasted. That is the rule: refuse, never guess. The "your
  // budget is spent" message itself is pinned at the unit level instead of waiting out
  // DIGEST_TIMEOUT_MS here (readSideThreadDigest → reason: 'timeout').
  await expect.poll(
    () => historyContains(request, stub.threads[0].threadSessionId, DIGEST_STANDIN),
    { timeout: 60_000, message: 'the digest request never reached the thread' },
  ).toBe(true)
  await page.waitForTimeout(3_000)
  await expect(composerBox).toHaveValue('')
  stub.digestMarker = DIGEST_MARKER
  // Switching threads ABANDONS a digest in flight: its text belongs to the thread the
  // user left. The spinner clears and the composer stays untouched.
  await liveChips(popover).nth(1).click()
  await expect(popover.getByRole('button', { name: /Inject summary/ })).toBeVisible({ timeout: 20_000 })
  await expect(composerBox).toHaveValue('')
  // Leave the drawer closed so the next section opens it from the same state as
  // above (the successful inject closes it itself; a refusal deliberately does not).
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden({ timeout: 10_000 })

  // ── Inject full: the thread's whole Q&A lands in the MAIN composer ──
  await panel.locator('.side-question-pill', { hasText: 'btw' }).first().click()
  await expect(popover).toBeVisible({ timeout: 10_000 })
  await liveChips(popover).first().click()
  await popover.getByRole('button', { name: /Inject full/ }).click()
  const mainComposer = panel.locator('textarea.chat-input-textarea').first()
  await expect(mainComposer)
    .toHaveValue(new RegExp(`\\[From side thread "${FIRST_Q}"\\]`), { timeout: 20_000 })
  await expect(mainComposer).toHaveValue(new RegExp(`A: .*${FIRST_Q}`))
  // NOT asserted here: the `Q:` lines. The mock CLI writes no USER lines to its
  // transcript, so a fixture thread's history is assistant-only — a Q assertion
  // would fail for a fixture reason, not a product one. The Q/A/skip-system
  // format is pinned on the pure formatter instead
  // (tests/web/side-threads-store.test.ts → formatSideThreadForComposer).
  // Nothing was SENT — injection only prefills.
  await expect(panel.locator('.session-history').first().getByText(FOLLOW_UP, { exact: false }))
    .toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/injected-into-composer.png`, fullPage: true })
})

test('promote badges the chip, and "done with this" FILES it rather than deleting', async ({ page, request }) => {
  test.setTimeout(120_000)
  const stub = freshStub([{
    id: 'st-seeded',
    title: 'seeded side thread',
    threadSessionId: await startThreadSession(request, 'seeded thread question'),
    createdAt: new Date().toISOString(),
  }])
  await installSideThreadRoutes(page, request, stub)

  const panel = await openParentColumn(page)
  const popover = await openDrawer(panel)

  const chip = liveChips(popover).first()
  await expect(chip).toContainText('seeded side thread')
  await chip.click()
  await expect(popover.locator('.side-thread-body')).toBeVisible({ timeout: 20_000 })

  await popover.getByRole('button', { name: /Promote to task/ }).click()
  // Optimistic ✓ on the chip + the action row, reconciled with the real task id.
  await expect(chip.locator('.side-thread-chip-badge')).toBeVisible({ timeout: 10_000 })
  await expect(popover.locator('.side-question-promoted')).toContainText('task created', { timeout: 10_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/promoted.png`, fullPage: true })

  // The "done with this" action FILES the thread away — it must not delete it.
  await popover.locator('.side-thread-delete').click()
  await expect(liveChips(popover)).toHaveCount(0, { timeout: 10_000 })
  await expect(popover.locator('.side-thread-body')).toHaveCount(0)
  expect(stub.archived).toEqual(['st-seeded'])
  expect(stub.deleted).toEqual([])
  // …and it is still there, one click away.
  await expect(popover.locator('.side-thread-chip-archived-toggle')).toContainText('Archived (1)')
})

test('the chip × files a thread away, and it stays retrievable', async ({ page, request }) => {
  test.setTimeout(240_000)
  const stub = freshStub([
    {
      id: 'st-keep',
      title: 'keep me around',
      threadSessionId: await startThreadSession(request, 'keep me around'),
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: 'st-file',
      title: 'file me away',
      threadSessionId: await startThreadSession(request, 'file me away'),
      createdAt: '2026-09-02T00:00:00.000Z',
    },
  ])
  await installSideThreadRoutes(page, request, stub)

  const panel = await openParentColumn(page)
  const popover = await openDrawer(panel)
  await expect(liveChips(popover)).toHaveCount(2)
  // No shelf while nothing is filed — an empty "Archived (0)" would be noise.
  await expect(popover.locator('.side-thread-chip-archived-toggle')).toHaveCount(0)

  // Open the one we are about to file, so filing also has to deselect it: leaving
  // it selected would keep a filed thread's conversation mounted in the drawer.
  const fileChip = popover.locator('.side-thread-chip', { hasText: 'file me away' }).first()
  await fileChip.click()
  await expect(popover.locator('.side-thread-body')).toBeVisible({ timeout: 20_000 })

  await popover.getByRole('button', { name: 'Archive side thread: file me away' }).click()

  // Filed: out of the chip row, into the shelf, and the row still EXISTS server-side.
  await expect(liveChips(popover)).toHaveCount(1, { timeout: 10_000 })
  await expect(liveChips(popover).first()).toContainText('keep me around')
  await expect(popover.locator('.side-thread-body')).toHaveCount(0)
  expect(stub.archived).toEqual(['st-file'])
  expect(stub.deleted).toEqual([])

  // The pill's own count has to fall too, or tidying up changes nothing where you
  // actually look at it.
  await expect(btwPill(panel).locator('.side-question-count')).toHaveText('1')

  const toggle = popover.locator('.side-thread-chip-archived-toggle')
  await expect(toggle).toContainText('Archived (1)')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/archived-collapsed.png`, fullPage: true })

  // The shelf is collapsed by default (it is storage, not part of the working row).
  await expect(popover.locator('.side-thread-archived')).toHaveCount(0)
  await toggle.click()
  const shelf = popover.locator('.side-thread-archived')
  await expect(shelf).toBeVisible()
  const shelfChip = shelf.locator('.side-thread-chip.is-archived').first()
  await expect(shelfChip).toContainText('file me away')

  // Retrievable in BOTH senses. (1) Readable where it is: opening it mounts its
  // conversation, with the follow-up composer locked to "history only".
  await shelfChip.click()
  await expect(popover.locator('.side-thread-body')).toBeVisible({ timeout: 20_000 })
  await expect(popover.locator('.side-thread-body')).toContainText(answerFor('file me away'), { timeout: 30_000 })
  await expect(popover.locator('.side-question-composer-label')).toContainText('Archived ·')
  await expect(popover.locator('.side-question-composer-label')).toContainText('history only')
  await expect(drawerInput(popover)).toBeDisabled()
  // The actions row turns into the way BACK — an "Archive" button on an already
  // filed thread would be the one screen where it does nothing.
  await expect(popover.getByRole('button', { name: 'Restore this side thread' })).toBeVisible()
  await expect(popover.getByRole('button', { name: 'Archive this side thread' })).toHaveCount(0)
  // Summarizing needs a live process to answer; injecting the full aside reads the
  // transcript, so it stays available. Promote stays available too — it RESTORES.
  await expect(popover.getByRole('button', { name: /Inject summary/ })).toBeDisabled()
  await expect(popover.getByRole('button', { name: /Inject full/ })).toBeEnabled()
  await expect(popover.getByRole('button', { name: /Promote to task/ })).toBeEnabled()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/archived-open-readonly.png`, fullPage: true })

  // Permanent delete is only reachable from the shelf — one deliberate step further.
  await expect(shelf.locator('.side-thread-chip-purge')).toHaveCount(1)
  await expect(popover.locator('.side-thread-chips .side-thread-chip-purge')).toHaveCount(0)

  // Close and REOPEN the drawer before restoring. That is the ordinary thing a user
  // does, and it is the only way the client sees the server's record-level `archived`
  // flag — which is exactly where a restore that only cleared the stamp left the chip
  // back in the row with a permanently locked composer.
  await btwPill(panel).click()
  await expect(popover).toHaveCount(0)
  const reopened = await openDrawer(panel)
  await expect(reopened.locator('.side-thread-chip-archived-toggle')).toContainText('Archived (1)')
  // The shelf REMEMBERS that it was open (the drawer component stays mounted when the
  // popover closes), so drive it by its declared state rather than blind-clicking —
  // a second click would collapse it again.
  const reopenedToggle = reopened.locator('.side-thread-chip-archived-toggle')
  if (await reopenedToggle.getAttribute('aria-expanded') === 'false') await reopenedToggle.click()
  await expect(reopenedToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(reopened.locator('.side-thread-archived')).toBeVisible({ timeout: 10_000 })

  // (2) Restorable: back in the chip row, and usable again.
  await reopened.getByRole('button', { name: 'Restore side thread: file me away' }).click()
  await expect(liveChips(reopened)).toHaveCount(2, { timeout: 10_000 })
  await expect(reopened.locator('.side-thread-chip-archived-toggle')).toHaveCount(0)
  expect(stub.restored).toEqual(['st-file'])
  await expect(btwPill(panel).locator('.side-question-count')).toHaveText('2')
  // Usable again: pick it and the follow-up composer unlocks.
  await reopened.locator('.side-thread-chip', { hasText: 'file me away' }).first().click()
  await expect(drawerInput(reopened)).toBeEnabled({ timeout: 10_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/archived-restored.png`, fullPage: true })
})

test('permanent delete lives in the shelf and asks first', async ({ page, request }) => {
  test.setTimeout(150_000)
  const stub = freshStub([{
    id: 'st-purge',
    title: 'delete me for real',
    threadSessionId: await startThreadSession(request, 'delete me for real'),
    createdAt: '2026-09-01T00:00:00.000Z',
    archivedAt: '2026-09-02T00:00:00.000Z',
    archived: true,
  }])
  await installSideThreadRoutes(page, request, stub)

  const panel = await openParentColumn(page)
  const popover = await openDrawer(panel)
  // A filed thread is not in the chip row, and the pill counts only live ones.
  await expect(liveChips(popover)).toHaveCount(0)
  await expect(btwPill(panel).locator('.side-question-count')).toHaveCount(0)
  await expect(popover.locator('.side-question-empty')).toContainText('reopen one from Archived')

  await popover.locator('.side-thread-chip-archived-toggle').click()
  const shelf = popover.locator('.side-thread-archived')
  await shelf.locator('.side-thread-chip-purge').click()

  // The one irreversible action in the drawer asks first — it sits next to Restore.
  const dialog = page.locator('.app-modal').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog).toContainText('delete me for real')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/purge-confirm.png`, fullPage: true })

  // Backing out keeps the thread.
  await dialog.getByRole('button', { name: /Cancel/i }).click()
  await expect(dialog).toHaveCount(0)
  expect(stub.deleted).toEqual([])
  await expect(shelf.locator('.side-thread-chip.is-archived')).toHaveCount(1)

  await shelf.locator('.side-thread-chip-purge').click()
  await page.locator('.app-modal').first()
    .getByRole('button', { name: /Delete permanently/i }).click()
  await expect(popover.locator('.side-thread-chip-archived-toggle')).toHaveCount(0, { timeout: 10_000 })
  expect(stub.deleted).toEqual(['st-purge'])
})

test('a full Archived shelf never pushes the composer out of the drawer', async ({ page, request }) => {
  test.setTimeout(180_000)
  // One real session backs them all: this test is about LAYOUT, and 14 spawns would
  // cost minutes for nothing.
  const backing = await startThreadSession(request, 'filed away')
  const stub = freshStub(Array.from({ length: 14 }, (_, i) => ({
    id: `st-${i}`,
    title: `filed aside number ${i} with a fairly long label`,
    threadSessionId: backing,
    createdAt: `2026-09-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    archivedAt: `2026-09-02T00:00:${String(i).padStart(2, '0')}.000Z`,
    archived: true,
  })))
  await installSideThreadRoutes(page, request, stub)

  const panel = await openParentColumn(page)
  const popover = await openDrawer(panel)
  await popover.locator('.side-thread-chip-archived-toggle').click()
  await expect(popover.locator('.side-thread-archived')).toBeVisible()

  // The popover is height-capped with overflow:hidden, so an unbounded shelf silently
  // pushes the composer (and the actions row) off the bottom — measured at 9 filed
  // threads on a 1000px window. The shelf scrolls instead.
  const fits = await popover.evaluate((el) => {
    const pop = el.getBoundingClientRect()
    const composer = el.querySelector('.side-question-composer')?.getBoundingClientRect()
    const shelf = el.querySelector('.side-thread-archived') as HTMLElement | null
    return {
      composerBottom: composer?.bottom ?? Infinity,
      popoverBottom: pop.bottom,
      shelfScrolls: !!shelf && shelf.scrollHeight > shelf.clientHeight,
    }
  })
  expect(fits.shelfScrolls).toBe(true)
  expect(fits.composerBottom).toBeLessThanOrEqual(fits.popoverBottom + 1)
  await expect(popover.locator('.side-question-composer textarea.chat-input-textarea')).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/archived-shelf-full.png`, fullPage: true })
})

test('an engine that cannot fork shows an inline notice, not a dead drawer', async ({ page, request }) => {
  test.setTimeout(90_000)
  const stub = freshStub()
  stub.forkUnsupported = true
  await installSideThreadRoutes(page, request, stub)

  const panel = await openParentColumn(page)
  const popover = await openDrawer(panel)
  await ask(popover, 'this engine cannot fork')

  await expect(popover.locator('.side-question-notice'))
    .toHaveText("This engine can't fork side threads", { timeout: 15_000 })
  // The optimistic chip rolled back — no phantom thread left behind.
  await expect(liveChips(popover)).toHaveCount(0)
  // The composer is still usable (the drawer did not lock up).
  await expect(drawerInput(popover)).toBeEnabled()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fork-unsupported.png`, fullPage: true })
})
