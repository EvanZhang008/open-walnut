/**
 * The companion's end of a host's listener link (src/core/session-channel/companion-listener.ts)
 * and what the phone routes make of it (companion-host-ops.ts): a host's rows (its own, judged by
 * it, nobody else's) join the list; row patches, renames, drops and `live` change them; facts and
 * flow are said on the phone's stream of that session with the stream's own frame names
 * (session-event-sse.ts); calls go out as call frames and come back with the host's answer, shaped
 * as the phone's routes answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-listener'))
const { upserts } = vi.hoisted(() => ({ upserts: [] as any[] }))
vi.mock('../../../src/web/routes/events-v1.js', () => ({ handleBridgeMobileEvent: (_k: string, row: unknown) => { upserts.push(row) } }))

import { EventEmitter } from 'node:events'
import { attachSse, closeAllSseChannels } from '../../../src/web/sse-channels.js'
import { _resetCompanionListenerForTesting, attachHostListener, listenedRow, listenedRows } from '../../../src/core/session-channel/companion-listener.js'
import { interruptViaHost, joinListenedRows, listenedDetail, permissionViaHost, sendViaHost } from '../../../src/core/session-channel/companion-host-ops.js'

const WALNUT = 'ab'.repeat(16)
const row = (sid: string, over: Record<string, unknown> = {}) => ({ claudeSessionId: sid, taskId: 't1', judge: 'host', host: 'devbox', process_status: 'idle', startedAt: 'a', lastActiveAt: 'b', ...over })
let current: { idle(): Promise<void> } | null = null
/** The link's frames are applied (its serial chain), and a call frame went out. */
const settle = async () => { await current?.idle(); await new Promise((r) => setTimeout(r, 10)) }

function link() {
  const sent: any[] = []
  const closed: Array<[number, string]> = []
  const h = attachHostListener('devbox', WALNUT, { send: (t) => sent.push(JSON.parse(t)), close: (c, w) => closed.push([c, w]) })
  current = h
  const frame = (f: unknown) => h.onText(JSON.stringify(f))
  return { h, sent, closed, frame }
}

/** What the phone's streams of these sessions got: one fake SSE response each, its frames parsed. */
const sse: Array<{ key: string; event: string; data: any }> = []
function phoneOn(...sids: string[]): void {
  for (const sid of sids) {
    const key = `session:${sid}`
    const req = Object.assign(new EventEmitter(), { header: () => undefined, query: {}, method: 'GET', originalUrl: '/x' })
    const res = {
      status: () => res, setHeader: () => {}, flushHeaders: () => {}, end: () => {},
      write: (text: string) => {
        const ev = /^(?:id: \d+\n)?event: (.+)\ndata: (.*)\n\n$/.exec(text)
        if (ev) sse.push({ key, event: ev[1]!, data: JSON.parse(ev[2]!) })
        return true
      },
    }
    attachSse(key, req as never, res as never, { replay: false })
  }
}

beforeEach(() => { _resetCompanionListenerForTesting(); closeAllSseChannels(); sse.length = 0; upserts.length = 0; phoneOn('s1', 'b1', 'zz') })

