/**
 * GET /api/v1/sessions/:id/transcript: every USER row says who sent it
 * (`sentBy`, additive 2026-10).
 *
 * The phone showed a peer's `<walnut-message …>` envelope as the user's own
 * right-side bubble, raw XML and all, because a transcript row only said
 * `role: "user"`. The web console tells the two apart from the stored row
 * (lib/history-turn-window.ts); the phone has no envelope parser and reads
 * clipped text, so the server names the sender once and both builders answer
 * with the same word:
 *  - the primary's projection, over HTTP on the fresh read and the slim one;
 *  - the companion's / host server's JSONL reader (transcriptFromJsonl).
 * Assistant and kind rows never carry it, and a person's words behind Walnut's
 * riders are still the person's.
 *
 * Real: Express server, api-v1 router, session records, the whole read
 * pipeline over JSONL on disk. Mocked: constants (temp dirs) and the local
 * daemon file reader (it expands `~/.claude` from its own HOME).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-sent-by'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { transcriptFromJsonl } from '../../../src/core/sessions/transcript-from-jsonl.js'

const CWD = '/Users/test/transcript-sent-by'

let server: HttpServer
let port: number

interface Row { role: string; text: string; kind?: string; sentBy?: string }

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString()
const userLine = (text: string): Record<string, unknown> => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(),
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistantLine = (id: string, blocks: unknown[]): Record<string, unknown> => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
  message: { id, role: 'assistant', content: blocks },
})

const PEER_NOTE = '<walnut-message kind="peer-note" from="Docs lead [aaaaaaaa]">\nThe review is done, nothing for you.\n</walnut-message>'
const RIDER = '<walnut-message kind="notification" from="Walnut" outcome="moved">\nThis task moved to the folder Release.\n</walnut-message>'
const PERSON = 'Can you check the release notes?'

function lines(): Record<string, unknown>[] {
  return [
    userLine(PERSON),
    assistantLine('msg_a', [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/notes.md' } },
    ]),
    { type: 'user', uuid: `tr-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'notes' }] } },
    assistantLine('msg_b', [{ type: 'text', text: 'They read fine.' }]),
    userLine(PEER_NOTE),
    assistantLine('msg_c', [{ type: 'text', text: '<walnut-turn status="agent-ack"/>' }]),
    userLine(`${RIDER}\n\nAnd the changelog?`),
    userLine('[Request interrupted by user]'),
  ]
}

async function seed(sessionId: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', CWD, { title: 'Release check', initialProcessStatus: 'idle' })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines().map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function transcript(sid: string, qs: string): Promise<Row[]> {
  const res = await fetch(`http://localhost:${port}/api/v1/sessions/${sid}/transcript${qs}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

const senders = (rows: Row[]) => rows.filter((r) => r.role === 'user').map((r) => [r.text.slice(0, 18), r.sentBy])

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('transcript sentBy', () => {
  it('names the person, the delivery and the CLI line, on the fresh rich read and the slim one', async () => {
    const sid = 'sess-sent-by'
    await seed(sid)
    const expected = [
      [PERSON.slice(0, 18), 'person'],
      [PEER_NOTE.slice(0, 18), 'agent'],
      // A person's words behind Walnut's place note are still the person's.
      [RIDER.slice(0, 18), 'person'],
      ['[Request interrupt', 'cli'],
    ]
    for (const qs of ['?fresh=1&rich=1', '?fresh=1']) {
      const rows = await transcript(sid, qs)
      expect(senders(rows), qs).toEqual(expected)
      // Only user text rows carry it.
      expect(rows.filter((r) => r.role !== 'user').every((r) => r.sentBy === undefined), qs).toBe(true)
    }
  })

  it('the companion\'s JSONL reader answers with the same words', () => {
    const jsonl = lines().map((l) => JSON.stringify(l)).join('\n')
    const rows = (transcriptFromJsonl('sess-sent-by-bridge', jsonl).messages as Row[])
    // That reader drops the interrupt marker; the rest match the primary.
    expect(senders(rows)).toEqual([
      [PERSON.slice(0, 18), 'person'],
      [PEER_NOTE.slice(0, 18), 'agent'],
      [RIDER.slice(0, 18), 'person'],
    ])
    expect(rows.filter((r) => r.role !== 'user').every((r) => r.sentBy === undefined)).toBe(true)
  })
})
