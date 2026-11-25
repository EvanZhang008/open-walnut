/**
 * The card line check runs beside the Stop hook's other checks, never before them (experiment
 * threads_reply_tag; src/web/routes/api-v1.ts, the hook=stop branch of GET /me/open).
 *
 * The CLI gives the whole Stop hook five seconds (providers/stop-unanswered-hook.ts), the start of
 * the `walnut` command included, and drops a hook that takes longer: then no check holds the turn,
 * the request a session has not answered among them. The card check may take up to three seconds on
 * a slow server, so it must cost the answer the slowest check's time, not its own on top of the rest.
 *
 * Real server, real stores; only the two checks are slowed, each by a wait in front of the real one:
 *   - a slow card check and a slow summaries check answer in one check's time, with the block of
 *     the request check and of the card check both in the one reason;
 *   - a card check that does not end is given up after its three seconds, and the answer still
 *     carries the request check's block;
 *   - the request itself: at the size the hook caps it to it is answered, and at the size its first
 *     cap allowed the server refused it whole (tests/providers/stop-hook-last-lines.test.ts runs the
 *     hook's own cap and its second call).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

const slow = vi.hoisted(() => ({ checks: 0, card: 0 }))
const wait = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-stop-budget'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
// Each check as it is, after a wait: what a slow store costs it.
vi.mock('../../src/core/org/reply-card-stop.js', async (original) => {
  const real = await original<typeof import('../../src/core/org/reply-card-stop.js')>()
  return { ...real, cardLinesAtStop: async (...a: Parameters<typeof real.cardLinesAtStop>) => { if (slow.checks) await wait(slow.checks); return real.cardLinesAtStop(...a) } }
})
vi.mock('../../src/core/org/thread-summary-stop.js', async (original) => {
  const real = await original<typeof import('../../src/core/org/thread-summary-stop.js')>()
  return { ...real, staleSummariesAtStop: async (...a: Parameters<typeof real.staleSummariesAtStop>) => { if (slow.checks) await wait(slow.checks); return real.staleSummariesAtStop(...a) } }
})
// The card check's first read, inside its own three seconds.
vi.mock('../../src/core/org/reply-card-switch.js', async (original) => {
  const real = await original<typeof import('../../src/core/org/reply-card-switch.js')>()
  return { ...real, replyTagOn: async () => { if (slow.card) await wait(slow.card); return real.replyTagOn() } }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { createSessionRequest } from '../../src/core/session-requests.js'
import { resetStopNudges } from '../../src/core/sessions/unanswered-at-stop.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { threadsKeptNow } from '../../src/core/org/threads-kept.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { resetHeldCards } from '../../src/core/org/reply-card.js'
import { MAX_CARD_NUDGES, resetCardNudges } from '../../src/core/org/reply-card-stop.js'
import { cardTagLine } from '../../src/lib/card-tag.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import '../../src/ops/index.js'

const SID = '55555555-5555-6666-7777-000000000002'
const ASKER = '55555555-5555-6666-7777-000000000003'
const FENCE = 'th-feec0de6'
let base = ''
let rq = ''
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

async function stop(tail: string): Promise<{ took: number; decision?: string; reason: string }> {
  const started = Date.now()
  const r = await executeOp('open_items', { hook: 'stop', last_lines: tail }, { apiBase: `${base}/api/v1`, callerSid: SID, origin: LOCAL_ORIGIN })
  const took = Date.now() - started
  expect(r.ok, JSON.stringify(r)).toBe(true)
  const out = (r as { result: { decision?: string; reason?: string } }).result
  return { took, decision: out.decision, reason: out.reason ?? '' }
}
const fresh = () => { resetStopNudges(); resetCardNudges(); resetHeldCards() }

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const taskId = (await addTask({ title: 'Garden VP', project: 'Garden' })).task.id
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', session_id: SID, org_role: 'lead' }, { source: 'test' })
  await createSessionRecord(SID, taskId, 'Garden', '/repo/garden', { title: 'Garden VP' })
  await updateSessionRecord(SID, { process_status: 'idle' })
  // His message of two minutes ago, read by this session and not answered: the turn that ends owes its thread a line.
  const threads: OrgThread[] = [{
    id: FENCE, title: 'Orchard fence', titled: true, state: 'working', reply: 'Measuring the orchard.', replyAt: ago(20), createdAt: ago(40), updatedAt: ago(2), by: 'task:x',
    messages: [
      { id: 'tm-feec0de6', at: ago(40), text: 'How tall should the orchard fence be?', via: 'chat', sid: SID, answer: { text: 'I measure the orchard first.', at: ago(39) } },
      { id: 'tm-feec0de7', at: ago(2), text: 'And which wood?', via: 'chat', sid: SID },
    ],
  }] as OrgThread[]
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, threads }))
  // And a request another task sent it, not answered: the check that was there before card lines.
  const asker = (await addTask({ title: 'Orchard planner', project: 'Garden' })).task.id
  await createSessionRecord(ASKER, asker, 'Garden', '/repo/garden', { title: 'Orchard planner' })
  rq = (await createSessionRequest({ fromSessionId: ASKER, toSessionId: SID, toTaskId: taskId, text: 'Is the orchard measured yet?' })).id
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_kept_by_walnut: true, threads_reply_tag: true } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(threadsKeptNow()).toBe(true); expect(replyTagNow()).toBe(true) }, { timeout: 5000 })
}, 30_000)

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the card line check never costs the Stop hook its other checks', () => {
  it('unslowed: the one answer holds the request not answered and the card line not written', async () => {
    fresh()
    const out = await stop('x')
    expect(out.decision).toBe('block')
    expect(out.reason).toContain(rq)
    expect(out.reason).toContain(cardTagLine(FENCE))
  })

  it('a slow card check and a slow summaries check take one check\'s time, not the sum', async () => {
    fresh()
    slow.checks = 1500
    try {
      const out = await stop('x')
      // Both waited their 1.5 s: one after the other is 3 s and more.
      expect(out.took).toBeGreaterThanOrEqual(slow.checks - 50)
      expect(out.took).toBeLessThan(2 * slow.checks - 500)
      expect(out.decision).toBe('block')
      expect(out.reason).toContain(rq)
      expect(out.reason).toContain(cardTagLine(FENCE))
    } finally {
      slow.checks = 0
    }
  })

  it('a request as large as the hook lets it get is answered; what its first cap let through was refused', async () => {
    fresh()
    const call = (args: Record<string, unknown>) => executeOp('open_items', { hook: 'stop', ...args }, { apiBase: `${base}/api/v1`, callerSid: SID, origin: LOCAL_ORIGIN })
    // "Fruit": one character is nine bytes of a request line. The hook sends the last lines and
    // its lists only while the two weigh 9,000 bytes there (stop-unanswered-hook.ts LAST_LINES_AWK).
    const lines = (chars: number) => '\u679c'.repeat(chars)
    const paths = `/tmp/${'a'.repeat(4395)}`
    expect(encodeURIComponent(lines(500)).length + encodeURIComponent(paths).length).toBeLessThanOrEqual(9000)
    const fits = await call({ last_lines: lines(500), tmp_paths: paths })
    expect(fits.ok, JSON.stringify(fits).slice(0, 300)).toBe(true)
    expect(JSON.stringify(fits)).toContain(rq)
    // 4,000 bytes of such text beside five long temp paths: 17 KB, past what the server takes (431),
    // and the answer names no field, so the request check was lost with it.
    const over = await call({ last_lines: lines(1333), tmp_paths: `/tmp/${'a'.repeat(4900)}` })
    expect(over.ok).toBe(false)
    expect(JSON.stringify(over)).toContain('431')
    expect(JSON.stringify(over)).not.toContain(rq)
  })

  it('a card check that does not end is given up after three seconds, and the request still holds the turn', async () => {
    fresh()
    slow.card = 3600
    try {
      const out = await stop('x')
      // Inside the hook's five seconds, with time left for the command to start.
      expect(out.took).toBeGreaterThanOrEqual(2900)
      expect(out.took).toBeLessThan(4200)
      expect(out.decision).toBe('block')
      expect(out.reason).toContain(rq)
      expect(out.reason).not.toContain('card line')
    } finally {
      slow.card = 0
    }
    // The check ended by itself a moment later. Nothing went back for it, so the missing line is
    // still named as often as any other: what nobody received was not counted.
    await wait(1000)
    for (let i = 0; i < MAX_CARD_NUDGES; i++) expect((await stop('x')).reason, `stop ${i + 1}`).toContain(cardTagLine(FENCE))
    expect((await stop('x')).reason).not.toContain('card line')
  }, 20_000)
})
