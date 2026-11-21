/**
 * A new event never goes out under the CLI uuid of a line that already ran.
 *
 * A caller id means "the same send again" to the queue: a row that already ran hands its line uuid
 * to the next row with that id (enqueueMessage, settledLineUuid), and Claude Code skips a uuid it
 * already saw. 2026-11-20: a change's "3 checks failed" was told again seven hours later under the
 * same content-hash id, and Claude Code skipped it (parked as "not acknowledged"); the same reuse
 * dropped other watch news silently. News that can recur uses sessions/event-rows.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-stable-row-ids'))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/session-message-queue.js')>()
  // The watcher's send without the server around it: the row lands in the real queue.
  return { ...real, sendMessageToSession: vi.fn((sid: string, text: string, opts?: { messageId?: string }) => real.enqueueMessage(sid, text, { id: opts?.messageId })) }
})

import { enqueueMessage, getQueue, markProcessing, parkIfQueued, removeTaken, resetCache, settledLineUuid } from '../../../src/core/session-message-queue.js'
import { resetLineCarriesForTesting } from '../../../src/providers/batch-uuid.js'
import { eventRowId, isEventRowOf, queuedEventRow } from '../../../src/core/sessions/event-rows.js'
import { sendTaskNews } from '../../../src/core/task-news.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const SID = 'stable-row-ids-session'
const KEY = 'change-watch-0123456789abcdef'
const NEWS = '<walnut-message kind="trigger">CR-1001 3 checks failed</walnut-message>'

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  resetLineCarriesForTesting()
})

afterEach(async () => {
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

/** Write the session's pending rows as one line, then settle it as run; returns the line's uuid. */
async function runLine(): Promise<string> {
  const batch = await markProcessing(SID)
  expect(batch).toHaveLength(1)
  await removeTaken(SID, batch.map((m) => m.id))
  return batch[0].lineUuid!
}

describe('news that can recur', () => {
  it('the same news told again after it ran goes out under a new id and a new uuid', async () => {
    const uuids: string[] = []
    for (let round = 0; round < 3; round++) {
      await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
      const rows = await getQueue(SID)
      expect(rows).toHaveLength(1)
      expect(isEventRowOf(rows[0].id, KEY)).toBe(true)
      // Nothing was inherited: the row was never written before.
      expect(rows[0].lineUuid).toBeUndefined()
      uuids.push(await runLine())
    }
    expect(new Set(uuids).size).toBe(3)
  })

  it('news still waiting in the queue is not queued twice; news after a written line is new', async () => {
    await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
    await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
    expect(await getQueue(SID)).toHaveLength(1)
    // Written into the CLI, not answered yet: news told after it (a new revision failing again
    // within the same turn) is new news, with its own row and uuid.
    const [written] = await markProcessing(SID)
    await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
    const rows = await getQueue(SID)
    expect(rows).toHaveLength(2)
    expect(rows[1].id).not.toBe(written.id)
    expect(rows[1].lineUuid).toBeUndefined()
  })

  it('news parked as failed does not hold back the next telling', async () => {
    await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
    const [row] = await getQueue(SID)
    await parkIfQueued([row], 'Claude Code did not acknowledge this message.', { freshLine: true })
    expect(await queuedEventRow(SID, KEY)).toBeUndefined()
    await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
    const rows = await getQueue(SID)
    expect(rows.map((m) => m.status)).toEqual(['parked', 'pending'])
    expect(rows[1].id).not.toBe(row.id)
  })

  it('news Walnut holds itself (a task move, the running turn) still counts as waiting', async () => {
    const { MOVE_HELD_REASON } = await import('../../../src/core/sessions/engine-switch-io.js')
    await enqueueMessage(SID, NEWS, { id: eventRowId(KEY), heldReason: MOVE_HELD_REASON })
    await sendTaskNews('change-watch', SID, NEWS, 'task-1', KEY)
    expect(await getQueue(SID)).toHaveLength(1)
  })

  it('a row an older Walnut queued under the bare key counts as that news', async () => {
    await enqueueMessage(SID, NEWS, { id: KEY })
    expect((await queuedEventRow(SID, KEY))?.id).toBe(KEY)
    await markProcessing(SID)
    // Written: no longer news waiting to go.
    expect(await queuedEventRow(SID, KEY)).toBeUndefined()
    // A key that only shares a prefix is another news.
    expect(await queuedEventRow(SID, `${KEY}0`)).toBeUndefined()
  })

  it('event ids never repeat, while a caller id is the same send again by design', async () => {
    expect(eventRowId(KEY)).not.toBe(eventRowId(KEY))
    // The hazard event-rows.ts exists for: a resend id inherits the executed line's uuid.
    await enqueueMessage(SID, NEWS, { id: 'qm-resend-1' })
    const first = await runLine()
    expect(await settledLineUuid('qm-resend-1')).toBe(first)
    const again = await enqueueMessage(SID, NEWS, { id: 'qm-resend-1' })
    expect(again.lineUuid).toBe(first)
  })
})

