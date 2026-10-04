/**
 * The PRIMARY labels the replies the cloud companion gave while it was
 * unreachable: `answeredBy: 'cloud'` on the assistant text row of an adopted
 * turn in GET /api/v1/conversations/:id/messages, so a reloaded conversation
 * can still say "answered on the cloud". And its /status never claims the
 * companion-only `cloudChat` field.
 *
 * Real: startServer (primary), the api-v1 router, chat-history writers
 * (addUserMessage / addAIMessages / adoptCloudTurn), lane records in SQLite, the
 * transcript read pipeline against JSONL on disk, session-controls dispatch for
 * the relay read the replica uses.
 * Mocked: constants (temp dirs) and the '__local__' daemon file reader (fixture
 * HOME).
 *
 * Matrix: plain conversation with Mac-answered turns (lane-stamped and
 * unstamped) around an adopted one; an adoption older than every Mac turn
 * (inserted mid-list); the engine-stamp branch with kind rows; a failed
 * adopted turn; a lane conversation (adoptedCloudRows) and the relay read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-answered-by-primary'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { createConversation } from '../../../src/core/conversations.js'
import * as chatHistory from '../../../src/core/chat-history.js'

const LANE_CWD = '/Users/test/answered-by'
const CLOUD_ENGINE = chatHistory.cloudEngineLabel('companion-lane-1')

let server: HttpServer
let port: number

interface Row { id: string; role: string; text: string; kind?: string; answeredBy?: string }

async function getMessages(conversationId: string): Promise<Row[]> {
  const res = await fetch(`http://localhost:${port}/api/v1/conversations/${conversationId}/messages`)
  expect(res.status).toBe(200)
  return await res.json() as Row[]
}

const shape = (rows: Row[]) => rows.map((r) => [r.id, r.role, r.kind ?? '-', r.text, r.answeredBy ?? '-'])

/** A turn exactly as the primary's own senders persist it. */
async function persistMacTurn(
  conversationId: string, question: string, answer: string, stamp: 'lane' | 'unstamped',
): Promise<void> {
  const turnId = crypto.randomUUID()
  await chatHistory.addUserMessage(question, { displayText: question, turnId, agentId: 'general', conversationId })
  await chatHistory.addAIMessages(
    [{ role: 'assistant', content: [{ type: 'text', text: answer }] }] as never,
    {
      agentId: 'general', conversationId,
      ...(stamp === 'lane' ? { engine: chatHistory.laneEngineLabel('mac-lane-1') } : { turnId }),
    },
  )
}

async function adopt(conversationId: string, turnId: string, over: Partial<chatHistory.CloudTurnAdoption> = {}) {
  const userAt = over.userAt ?? new Date().toISOString()
  return chatHistory.adoptCloudTurn({
    agentId: 'general', conversationId, turnId,
    userText: 'asked while the mac slept', userAt,
    answerText: 'answered by the cloud companion', answeredAt: userAt,
    engine: CLOUD_ENGINE,
    ...over,
  })
}

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(LANE_CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 10, minute)).toISOString()
let seq = 0
const userLine = (text: string, timestamp: string) => ({
  type: 'user', uuid: `u-${++seq}`, timestamp, message: { role: 'user', content: text },
})
const asstLine = (text: string, timestamp: string) => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp,
  message: { role: 'assistant', id: `msg-${seq}`, content: [{ type: 'text', text }] },
})

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 90_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/status on the primary', () => {
  it('has no cloudChat key (nor the other companion-only fields)', async () => {
    const res = await fetch(`http://localhost:${port}/api/v1/status`)
    expect(res.status).toBe(200)
    const status = await res.json() as Record<string, unknown>
    expect(status.mode).toBe('LIVE')
    expect('cloudChat' in status).toBe(false)
    expect('cloudExec' in status).toBe(false)
    expect('bridgeHosts' in status).toBe(false)
  })
})