describe('what a host\'s listener link tells', () => {
  it('keeps the host\'s own judged rows only, and answers its hello with listen alone', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'hello', walnutId: WALNUT, hostId: 'devbox', logId: 'L', floor: 1, head: 2 })
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1'), row('s2', { host: 'otherbox' }), row('s3', { judge: undefined }), row('../x')], upTo: 2, rowsAt: 2, logId: 'L' })
    await settle()
    expect(l.sent).toEqual([{ ch: 'sf', op: 'listen', walnutId: WALNUT }])
    expect(listenedRows().map((r) => r.row.claudeSessionId)).toEqual(['s1'])
    expect(upserts.map((u) => u.id)).toEqual(['s1'])
  })

  it('closes a link whose channel names another Walnut', () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'hello', walnutId: 'cd'.repeat(16), hostId: 'devbox', logId: 'L', floor: 1, head: 0 })
    expect(l.closed[0]?.[0]).toBe(4001)
  })

  it('applies row patches, live, renames and drops; a patch that would make it another host\'s is dropped', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    l.frame({ ch: 'sf', op: 'facts', recs: [
      { seq: 2, sid: 's1', name: 'row', data: { patch: { process_status: 'running' } } },
      { seq: 3, sid: 's1', name: 'live', data: { state: { turnRunning: true, pendingPermissionRequests: [{ requestId: 'r1', toolName: 'Bash' }] } } },
      { seq: 4, sid: 's1', name: 'row', data: { patch: { host: 'otherbox' } } },
      { seq: 5, sid: 'n1', name: 'row', data: { patch: { title: 'no base' } } },
      { seq: 6, sid: 'b1', name: 'row', data: { born: true, patch: row('b1') } },
    ] })
    await settle()
    const t = listenedRow('s1')!
    expect(t.row.process_status).toBe('running')
    expect(t.row.host).toBe('devbox')
    expect(listenedRow('n1')).toBeNull()
    expect(listenedRow('b1')?.row.claudeSessionId).toBe('b1')
    expect(listenedDetail(t)).toEqual({ session: t.row, pendingPermissions: [{ requestId: 'r1', toolName: 'Bash' }], viaHost: true })
    // A turn that starts is a turn-start on its stream; the status rides the list upsert's echo.
    expect(sse.filter((e) => e.key === 'session:s1').map((e) => e.event)).toEqual(['turn-start'])
    l.frame({ ch: 'sf', op: 'facts', recs: [{ seq: 7, sid: 'b2', name: 'rename', data: { from: 'b1', to: 'b2' } }, { seq: 8, sid: 's1', name: 'drop', data: { sid: 's1' } }] })
    await settle()
    expect(listenedRow('b1')).toBeNull()
    expect(listenedRow('b2')?.row.claudeSessionId).toBe('b2')
    expect(listenedRow('s1')).toBeNull()
  })

  it('says facts and flow on the session\'s stream with the stream\'s frame names', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    l.frame({ ch: 'sf', op: 'flow', sid: 's1', name: 'session:text-delta', data: { sessionId: 's1', delta: 'echo: hi' } })
    l.frame({ ch: 'sf', op: 'facts', recs: [
      { seq: 2, sid: 's1', name: 'session:tool-use', data: { sessionId: 's1', toolName: 'Bash', toolUseId: 'u1', input: { command: 'ls' } } },
      { seq: 3, sid: 's1', name: 'session:result', data: { sessionId: 's1', result: 'echo: hi' } },
      { seq: 4, sid: 'zz', name: 'session:result', data: { sessionId: 'zz', result: 'not told' } },
    ] })
    l.frame({ ch: 'sf', op: 'flow', sid: 's1', name: 'session:result', data: { sessionId: 's1' } })
    await settle()
    expect(sse.map((e) => [e.key, e.event])).toEqual([['session:s1', 'text-delta'], ['session:s1', 'tool'], ['session:s1', 'turn-end']])
    expect(sse[0]!.data).toEqual({ delta: 'echo: hi' })
  })

  it('joins the rows into the phone\'s list: a row the copy lacks is added', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1'), row('s9', { title: 'born away' })], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    const joined = await joinListenedRows([{ id: 's1', host: 'devbox', task_title: 'From the copy', process_status: 'stopped' }])
    expect(joined.map((r) => r.id)).toEqual(['s1', 's9'])
    expect(joined[0]).toMatchObject({ task_title: 'From the copy' })
  })
})

describe('operating a host\'s session through its link', () => {
  async function operated() {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1', { process_status: 'running' })], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    const answer = (status: number, body: unknown) => {
      const call = l.sent.filter((f) => f.op === 'call').pop()
      l.frame({ ch: 'door', op: 'reply', id: call.id, status, body })
      return call
    }
    return { l, t: listenedRow('s1')!, answer }
  }

  it('a send is queued on the host under the phone\'s id, sent by the person', async () => {
    const { t, answer } = await operated()
    const p = sendViaHost(t, { text: 'hi', messageId: 'qm-mobile-abc', timeoutMs: 1000 })
    await settle()
    const call = answer(200, { ok: true })
    expect(call).toMatchObject({ method: 'POST', path: '/host-api/sessions/send', body: { sessionId: 's1', message: 'hi', taskId: 't1', busSource: 'mobile', queued: [{ id: 'qm-mobile-abc', message: 'hi', sentBy: 'person' }] } })
    expect(await p).toEqual({ status: 202, body: { messageId: 'qm-mobile-abc', viaHost: true } })
  })

  it('an unanswered call is a retryable 503 by its deadline', async () => {
    const { t } = await operated()
    const a = await sendViaHost(t, { text: 'hi', messageId: 'qm-mobile-abd', timeoutMs: 50 })
    expect(a.status).toBe(503)
    expect((a.body.error as { code: string }).code).toBe('bridge_offline')
  })

  it('an interrupt is the host\'s own, and says whether a turn ran', async () => {
    const { t, answer } = await operated()
    const p = interruptViaHost(t, 1000)
    await settle()
    expect(answer(200, { ok: true })).toMatchObject({ path: '/host-api/sessions/interrupt', body: { sessionId: 's1' } })
    expect(await p).toEqual({ status: 200, body: { status: 'interrupted', sessionId: 's1', wasRunning: true, viaHost: true } })
  })

  it('a prompt\'s answer calls the session\'s own resolvePermissionRequest; a stale one is 404', async () => {
    const { t, answer } = await operated()
    const p = permissionViaHost(t, { requestId: 'r1', allow: true, answers: { 'When?': 'Friday' } }, 1000)
    await settle()
    expect(answer(200, { ok: true, value: true })).toMatchObject({ path: '/host-api/sessions/call', body: { sid: 's1', target: 'session', member: 'resolvePermissionRequest', args: ['r1', true, null, { answers: { 'When?': 'Friday' } }] } })
    expect(await p).toEqual({ status: 200, body: { status: 'resolved', requestId: 'r1', allow: true, viaHost: true } })
    const q = permissionViaHost(t, { requestId: 'r0', allow: false }, 1000)
    await settle()
    expect(answer(200, { ok: false, error: 'not_pending' }).body.args).toEqual(['r0', false])
    expect((await q).status).toBe(404)
    expect((await permissionViaHost(t, { requestId: 'r1' })).status).toBe(400)
  })
})
