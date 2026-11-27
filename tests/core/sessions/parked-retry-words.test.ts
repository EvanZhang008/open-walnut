/**
 * The chat's word on a parked row is the server's retry rule, never its own guess (pain pn-79fe0af3,
 * 2026-11-22, the user on a row the chat called "Not delivered. Auto-retry stopped (Not
 * acknowledged: Claude Code read past this message ...)": "why not keep retrying it"). Since
 * 2026-11-23 the clock tries such a row again for good (delivery-retry.ts, its class guard in
 * delivery-retry.test.ts "every park reason in src/ is classified"), but the chat still said it had
 * stopped. Pinned here:
 *  - retryTimesOf (the chat's read) names a row exactly when the sweep's rule sends it by itself,
 *    and the sweep does send it at that time: the pain's own reason included;
 *  - a Stop's park, a row only a person can fix, and a session left alone name none;
 *  - the chat's queue read carries it, and no web source claims retrying stopped.
 * Real queue file and session store; the runner's "is a turn running" answer is scripted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-parked-retry-words') }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { enqueueMessage, getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import { parkMessages } from '../../../src/core/session-queue-park.js'
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { STOP_PARKED_REASON } from '../../../src/core/relay-fates.js'
import { nextRetryAt, retryTimesOf, stopDeliveryRetry, sweepDeliveryRetries } from '../../../src/core/sessions/delivery-retry.js'
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js'
import { _getRpcMethodForTesting } from '../../../src/web/ws/handler.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const SID = 'eeeeeeee-2222-4333-8444-666666666666'
/** The words the pain's row was parked with (claude-code-session.ts LINE_UNACKNOWLEDGED_KEPT_REASON). */
const READ_PAST = 'Not acknowledged: Claude Code read past this message and Walnut could not write it again. '
  + 'The message is kept: if Claude Code runs it later, it shows then. Retry sends it again without making a second copy.'

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  stopDeliveryRetry()
  vi.spyOn(sessionRunner, 'isTurnRunning').mockReturnValue(false)
  await createSessionRecord(SID, 't-words', 'Acme', '/tmp', { initialProcessStatus: 'idle' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  stopDeliveryRetry()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

async function parked(text: string, reason: string) {
  const row = await enqueueMessage(SID, text, { sentBy: 'agent' })
  await parkMessages([row], reason)
  return (await getQueue(SID)).find((m) => m.id === row.id)!
}

describe('the chat says a parked row is tried again exactly when the sweep tries it', () => {
  it('the pain\'s row (Claude Code read past it): a next try, and the sweep sends it then', async () => {
    const row = await parked('the change watch news', READ_PAST)
    const at = (await retryTimesOf(SID, await getQueue(SID))).get(row.id)
    expect(at).toBeGreaterThan(Date.parse(row.parkedAt!))
    // Not before its time; at its time it goes back in line by itself.
    expect(await sweepDeliveryRetries(at! - 1000)).toEqual([])
    expect(await sweepDeliveryRetries(at!)).toEqual([row.id])
    expect((await getQueue(SID)).find((m) => m.id === row.id)?.status).toBe('pending')
  })

  it('a Stop\'s park, a row only a person can fix, and a session left alone: no promise', async () => {
    const stop = await parked('stopped words', STOP_PARKED_REASON)
    const gone = await parked('to a deleted session', 'No active session found for session id 1234; it cannot be resumed')
    const times = await retryTimesOf(SID, await getQueue(SID))
    expect(times.has(stop.id)).toBe(false)
    // Whatever the sweep makes of a row, the chat says the same.
    const later = Date.now() + 24 * 3600_000
    const sent = new Set(await sweepDeliveryRetries(later))
    expect(times.has(gone.id)).toBe(sent.has(gone.id))
    const retried = await parked('retried words', READ_PAST)
    await updateSessionRecord(SID, { archived: true } as never)
    expect((await retryTimesOf(SID, await getQueue(SID))).has(retried.id)).toBe(false)
  })
})

describe('the chat reads the server\'s word', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8')

  it('the chat\'s real queue read gives the clock\'s row its next try, and the Stop\'s row none', async () => {
    const retried = await parked('the change watch news', READ_PAST)
    const stop = await parked('stopped words', STOP_PARKED_REASON)
    registerSessionChatRpc()
    const method = _getRpcMethodForTesting('session:get-queue')!
    const res = await method({ sessionId: SID }, undefined as never) as { messages: Array<{ id: string; autoRetryAt?: string }> }
    const byId = new Map(res.messages.map((m) => [m.id, m]))
    expect(byId.get(retried.id)?.autoRetryAt).toBe(new Date(nextRetryAt(retried)).toISOString())
    expect(byId.has(stop.id)).toBe(true)
    expect(byId.get(stop.id)?.autoRetryAt).toBeUndefined()
  })

  it('every word of "Walnut tries it again" reads one rule: the sweep\'s', () => {
    const retry = read('src/core/sessions/delivery-retry.ts')
    const fn = (name: string) => retry.slice(retry.indexOf(name), retry.indexOf('\n}\n', retry.indexOf(name)))
    expect(fn('export async function retryTimesOf(')).toMatch(/await clockRule\(sessionId\)/)
    expect(fn('export async function parkRetriedByClock(')).toMatch(/await clockRule\(row\.sessionId\)/)
    expect(fn('async function clockRule(')).toMatch(/retriesBySelf\(row, fence, codeOf\)/)
    expect(fn('async function clockRule(')).toMatch(/leftAlone\(sessionId\)/)
  })

  it('no web source says retrying stopped or gave up; a parked bubble\'s words come from parkedWords', () => {
    const CLAIM = /(auto-?retry|retr(y|ying|ies)|trying)\W{0,3}(\w+\W+){0,3}(stopped|gave up|given up|ended)|stopped (auto-?)?retrying|no (more|longer) (auto-?)?retr/i
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        read(rel).split('\n').forEach((line, i) => {
          // Comments may name the old words; only text a reader can see counts.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
          if (CLAIM.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
      }
    }
    walk('web/src')
    expect(hits).toEqual([])
    // The scan itself sees the old words (so an empty list means none, not a scan that reads nothing).
    expect(CLAIM.test('Not delivered. Auto-retry stopped (x)')).toBe(true)
    const history = read('web/src/components/sessions/SessionChatHistory.tsx')
    expect(history).toMatch(/m\.parked\s*\n?\s*\? parkedWords\(m\.failedError, m\.autoRetryAt\)/)
  })
})
