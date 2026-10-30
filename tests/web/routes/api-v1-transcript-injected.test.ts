/**
 * GET /api/v1/sessions/:id/transcript: the lines the CLI put into a conversation
 * itself reach the phone (2026-10-30, the user: nothing Walnut or the CLI adds may
 * stay invisible; the phone dropped every one).
 *
 * They ride the row before them (`injectedAfter`, or `injectedBefore` on the first
 * row), never as rows of their own: an older phone draws any user row as the
 * person's bubble. Checked on both builders:
 *  - the primary's projection, over HTTP on the fresh rich read and the slim one;
 *  - the companion's / host server's JSONL reader (transcriptFromJsonl), which
 *    also says what Walnut added to a person's message (`added`) as the primary does.
 * A SessionStart hook's context before every row, a loaded skill's text after the
 * Skill call, a Walnut message the CLI delivered as an injected line (drawn as
 * that message), and the CLI's injected interrupt marker (dropped).
 *
 * Real: Express server, api-v1 router, session records, the whole read pipeline
 * over JSONL on disk. Mocked: constants (temp dirs) and the local daemon file
 * reader (it expands `~/.claude` from its own HOME).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-transcript-injected'))
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { WALNUT_HOME, CLAUDE_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../../src/core/session-history.js'
import { renderHintBlock } from '../../../src/core/hints/hint-format.js'
import { transcriptFromJsonl } from '../../../src/core/sessions/transcript-from-jsonl.js'

const CWD = '/Users/test/transcript-injected'

let server: HttpServer
let port: number

interface Item { kind: string; label: string; text: string }
interface Row {
  role: string; text: string; kind?: string; sentBy?: string
  injectedAfter?: Item[]; injectedBefore?: Item[]; added?: Item[]
}

let seq = 0
const at = (): string => new Date(Date.UTC(2026, 0, 2, 0, 0, ++seq)).toISOString()
const userLine = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user', uuid: `u-${++seq}`, timestamp: at(),
  message: { role: 'user', content: [{ type: 'text', text }] }, ...extra,
})
const assistantLine = (id: string, blocks: unknown[]): Record<string, unknown> => ({
  type: 'assistant', uuid: `a-${++seq}`, timestamp: at(),
  message: { id, role: 'assistant', content: blocks },
})

const HOOK = 'Open items: one review is still waiting.'
const SKILL = 'Base directory for this skill: /home/test/.claude/skills/release-notes\n\n# Release notes\n\nWrite them short.'
const PEER_NOTE = '<walnut-message kind="peer-note" from="Docs lead [aaaaaaaa]">\nThe review is done.\n</walnut-message>'
const PERSON = 'Please draft the release notes.'

function lines(): Record<string, unknown>[] {
  return [
    { type: 'attachment', uuid: `h-${++seq}`, timestamp: at(),
      attachment: { type: 'hook_additional_context', content: [HOOK], hookName: 'SessionStart:startup', hookEvent: 'SessionStart' } },
    userLine(`${PERSON}\n\n${renderHintBlock('rich-output', 'rich output mode is on.')}`),
    assistantLine('msg_a', [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'release-notes' } }]),
    { type: 'user', uuid: `tr-${++seq}`, timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill' }] } },
    userLine(SKILL, { isMeta: true }),
    userLine(PEER_NOTE, { isMeta: true }),
    userLine('[Request interrupted by user]', { isMeta: true }),
    assistantLine('msg_b', [{ type: 'text', text: 'Drafted.' }]),
  ]
}

async function seed(sessionId: string): Promise<void> {
  await createSessionRecord(sessionId, '', '', CWD, { title: 'Release notes', initialProcessStatus: 'idle' })
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), lines().map((l) => JSON.stringify(l)).join('\n') + '\n')
}

async function transcript(sid: string, qs: string): Promise<Row[]> {
  const res = await fetch(`http://localhost:${port}/api/v1/sessions/${sid}/transcript${qs}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { messages: Row[] }).messages
}

/** The checks both builders must pass. */
function expectInjected(rows: Row[], label: string): void {
  // Nothing the CLI put in is a row of its own.
  for (const r of rows) {
    expect(r.text, label).not.toContain('Base directory for this skill')
    expect(r.text, label).not.toContain('Hook context')
    expect(r.text, label).not.toContain('Request interrupted')
  }
  // The hook's context came before every row.
  expect(rows[0].injectedBefore?.map((i) => [i.kind, i.label]), label).toEqual([['hook', 'Added by the SessionStart hook']])
  expect(rows[0].injectedBefore?.[0].text, label).toContain(HOOK)
  // The skill's text rides the Skill call.
  const skillCall = rows.find((r) => r.kind === 'tool' && r.text === 'Skill')
  expect(skillCall?.injectedAfter?.map((i) => [i.kind, i.label]), label).toEqual([['skill', 'Loaded skill release-notes']])
  expect(skillCall?.injectedAfter?.[0].text, label).toContain('Write them short.')
  // The Walnut message the CLI delivered is drawn as that message.
  const peer = rows.find((r) => r.role === 'user' && r.text.startsWith('<walnut-message kind="peer-note"'))
  expect(peer?.sentBy, label).toBe('agent')
  // The person's words are theirs, with what Walnut added named.
  const person = rows.find((r) => r.role === 'user' && r.text.startsWith(PERSON))
  expect(person?.sentBy, label).toBe('person')
  expect(person?.added?.map((i) => i.label), label).toEqual(['Rich output'])
  // Only the first row carries the lines from before it.
  expect(rows.slice(1).every((r) => r.injectedBefore === undefined), label).toBe(true)
}

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

describe('transcript lines the CLI put in', () => {
  it('ride the rows beside them on the fresh rich read and the slim one', async () => {
    const sid = 'sess-injected'
    await seed(sid)
    for (const qs of ['?fresh=1&rich=1', '?fresh=1']) expectInjected(await transcript(sid, qs), qs)
  })

  it('the companion\'s JSONL reader answers the same way', () => {
    const jsonl = lines().map((l) => JSON.stringify(l)).join('\n')
    expectInjected(transcriptFromJsonl('sess-injected-bridge', jsonl).messages as Row[], 'jsonl')
  })
})
