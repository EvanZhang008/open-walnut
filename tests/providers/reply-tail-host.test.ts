/**
 * The reply tail on messages a HOST delivers itself (offline-host-core.ts).
 *
 * 2026-10-27: a peer note between two sessions on the Mac is delivered by the
 * Mac's daemon (handleLocal), never through the server's queue, so it carried
 * neither the reply-language line nor the rich output reminder. The main agent
 * read an English peer note and answered the user in English. The server now
 * ships each session's tail in the host slice (`replyTail`, host-slice.ts) and
 * the host appends it to every delivery it makes: a peer note, a reply, a
 * person's message from a follower, a cold resume, a leader's text.
 *
 * Would-fail-if-reverted: drop withReplyTail from deliverWithTaskRouting or
 * resumeWithTaskRouting, or `replyTail` from buildHostSlice, and the "on"
 * assertions break.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-tail-host'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createOfflineHost, type HostSlice } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { createOpenItemsText } from '../../src/core/sessions/open-items-text.js'
import {
  RICH_OUTPUT_MODE_ON_INSTRUCTION, RICH_OUTPUT_MODE_REMINDER, hostReplyTail,
} from '../../src/core/sessions/output-mode.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { buildHostSlice } from '../../src/core/host-slice.js'

const home = '/fixture/reply-tail'
const mainSid = 'aaaaaaaa-1111-4111-8111-111111111111'
const workerSid = 'bbbbbbbb-2222-4222-8222-222222222222'
const LANG = 'Talk to the user in Chinese; code stays English.'
const LINE = `[Reply language: ${LANG}]`
const TAIL = `${RICH_OUTPUT_MODE_REMINDER}\n\n${LINE}`
const dirs: string[] = []

function fixture(mainTail: string | null = TAIL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-reply-tail-'))
  dirs.push(dir)
  const writes: { sid: string; text: string; resumed?: boolean }[] = []
  const live = new Set([mainSid, workerSid])
  const host = createOfflineHost({
    fs, path, dir, now: () => Date.now(),
    randomHex: (n) => randomBytes(n).toString('hex'), keyOf: (v) => createHash('sha1').update(v).digest('hex'),
    kit: createEnvelopeKit(), openItems: createOpenItemsText(), log: () => {},
    isLive: (sid) => live.has(sid), turnActive: () => false, pendingPrompt: () => null, streamOffset: () => undefined,
    deliver: async (sid, text) => { writes.push({ sid, text }); return { ok: true } },
    resume: async (_home, sid, text) => { writes.push({ sid, text, resumed: true }); return { ok: true } },
  })
  const slice: HostSlice = {
    v: 1, home, hash: 'tail-one', asOf: Date.now(), host: 'fixture',
    sessions: [
      { sid: mainSid, taskId: 'main-task', ...(mainTail ? { replyTail: mainTail } : {}) },
      { sid: workerSid, taskId: 'work-task' },
    ],
    tasks: [
      { id: 'main-task', title: 'Main', phase: 'IN_PROGRESS', project: 'Ask Walnut' },
      { id: 'work-task', title: 'Music', phase: 'IN_PROGRESS', project: 'Rhythm' },
    ],
    requests: [],
  }
  host.configure(slice)
  const send = (from: string, args: Record<string, unknown>) =>
    host.handleLocal(home, from, 'tools.call', { name: 'task_send', args })
  return { host, writes, live, send }
}

afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('a host delivery carries the session reply tail', () => {
  it('a same-host peer note and the reply to it both end with the tail', async () => {
    const f = fixture()
    const sent = await f.send(workerSid, { to: 'main-task', title: 'Focus music is live', text: 'Shipped the focus music.' })
    expect(sent?.ok).toBe(true)
    const note = f.writes[0]
    expect(note.sid).toBe(mainSid)
    expect(note.text).toContain('kind="peer-note"')
    expect(note.text.endsWith(`\n\n${TAIL}`)).toBe(true)
    // The main agent asks back; the worker (no tail of its own) gets the ask unchanged.
    const ask = await f.send(mainSid, { to: 'work-task', text: 'Which folder does it read?' })
    expect(f.writes[1].text).not.toContain('[Reply language: ')
    const rq = ask!.ok ? (ask!.result as { requestId: string }).requestId : ''
    await f.send(workerSid, { in_reply_to: rq, text: 'The Music folder.' })
    const reply = f.writes[2]
    expect(reply.sid).toBe(mainSid)
    expect(reply.text).toContain('kind="reply"')
    expect(reply.text.endsWith(`\n\n${TAIL}`)).toBe(true)
  })

  it('a follower message and a cold resume carry it; a slash command does not', async () => {
    const f = fixture()
    await f.host.deliverHuman(home, mainSid, 'what changed today?', 'qm-human-1')
    expect(f.writes[0].text).toBe(`what changed today?\n\n${TAIL}`)
    await f.host.deliverHuman(home, mainSid, '/compact', 'qm-slash')
    expect(f.writes[1].text).toBe('/compact')
    f.live.delete(mainSid)
    await f.host.deliverHuman(home, mainSid, 'wake up', 'qm-resume')
    expect(f.writes[2]).toMatchObject({ resumed: true, text: `wake up\n\n${TAIL}` })
  })

  it('never twice, and no reminder beside a full rich instruction', async () => {
    const f = fixture()
    await f.host.deliverHuman(home, mainSid, `already wrapped\n\n${TAIL}`, 'qm-wrapped')
    expect(f.writes[0].text).toBe(`already wrapped\n\n${TAIL}`)
    await f.host.deliverHuman(home, mainSid, `edge\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`, 'qm-edge')
    expect(f.writes[1].text).toBe(`edge\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${LINE}`)
  })

  it('off: a slice without a tail (an older server, or nothing set) leaves the text as it is', async () => {
    const f = fixture(null)
    await f.send(workerSid, { to: 'main-task', text: 'plain note', expect_reply: false })
    expect(f.writes[0].text).not.toContain('[Reply language: ')
    expect(f.writes[0].text).not.toContain('[Rich output mode')
    await f.host.deliverHuman(home, mainSid, 'hello', 'qm-plain')
    expect(f.writes[1].text).toBe('hello')
  })
})

describe('hostReplyTail (what the server ships)', () => {
  it('reminder only once told, language line always when set, nothing otherwise', () => {
    const rich = { session: { output_mode: 'rich' as const, reply_language: LANG } }
    expect(hostReplyTail({ output_mode_injected: 'rich' }, rich)).toBe(TAIL)
    // An owed edge stays the server's: the host adds only the language line.
    expect(hostReplyTail({}, rich)).toBe(LINE)
    expect(hostReplyTail({}, { session: { output_mode: 'markdown', reply_language: LANG } })).toBe(LINE)
    expect(hostReplyTail({ output_mode_injected: 'rich' }, { session: { output_mode: 'rich' } })).toBe(RICH_OUTPUT_MODE_REMINDER)
    expect(hostReplyTail({}, { session: { output_mode: 'markdown' } })).toBeNull()
  })
})

describe('buildHostSlice ships replyTail', () => {
  beforeEach(async () => { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }) })

  it('on with the setting, gone when it is cleared', async () => {
    const { task } = await addTask({ title: 'Main', project: 'Ask Walnut' })
    const sid = randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME)
    await updateSessionRecord(sid, { output_mode_injected: 'rich' })
    const row = async () => (await buildHostSlice('__local__')).sessions.find((r) => r.sid === sid)
    await updateConfig({ session: { output_mode: 'rich', reply_language: LANG } })
    expect((await row())?.replyTail).toBe(TAIL)
    await updateConfig({ session: { output_mode: 'markdown' } })
    expect(await row()).not.toHaveProperty('replyTail')
  })
})
