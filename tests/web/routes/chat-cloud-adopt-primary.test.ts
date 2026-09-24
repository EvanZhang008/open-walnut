/**
 * The PRIMARY's half of the cloud companion fallback: `server.chat.adopt`.
 *
 * When the companion answered a phone turn itself (the Mac was provably
 * unreachable), it banks the turn and hands it over once the bridge is back.
 * This file pins what the primary does with it:
 *
 *  - adoption is idempotent by turnId (a retried hand-over is a no-op) and
 *    materializes the index row of a conversation the phone created there;
 *  - a failed companion turn keeps the user's words, never a timeline error row;
 *  - GET /messages on a LANE conversation shows the adopted turn in its time
 *    position between lane turns (the prefix cut alone would hide it), and the
 *    replica relay read reports which banked turns are already adopted;
 *  - the Mac lane's next turn carries the adopted turn in its catch-up banner,
 *    even when the lane's high-water mark had already moved past the turn's own
 *    clock (it only became known here at adoption time).
 *
 * Real: startServer (primary), api-v1 router, session-controls dispatch,
 * chat-history + conversation index, lane records in SQLite, the transcript read
 * pipeline against JSONL on disk, runLaneTurn and its catch-up.
 * Mocked: constants (temp dirs), the '__local__' daemon file reader (fixture
 * HOME), and the 'session-runner' bus subscriber (a fake CLI that never spawns).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-chat-cloud-adopt'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

/** Runs once, right BEFORE the next store read that builds a messages page. */
const beforePageRead = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock('../../../src/core/chat-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/chat-history.js')>()
  return {
    ...actual,
    getDisplayEntries: async (...args: Parameters<typeof actual.getDisplayEntries>) => {
      const hook = beforePageRead.fn
      beforePageRead.fn = null
      if (hook) await hook()
      return actual.getDisplayEntries(...args)
    },
  }
})

import { WALNUT_HOME, CLAUDE_HOME, conversationFile } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { createConversation, listConversations } from '../../../src/core/conversations.js'
import * as chatHistory from '../../../src/core/chat-history.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'
import type { ChatEntry } from '../../../src/core/types.js'

const LANE_CWD = '/Users/test/cloud-adopt'

let server: HttpServer
let port: number
let sends: SessionSendEvent[] = []
const drains = new Set<Promise<void>>()

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/** Fake CLI: consumes the send and answers on the next tick. */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name !== EventNames.SESSION_SEND) return
    const d = event.data as SessionSendEvent
    sends.push(d)
    const p = (async () => {
      try {
        const batch = await markProcessing(d.sessionId)
        if (batch.length > 0) await removeProcessed(d.sessionId, batch.map((m) => m.id))
      } catch { /* torn down */ }
    })()
    drains.add(p)
    void p.finally(() => drains.delete(p))
    setTimeout(() => {
      bus.emit(EventNames.SESSION_RESULT, { sessionId: d.sessionId, result: 'mac answer', isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 10)
  })
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()

function adoptPayload(conversationId: string, turnId: string, extra: Record<string, unknown> = {}) {
  return {
    v: 1, turnId, agentId: 'general', conversationId,
    userText: 'asked while the mac slept', userAt: at(4),
    answerText: 'answered by the cloud companion', answeredAt: at(5),
    engine: 'cloud:companion-lane-1',
    ...extra,
  }
}

async function adopt(payload: Record<string, unknown>) {
  return handleSessionControlRelay('server.chat.adopt', '__server__', payload)
}

async function readEntries(conversationId: string): Promise<ChatEntry[]> {
  const raw = JSON.parse(await fs.readFile(conversationFile('general', conversationId), 'utf-8')) as { entries?: ChatEntry[] }
  return raw.entries ?? []
}

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(LANE_CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

let seq = 0
const userLine = (text: string, timestamp: string) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp, message: { role: 'user', content: text },
})
const asstLine = (text: string, timestamp: string) => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp,
  message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
})

/** A Mac lane session with two turns: 10:01/10:02 and 10:07/10:08. */
async function seedMacLane(conversationId: string, sessionId: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', LANE_CWD, {
    title: 'Lane session', lane: `chat:general:${conversationId}`, initialProcessStatus: 'idle',
  })
  await updateSessionRecord(sessionId, { startedAt: at(0) })
  await writeJsonl(sessionId, [
    userLine('mac question one', at(1)), asstLine('mac answer one', at(2)),
    userLine('mac question two', at(7)), asstLine('mac answer two', at(8)),
  ])
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  installFakeRunner()
}, 90_000)