// ── Ratchet: every caller that names its own queue row id says why that id never recurs ──
//
// Enumerated from the source: each call of a queue entry point whose arguments carry a
// `messageId` or an `id`. A new one fails here until it is listed with its kind:
//   resend   the id names the SAME send again (a client's retry, a replay after a restart):
//            inheriting the executed line's uuid is the point, so Claude Code runs it once;
//   unique   a fresh part per event (randomUUID, a time, a nonce);
//   event    news that can recur: the id comes from eventRowId (sessions/event-rows.ts);
//   forward  passes its own caller's id on (that caller is listed or generates none).
// A stable key (a content hash, a fixed key per task or child) for news that can happen again
// is never a row id: it goes through eventRowId.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
// The queue's entry points, task_send's, and the injected send of the recovery loops.
const ENTRY = /\b(sendMessageToSession|enqueueMessage|deliverToSession|performSessionSend|deps\.send)\s*\(/g

const CALLERS: Record<string, { kind: 'resend' | 'unique' | 'event' | 'forward'; why: string }> = {
  'src/core/session-message-queue.ts': { kind: 'forward', why: 'sendMessageToSession hands its caller id to enqueueMessage' },
  'src/core/sessions/session-send-core.ts': { kind: 'forward', why: 'task_send and peer replies: the caller id for a retry, else a generated one' },
  'src/core/task-news.ts': { kind: 'event', why: 'watch news (changes, pull requests) told again later is a new event' },
  'src/core/sessions/subtask-notices.ts': { kind: 'event', why: "a child's stop, block or wait can happen again" },
  'src/core/task-dir-size-notice.ts': { kind: 'unique', why: 'tds-<task>-<time>' },
  'src/core/org/thread-reply.ts': { kind: 'unique', why: 'qm-reply-<uuid>' },
  'src/core/router/wake.ts': { kind: 'unique', why: 'a fresh nonce per wake' },
  'src/core/sessions/idle-compaction.ts': { kind: 'unique', why: 'idle-compact-<uuid>' },
  'src/core/sessions/context-full-recovery.ts': { kind: 'unique', why: 'context-compact-<uuid>, qm-context-resend-<uuid>' },
  'src/core/sessions/safeguard-switch.ts': { kind: 'unique', why: 'qm-safeguard-switch-<uuid>' },
  'src/core/session-auto-recover.ts': { kind: 'unique', why: 'qm-recover-<uuid>, or the released row it sends again' },
  'src/core/router/service.ts': { kind: 'resend', why: 'qm-route-<hash of area, item and task>: one external item to one task, once' },
  'src/web/routes/messages-v1.ts': { kind: 'forward', why: "task_send's own messageId, for its retry" },
  'src/core/subagents/registry.ts': { kind: 'resend', why: 'one id per turn of a run; told again only after a restart' },
  'src/core/routines/executors/session.ts': { kind: 'resend', why: 'qm-routine-<hash of job and slot>: one scheduled slot to its session, once (a rerun of the same slot after a restart meets the stored row)' },
  'src/core/human-inbox/letter-ops.ts': { kind: 'resend', why: "an inbox item's action, run once by the item ledger" },
  'src/core/org/lead-waits.ts': { kind: 'resend', why: 'one id per set of waits (task and phase time), told once' },
  'src/core/sessions/reply-outbox.ts': { kind: 'resend', why: 'an owed reply replayed after a restart' },
  'src/core/sessions/background-work-wake.ts': { kind: 'resend', why: 'one id per journal record version, re-read after a restart' },
  'src/core/sessions/lane-turn.ts': { kind: 'resend', why: "the chat client's own message id, kept on its retry" },
  'src/core/sessions/engine-switch-resume.ts': { kind: 'resend', why: 'one id per engine switch' },
  'src/web/routes/session-send-v1.ts': { kind: 'resend', why: "the phone's message id, kept on its retry" },
  'src/web/routes/session-chat.ts': { kind: 'resend', why: "the console's explicit Retry of one bubble" },
  'src/providers/daemon-connection.ts': { kind: 'resend', why: 'a phone message the companion relayed' },
  'src/providers/claude-code-session.ts': { kind: 'resend', why: "a session's carried first line" },
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? sourceFiles(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

/** The text of a call's argument list, from its `(`, skipping strings. */
function callArgs(src: string, open: number): string {
  let depth = 0
  let quote: string | null = null
  for (let j = open; j < src.length; j++) {
    const c = src[j]
    if (quote) { if (c === '\\') j++; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return src.slice(open, j + 1)
  }
  return src.slice(open)
}

function callersNamingIds(): Map<string, number[]> {
  const found = new Map<string, number[]>()
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(ENTRY)) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 20), m.index))) continue
      const args = callArgs(src, m.index! + m[0].length - 1)
      if (!/\bmessageId\b|[{,]\s*id\s*:/.test(args)) continue
      const rel = path.relative(ROOT, file).split(path.sep).join('/')
      found.set(rel, [...(found.get(rel) ?? []), src.slice(0, m.index).split('\n').length])
    }
  }
  return found
}

describe('callers that name their own queue row id', () => {
  const found = callersNamingIds()

  it('every one is listed with why its id never names a new event twice', () => {
    const unlisted = [...found.keys()].filter((f) => !CALLERS[f]).map((f) => `${f}:${found.get(f)!.join(',')}`)
    expect(unlisted, 'a new caller passes its own row id: list it in CALLERS, and use eventRowId for news that can recur').toEqual([])
    expect(Object.keys(CALLERS).filter((f) => !found.has(f)), 'a listed caller no longer names an id: drop it').toEqual([])
  })

  it('news that can recur gets its row id from eventRowId', () => {
    for (const [file, { kind }] of Object.entries(CALLERS)) {
      if (kind === 'event') expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).toMatch(/\beventRowId\(/)
    }
  })
})
