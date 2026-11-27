/**
 * A parked message says whether Walnut tries it again (pain pn-79fe0af3, 2026-11-22: the chat read
 * "Not delivered. Auto-retry stopped (Not acknowledged: Claude Code read past this message ...)"
 * for a row the server's clock was to try again; the user: "why not keep retrying it").
 *
 * The fixture session pw-threads-failed-session holds one parked follow-up (a Stop's park, which
 * nothing retries). The first test hands the panel the server's word for a row the clock does try
 * (its queue read's `autoRetryAt`, as src/web/routes/session-chat.ts sends it, on the pain's own
 * reason) by rewriting that read on the socket; the second reads the fixture as it is.
 */
import { expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { FAILED_SESSION, mainPage, openThreadsSession, resetThreadsFixture, test } from './threads-helpers'
import { FAILED_PASSAGES, PARKED_FOLLOW_UP } from './threads-fixture'

const FAILED_TASK = 'pw-task-threads-failed'
const PARKED_ID = 'pw-threads-failed-parked-1'
const READ_PAST = 'Not acknowledged: Claude Code read past this message and Walnut could not write it again. '
  + 'The message is kept: if Claude Code runs it later, it shows then. Retry sends it again without making a second copy.'
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots`

/** Rewrite the queue reads of the fixture's parked row as a row the clock tries again at `at`. */
async function serverRetriesIt(page: Page, at: string): Promise<void> {
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    const server = ws.connectToServer()
    const queueReads = new Set<string>()
    ws.onMessage((message) => {
      try {
        const f = JSON.parse(message.toString()) as { type?: string; id?: string; method?: string }
        if (f.type === 'req' && f.method === 'session:get-queue' && f.id) queueReads.add(f.id)
      } catch { /* not JSON */ }
      server.send(message)
    })
    server.onMessage((message) => {
      try {
        const f = JSON.parse(message.toString()) as { type?: string; id?: string; payload?: { messages?: Array<Record<string, unknown>> } }
        if (f.id && queueReads.has(f.id) && Array.isArray(f.payload?.messages)) {
          for (const m of f.payload.messages) if (m.id === PARKED_ID) Object.assign(m, { parkedReason: READ_PAST, autoRetryAt: at })
          ws.send(JSON.stringify(f))
          return
        }
      } catch { /* not JSON */ }
      ws.send(message)
    })
  })
}

async function openParked(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openThreadsSession(page, FAILED_SESSION, FAILED_TASK, FAILED_PASSAGES[1])
  const rows = panel.locator('.thread-asked-row:not(.is-draft)')
  await expect(rows).toHaveCount(2)
  await rows.nth(1).click()
  const history = mainPage(panel).locator('.session-history')
  await expect(history).toContainText(PARKED_FOLLOW_UP)
  return panel
}

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })
// Other workers' tests change this session's rows: start from the fixture, holding its lease.
test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, FAILED_SESSION) })

test('a parked row the server tries again says so, and when; never that retrying stopped', async ({ page }) => {
  const at = new Date(Date.now() + 25 * 60_000).toISOString()
  await serverRetriesIt(page, at)
  const panel = await openParked(page)
  const badge = panel.locator('.session-msg-failed-badge')
  await expect(badge).toContainText('Not delivered yet: Walnut tries it again by itself. Next try at')
  await expect(badge).not.toContainText(/stopped/i)
  // Retry still sends it at once; Discard still drops it.
  await expect(panel.locator('.session-msg-failed [data-testid="send-retry"]')).toHaveCount(1)
  await expect(panel.locator('button', { hasText: 'Discard message' })).toHaveCount(1)
  await badge.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/parked-auto-retry.png`, clip: (await panel.boundingBox()) ?? undefined })
})

test('a parked row nothing retries (a Stop) asks for Retry, and says nothing of retrying having stopped', async ({ page }) => {
  const panel = await openParked(page)
  const badge = panel.locator('.session-msg-failed-badge')
  await expect(badge).toContainText('Retry sends it again.')
  await expect(badge).not.toContainText(/stopped trying|auto-retry stopped/i)
  await badge.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/parked-retry-needed.png`, clip: (await panel.boundingBox()) ?? undefined })
})