afterAll(async () => {
  await Promise.allSettled([...drains])
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { sends = [] })

describe('server.chat.adopt is idempotent by turnId', () => {
  it('writes the turn once, a retry is a no-op, and a phone-created conversation gets its row', async () => {
    const conversationId = 'conv-created-on-the-phone-1'
    const first = await adopt(adoptPayload(conversationId, 'turn-adopt-0001'))
    expect(first).toEqual({ ok: true, result: { turnId: 'turn-adopt-0001', adopted: true, duplicate: false } })
    const retry = await adopt(adoptPayload(conversationId, 'turn-adopt-0001'))
    expect(retry).toEqual({ ok: true, result: { turnId: 'turn-adopt-0001', adopted: false, duplicate: true } })

    const entries = await readEntries(conversationId)
    expect(entries.map((e) => [e.role, e.turnId])).toEqual([
      ['user', 'turn-adopt-0001'], ['assistant', 'turn-adopt-0001'],
    ])
    const answer = entries[1] as ChatEntry & { engine?: string; adoptedFrom?: string }
    expect(answer.engine).toBe('cloud:companion-lane-1')
    expect(answer.timestamp).toBe(at(5))
    expect(chatHistory.isAdoptedCloudEntry(answer)).toBe(true)
    expect((await listConversations('general')).some((c) => c.id === conversationId)).toBe(true)
  })

  it('a failed companion turn keeps the words and shows no error row in the timeline', async () => {
    const conv = await createConversation('general')
    const res = await adopt(adoptPayload(conv.id, 'turn-adopt-fail-01', {
      answerText: undefined, answeredAt: undefined, error: 'The cloud companion did not answer this turn.',
    }))
    expect(res).toMatchObject({ ok: true, result: { adopted: true } })
    const entries = await readEntries(conv.id)
    expect(entries).toHaveLength(2)
    expect(entries[1].source).toBe('agent-error')
    const rows = await (await fetch(apiUrl(`/api/v1/conversations/${conv.id}/messages`))).json() as Array<{ text: string }>
    expect(rows.map((r) => r.text)).toEqual(['asked while the mac slept'])
  })

  it('refuses a malformed payload as a domain error (the replica then drops it)', async () => {
    const res = await adopt({ ...adoptPayload('conv-x-1', '../../etc'), turnId: '../../etc' })
    expect(res).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })
})

describe('an adopted turn in a lane conversation', () => {
  it('GET slots it between lane turns by time, and the relay read reports it adopted', async () => {
    const conv = await createConversation('general')
    await seedMacLane(conv.id, 'mac-lane-assembly-1')
    await adopt(adoptPayload(conv.id, 'turn-adopt-lane-01'))

    const rows = await (await fetch(apiUrl(`/api/v1/conversations/${conv.id}/messages`))).json() as Array<{ id: string; text: string }>
    expect(rows.map((r) => r.text)).toEqual([
      'mac question one', 'mac answer one',
      'asked while the mac slept', 'answered by the cloud companion',
      'mac question two', 'mac answer two',
    ])
    expect(rows.map((r) => r.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])

    const relayed = await handleSessionControlRelay('server.chat.messages', '__server__', {
      agentId: 'general', conversationId: conv.id, limit: 50,
      pendingTurnIds: ['turn-adopt-lane-01', 'turn-not-adopted-01'],
    })
    expect(relayed).toMatchObject({ ok: true, result: { source: 'lane', adoptedTurnIds: ['turn-adopt-lane-01'] } })
  })

  it.each([
    ['a lane conversation', true],
    ['a plain chat-history conversation', false],
  ])('%s: an adoption landing mid-read is reported adopted exactly when the page holds it', async (_label, lane) => {
    // The window the old code had: the adopted list was read first, then the
    // page. An adoption committing in between put the turn in the page but not
    // in the list, and the replica merged its banked copy: one turn, twice.
    const conv = await createConversation('general')
    if (lane) await seedMacLane(conv.id, `mac-lane-race-${conv.id}`)
    const turnId = lane ? 'turn-adopt-race-lane' : 'turn-adopt-race-plain'
    beforePageRead.fn = async () => { await adopt(adoptPayload(conv.id, turnId)) }
    const relayed = await handleSessionControlRelay('server.chat.messages', '__server__', {
      agentId: 'general', conversationId: conv.id, limit: 50, pendingTurnIds: [turnId, 'turn-not-adopted-02'],
    }) as { ok: true; result: { source: string; messages: Array<{ text: string }>; adoptedTurnIds: string[] } }
    expect(beforePageRead.fn).toBeNull() // the adoption really ran inside the read
    expect(relayed.result.source).toBe(lane ? 'lane' : 'chat-history')
    expect(relayed.result.messages.map((r) => r.text)).toContain('asked while the mac slept')
    expect(relayed.result.adoptedTurnIds).toEqual([turnId])
  })

  it('the Mac lane\'s next turn carries it, even with a mark already past the turn\'s own clock', async () => {
    const conv = await createConversation('general')
    const laneSid = 'mac-lane-catchup-1'
    await seedMacLane(conv.id, laneSid)
    // The lane was caught up to 10:06 BEFORE the companion's 10:04 turn reached
    // this box; only its adoption time makes it new to the lane.
    await chatHistory.recordLaneSeen('general', conv.id, chatHistory.laneEngineLabel(laneSid), at(6))
    await adopt(adoptPayload(conv.id, 'turn-adopt-catchup-01'))

    const res = await fetch(apiUrl(`/api/v1/conversations/${conv.id}/messages`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'what did the cloud tell me?' }),
    })
    expect(res.status).toBe(202)
    const deadline = Date.now() + 15_000
    while (sends.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    expect(sends).toHaveLength(1)
    expect(sends[0].sessionId).toBe(laneSid)
    expect(sends[0].message).toContain(chatHistory.CATCH_UP_BANNER_OPEN)
    expect(sends[0].message).toContain('asked while the mac slept')
    expect(sends[0].message).toContain('answered by the cloud companion')
    expect(sends[0].message.endsWith('what did the cloud tell me?')).toBe(true)
  })
})
