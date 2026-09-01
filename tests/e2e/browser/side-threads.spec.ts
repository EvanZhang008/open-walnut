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
 *   - promote shows the ✓task badge, delete removes the chip
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

/** The mock CLI's echo prefix — the answer text every assertion looks for. */
const answerFor = (prompt: string) => `I processed your message: ${prompt}`

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
}

interface StubState {
  threads: StubThread[]
  /** Threads the drawer asked to create, in order. */
  created: string[]
  standbyCalls: number
  deleted: string[]
  /** When set, POST /side-threads answers 409 fork_unsupported. */
  forkUnsupported: boolean
}

function freshStub(threads: StubThread[] = []): StubState {
  return { threads, created: [], standbyCalls: 0, deleted: [], forkUnsupported: false }
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

const drawerInput = (popover: Locator): Locator =>
  popover.locator('.side-question-composer input')

async function ask(popover: Locator, text: string): Promise<void> {
  const input = drawerInput(popover)
  await input.fill(text)
  await input.press('Enter')
}

test('a thread streams its answer, follows up, switches, and injects into the composer', async ({ page, request }) => {
  test.setTimeout(180_000)
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

  // ── Ask: a chip appears, and the thread's OWN conversation mounts ──
  await ask(popover, FIRST_Q)
  const chips = popover.locator('.side-thread-chip:not(.side-thread-chip-new)')
  // The chip is OPTIMISTIC — it exists before the create call resolves, which is
  // why the server-side assertion is a poll and the chip check is not.
  await expect(chips).toHaveCount(1, { timeout: 15_000 })
  await expect(chips.first()).toContainText(FIRST_Q.slice(0, 20))
  await expect.poll(() => stub.created, { timeout: 30_000 }).toEqual([FIRST_Q])

  const body = popover.locator('.side-thread-body')
  await expect(body).toBeVisible({ timeout: 20_000 })
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
  await chips.first().click()
  await expect(body.getByText(answerFor(FIRST_Q), { exact: false }).first())
    .toBeVisible({ timeout: 30_000 })
  await expect(body.getByText(answerFor(SECOND_Q), { exact: false })).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/two-threads.png`, fullPage: true })

  // ── Inject to chat: the thread's Q&A lands in the MAIN composer ──
  await popover.getByRole('button', { name: /Inject to chat/ }).click()
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

test('promote badges the chip and delete removes it', async ({ page, request }) => {
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

  const chip = popover.locator('.side-thread-chip:not(.side-thread-chip-new)').first()
  await expect(chip).toContainText('seeded side thread')
  await chip.click()
  await expect(popover.locator('.side-thread-body')).toBeVisible({ timeout: 20_000 })

  await popover.getByRole('button', { name: /Promote to task/ }).click()
  // Optimistic ✓ on the chip + the action row, reconciled with the real task id.
  await expect(chip.locator('.side-thread-chip-badge')).toBeVisible({ timeout: 10_000 })
  await expect(popover.locator('.side-question-promoted')).toContainText('task created', { timeout: 10_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/promoted.png`, fullPage: true })

  await popover.locator('.side-thread-delete').click()
  await expect(popover.locator('.side-thread-chip:not(.side-thread-chip-new)')).toHaveCount(0, { timeout: 10_000 })
  await expect(popover.locator('.side-thread-body')).toHaveCount(0)
  expect(stub.deleted).toEqual(['st-seeded'])
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
  await expect(popover.locator('.side-thread-chip:not(.side-thread-chip-new)')).toHaveCount(0)
  // The composer is still usable (the drawer did not lock up).
  await expect(drawerInput(popover)).toBeEnabled()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/fork-unsupported.png`, fullPage: true })
})