describe('a plain chat-history conversation', () => {
  it('labels the adopted answer only: not its user row, not the Mac turns around it', async () => {
    const conv = await createConversation('general')
    await persistMacTurn(conv.id, 'first question', 'mac answer one', 'lane')
    expect(await adopt(conv.id, 'turn-answered-by-0001')).toBe('adopted')
    await persistMacTurn(conv.id, 'second question', 'mac answer two', 'unstamped')

    const rows = await getMessages(conv.id)
    expect(shape(rows)).toEqual([
      ['m0', 'user', '-', 'first question', '-'],
      ['m1', 'assistant', '-', 'mac answer one', '-'],
      ['m2', 'user', '-', 'asked while the mac slept', '-'],
      ['m3', 'assistant', '-', 'answered by the cloud companion', 'cloud'],
      ['m4', 'user', '-', 'second question', '-'],
      ['m5', 'assistant', '-', 'mac answer two', '-'],
    ])
    // The adopted user entry carries the same provenance, yet its row is not
    // labelled: the field means "who answered", and a user row answers nothing.
    expect(rows.filter((r) => 'answeredBy' in r).map((r) => r.id)).toEqual(['m3'])

    // The replica reads this conversation through the relay: the same rows, the
    // same field, so it can pass them to the phone verbatim.
    const relayed = await handleSessionControlRelay('server.chat.messages', '__server__', {
      agentId: 'general', conversationId: conv.id, limit: 50,
    }) as { ok: true; result: { source: string; messages: Row[] } }
    expect(relayed.result.source).toBe('chat-history')
    expect(shape(relayed.result.messages)).toEqual(shape(rows))
  })

  it('an adoption older than every Mac turn lands first by time, and the label moves with it', async () => {
    const conv = await createConversation('general')
    await persistMacTurn(conv.id, 'a later mac question', 'a later mac answer', 'lane')
    await adopt(conv.id, 'turn-answered-by-early', { userAt: new Date(Date.now() - 3_600_000).toISOString() })
    expect(shape(await getMessages(conv.id))).toEqual([
      ['m0', 'user', '-', 'asked while the mac slept', '-'],
      ['m1', 'assistant', '-', 'answered by the cloud companion', 'cloud'],
      ['m2', 'user', '-', 'a later mac question', '-'],
      ['m3', 'assistant', '-', 'a later mac answer', '-'],
    ])
  })

  it('an answer stamped with a cloud lane engine (the synced-copy branch): text row labelled, kind rows not', async () => {
    const conv = await createConversation('general')
    await chatHistory.addUserMessage('check the notes', {
      displayText: 'check the notes', turnId: crypto.randomUUID(), agentId: 'general', conversationId: conv.id,
    })
    // One API message in the model's own order: thinking, the text, then the tool
    // call it ends on. The rows keep that order (text above the calls it announces).
    await chatHistory.addAIMessages([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The notes file should say.' },
        { type: 'text', text: 'The notes say water the plants.' },
        { type: 'tool_use', id: 'tu-notes-1', name: 'Read', input: { file_path: '/srv/notes.md' } },
      ],
    }] as never, { agentId: 'general', conversationId: conv.id, engine: chatHistory.cloudEngineLabel('companion-lane-2') })

    const rows = await getMessages(conv.id)
    expect(rows.map((r) => [r.role, r.kind ?? '-', r.answeredBy ?? '-'])).toEqual([
      ['user', '-', '-'],
      ['assistant', 'thinking', '-'],
      ['assistant', '-', 'cloud'],
      ['assistant', 'tool', '-'],
    ])
  })

  it('a failed adopted turn: the words stay, and no row claims a cloud answer', async () => {
    const conv = await createConversation('general')
    await adopt(conv.id, 'turn-answered-by-fail', {
      answerText: undefined, answeredAt: undefined, error: 'The cloud companion did not answer this turn.',
    })
    const rows = await getMessages(conv.id)
    expect(shape(rows)).toEqual([['m0', 'user', '-', 'asked while the mac slept', '-']])
  })
})

describe('a lane conversation (adopted rows slotted between lane turns)', () => {
  it('labels the adopted answer only, never a lane row, on the direct read and the relay read', async () => {
    const conv = await createConversation('general')
    const laneSid = 'mac-lane-answered-by-1'
    await createSessionRecord(laneSid, '', '', LANE_CWD, {
      title: 'Lane session', lane: `chat:general:${conv.id}`, initialProcessStatus: 'idle',
    })
    await updateSessionRecord(laneSid, { startedAt: at(0) })
    await writeJsonl(laneSid, [
      userLine('mac question one', at(1)), asstLine('mac answer one', at(2)),
      userLine('mac question two', at(7)), asstLine('mac answer two', at(8)),
    ])
    await adopt(conv.id, 'turn-answered-by-lane', { userAt: at(4), answeredAt: at(5) })

    const rows = await getMessages(conv.id)
    expect(shape(rows)).toEqual([
      ['m0', 'user', '-', 'mac question one', '-'],
      ['m1', 'assistant', '-', 'mac answer one', '-'],
      ['m2', 'user', '-', 'asked while the mac slept', '-'],
      ['m3', 'assistant', '-', 'answered by the cloud companion', 'cloud'],
      ['m4', 'user', '-', 'mac question two', '-'],
      ['m5', 'assistant', '-', 'mac answer two', '-'],
    ])

    const relayed = await handleSessionControlRelay('server.chat.messages', '__server__', {
      agentId: 'general', conversationId: conv.id, limit: 50,
    }) as { ok: true; result: { source: string; messages: Row[] } }
    expect(relayed.result.source).toBe('lane')
    expect(shape(relayed.result.messages)).toEqual(shape(rows))
  })
})
