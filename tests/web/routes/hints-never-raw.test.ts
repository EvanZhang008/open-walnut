/**
 * No read a person's screen draws from ever shows a Walnut hint block raw
 * (2026-10-31, the user: "reply ... Chinese, what is this thing, where does it
 * come from?"). The blocks are for the model; a person reads, in plain words,
 * what Walnut added and why, with the exact text one step away (`rawText`,
 * `rawMessage`, a hint's own `text`).
 *
 * The class: every builder of text a client shows. A new read that hands a
 * composed message to a client fails here when it is added to READS. Seeded
 * with each place a block is known to appear: a person's row, a CLI-injected
 * Walnut message, the post-compaction hook's added context (which restates the
 * hints), and a queued row still waiting for the CLI.
 *
 * Real: Express server, every route below, session records, the queue store,
 * the read pipelines over JSONL on disk. Mocked: constants (temp dirs) and the
 * local daemon file reader (it expands `~/.claude` from its own HOME).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hints-never-raw'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { composeHinted, renderHintBlock } from '../../../src/core/hints/hint-format.js'
import { enqueueMessage } from '../../../src/core/session-message-queue.js'
import { transcriptFromJsonl } from '../../../src/core/sessions/transcript-from-jsonl.js'
import { voiceReplyBlock } from '../../../src/core/sessions/voice-reply.js'

const CWD = '/Users/test/hints-never-raw'
const SID = 'sess-hints-never-raw'
const RULE = 'Talk to the user in Chinese; code stays English.'
const LANG = renderHintBlock('reply-language', RULE)
const RICH = renderHintBlock('rich-output', 'rich output mode is still on: markdown first.')
const PERSON = 'Please draft the release notes.'
const PEER = '<walnut-message kind="peer-note" from="Docs lead [aaaaaaaa]">\nThe review is done.\n</walnut-message>'
const QUEUED = 'One more thing about the notes.'

let server: HttpServer
let port: number
let seq = 0
const at = (): string => new Date(Date.UTC(2026, 9, 31, 0, 0, ++seq)).toISOString()
const userLine = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text }] }, ...extra,
})
const assistantLine = (text: string): Record<string, unknown> => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: at(), message: { id: `msg_${seq}`, role: 'assistant', content: [{ type: 'text', text }] },
})

function lines(): Record<string, unknown>[] {
  return [
    userLine(composeHinted(PERSON, { before: [], after: [RICH, LANG, voiceReplyBlock()] })),
    assistantLine('Drafted.'),
    // After a compaction the open-items hook restates the hints (hint-send.ts stateHintsAfterCompaction).
    { type: 'attachment', uuid: `h-${++seq}`, timestamp: at(),
      attachment: { type: 'hook_additional_context', content: [`Open items: none.\n\n${RICH}\n${LANG}`], hookName: 'SessionStart:compact', hookEvent: 'SessionStart' } },
    userLine(`${PEER}\n\n${LANG}`, { isMeta: true }),
    userLine(composeHinted('Thanks.', { before: [], after: [LANG] })),
    assistantLine('Noted.'),
  ]
}

/** Fields that hold the exact text on purpose, one step from the plain view. */
const RAW_FIELDS = new Set(['rawText', 'rawMessage'])

/** Every string a client would draw, with where it sits. */
function shownStrings(value: unknown, where = '$'): Array<[string, string]> {
  if (typeof value === 'string') return [[where, value]]
  if (Array.isArray(value)) return value.flatMap((v, i) => shownStrings(v, `${where}[${i}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !RAW_FIELDS.has(k))
      .flatMap(([k, v]) => shownStrings(v, `${where}.${k}`))
  }
  return []
}

function expectNoRawBlock(body: unknown, read: string): void {
  const leaks = shownStrings(body).filter(([, s]) => s.includes('<system-reminder') || /Walnut \([a-z][a-z0-9-]*[ )]/.test(s))
  expect(leaks.map(([w, s]) => `${read} ${w}: ${s.slice(0, 120)}`)).toEqual([])
}

async function get(p: string): Promise<unknown> {
  const res = await fetch(`http://localhost:${port}${p}`)
  expect(res.status, p).toBe(200)
  return res.json()
}

/** Every read a client draws a conversation or a queue from. Add a new one here. */
const READS = [
  `/api/sessions/${SID}/history`,
  `/api/sessions/${SID}/history?tail=800&turns=20`,
  `/api/v1/sessions/${SID}/history`,
  `/api/v1/sessions/${SID}/transcript?fresh=1&rich=1`,
  `/api/v1/sessions/${SID}/transcript?fresh=1`,
  `/api/v1/sessions/${SID}/queue`,
]

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await createSessionRecord(SID, '', '', CWD, { title: 'Release notes', initialProcessStatus: 'idle' })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${SID}.jsonl`), lines().map((l) => JSON.stringify(l)).join('\n') + '\n')
  // A row still waiting for the CLI, composed as the queue composes it.
  await enqueueMessage(SID, composeHinted(QUEUED, { before: [], after: [LANG] }), { sentBy: 'person' })
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a Walnut hint block never reaches a person raw', () => {
  it.each(READS)('%s', async (read) => {
    expectNoRawBlock(await get(read), read)
  })

  it("the companion's JSONL reader too", () => {
    expectNoRawBlock(transcriptFromJsonl(SID, lines().map((l) => JSON.stringify(l)).join('\n')), 'transcriptFromJsonl')
  })

  it('says in plain words what Walnut added and why, the exact text one step away', async () => {
    const t = (await get(`/api/v1/sessions/${SID}/transcript?fresh=1&rich=1`)) as {
      messages: Array<{ role: string; text: string; added?: Array<{ name: string; label: string; text: string }>; injectedAfter?: Array<{ text: string }> }>
    }
    const person = t.messages.find((m) => m.role === 'user' && m.text.startsWith(PERSON))!
    expect(person.added?.map((a) => a.label)).toEqual([
      'a reminder that rich output is on (your Output mode setting)',
      'a request to write to you in Chinese (your Reply language setting)',
      'a request for a short spoken answer first, because you sent this by voice',
    ])
    expect(person.added?.[1].text).toContain(RULE)
    // The hook's restated hints read as plain lines with their exact words.
    const hook = JSON.stringify(t.messages)
    expect(hook).toContain('Walnut added a request to write to you in Chinese (your Reply language setting). Exact text: \\"Talk to the user in Chinese')
    const q = (await get(`/api/v1/sessions/${SID}/queue`)) as { messages: Array<{ message: string; rawMessage?: string; hints?: Array<{ kind: string }> }> }
    expect(q.messages[0].message).toBe(QUEUED)
    expect(q.messages[0].rawMessage).toContain('Walnut (reply-language)')
    expect(q.messages[0].hints?.map((h) => h.kind)).toEqual(['reply-language'])
  })
})
