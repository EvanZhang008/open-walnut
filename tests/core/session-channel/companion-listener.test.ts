/**
 * The companion's end of a host's listener link (src/core/session-channel/companion-listener.ts)
 * and what the phone routes make of it (companion-host-ops.ts): a host's rows (its own, judged by
 * it, nobody else's) join the list; row patches, renames, drops and `live` change them; facts and
 * flow are said on the phone's stream of that session with the stream's own frame names
 * (session-event-sse.ts); calls go out as call frames and come back with the host's answer, shaped
 * as the phone's routes answer.
 *
 * Review round 1 of land 5b: a link stands only for ids the copy does not place elsewhere and no
 * other link claimed (H1); the push feed hears a row only while the Mac is away, over the copy's
 * fields (M3); sessions turned off here show and operate nothing (M4); a closed link's rows are
 * unknown, then gone, and a revoke forgets them (L2); a phone that opens mid-turn gets the turn (L6);
 * one turn-start reset per turn (L7).
 *
 * Review round 2: a refusal while the link is down is `bridge_offline`, the code the phone retries
 * with the same id, and the host's queue takes that id once (M6); when the Mac turns away, the push
 * feed hears the linked hosts' rows at once (L11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-listener'))
const k = vi.hoisted(() => ({
  upserts: [] as any[], macHere: false, off: false, copy: [] as Array<Record<string, unknown>>,
  // The host's bridge as the companion's image saves reach it (cloud-images.ts saveImagesViaBridge).
  bridge: [] as Array<[string, string, Record<string, unknown>]>,
  bridgeAnswer: (_n: number): Record<string, unknown> | Error | Promise<Record<string, unknown>> => ({ ok: true }),
}))
vi.mock('../../../src/web/routes/events-v1.js', () => ({ handleBridgeMobileEvent: (_k: string, row: unknown) => { k.upserts.push(row) } }))
vi.mock('../../../src/web/ws/bridge-registry.js', async (orig) => ({
  ...(await orig<object>()),
  bridgeForHost: () => ({ connected: k.macHere }),
  bridgeRequest: async (host: string, cmd: string, params: Record<string, unknown>) => {
    k.bridge.push([host, cmd, params])
    const a = await k.bridgeAnswer(k.bridge.length)
    if (a instanceof Error) throw a
    return a
  },
}))
vi.mock('../../../src/core/replication/kinds/gate.js', async (orig) => ({ ...(await orig<object>()), copyKindOff: async (kind: string) => k.off && kind === 'sessions' }))
vi.mock('../../../src/core/session-projection.js', async (orig) => ({
  ...(await orig<object>()),
  readSessionProjection: async () => ({ version: 1, exportedAt: new Date().toISOString(), sessions: k.copy }),
}))
const upserts = k.upserts

import { EventEmitter } from 'node:events'
import { attachSse, closeAllSseChannels } from '../../../src/web/sse-channels.js'
import { _resetCompanionListenerForTesting, attachHostListener, forgetHostListener, LINK_GRACE_MS, listenedRow, standingRow, standingRows } from '../../../src/core/session-channel/companion-listener.js'
import { _resetSavedPicturesForTesting, checkMacAway, hostOperated, hostRoute, interruptViaHost, joinListenedRows, listenedDetail, modeViaHost, permissionViaHost, sendViaHost, stopViaHost, streamedByListener } from '../../../src/core/session-channel/companion-host-ops.js'

const WALNUT = 'ab'.repeat(16)
const row = (sid: string, over: Record<string, unknown> = {}) => ({ claudeSessionId: sid, taskId: 't1', judge: 'host', host: 'devbox', process_status: 'idle', startedAt: 'a', lastActiveAt: 'b', ...over })
let current: { idle(): Promise<void> } | null = null
/** The link's frames are applied (its serial chain), and a call frame went out. */
const settle = async () => { await current?.idle(); await new Promise((r) => setTimeout(r, 10)) }

function link(alias = 'devbox') {
  const sent: any[] = []
  const closed: Array<[number, string]> = []
  const h = attachHostListener(alias, WALNUT, { send: (t) => sent.push(JSON.parse(t)), close: (c, w) => closed.push([c, w]) })
  current = h
  const frame = (f: unknown) => h.onText(JSON.stringify(f))
  return { h, sent, closed, frame }
}

/** What the phone's streams of these sessions got: one fake SSE response each, its frames parsed. */
const sse: Array<{ key: string; event: string; data: any }> = []
function phoneOn(sids: string[], o: { replay?: boolean } = {}): void {
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
    attachSse(key, req as never, res as never, { replay: o.replay ?? false })
  }
}

beforeEach(() => {
  _resetCompanionListenerForTesting()
  closeAllSseChannels()
  sse.length = 0; upserts.length = 0; k.macHere = false; k.off = false; k.copy = []
  k.bridge.length = 0
  _resetSavedPicturesForTesting()
  k.bridgeAnswer = (n) => ({ ok: true, path: `/home/dev/.walnut/images/mobile/pic-${n}.png` })
  phoneOn(['s1', 'b1', 'zz'])
})
afterEach(() => { vi.useRealTimers() })

describe('what a host\'s listener link tells', () => {
  it('keeps the host\'s own judged rows only, and answers its hello with listen alone', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'hello', walnutId: WALNUT, hostId: 'devbox', logId: 'L', floor: 1, head: 2 })
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1'), row('s2', { host: 'otherbox' }), row('s3', { judge: undefined }), row('../x')], upTo: 2, rowsAt: 2, logId: 'L' })
    await settle()
    expect(l.sent).toEqual([{ ch: 'sf', op: 'listen', walnutId: WALNUT }])
    expect((await standingRows()).map((r) => r.row.claudeSessionId)).toEqual(['s1'])
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
    // The first word of a turn opens it on the stream (one reset), then its frames.
    expect(sse.map((e) => [e.key, e.event])).toEqual([['session:s1', 'turn-start'], ['session:s1', 'text-delta'], ['session:s1', 'tool'], ['session:s1', 'turn-end']])
    expect(sse[1]!.data).toEqual({ delta: 'echo: hi' })
  })

  it('joins the rows into the phone\'s list: a row the copy lacks is added', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1'), row('s9', { title: 'born away' })], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    const joined = await joinListenedRows([{ id: 's1', host: 'devbox', task_title: 'From the copy', process_status: 'stopped' }])
    expect(joined.map((r) => r.id)).toEqual(['s1', 's9'])
    expect(joined[0]).toMatchObject({ task_title: 'From the copy', process_status: 'idle' })
    // While the Mac answers, its own list stands: no row joined, none replaced.
    k.macHere = true
    expect(await joinListenedRows([{ id: 's1', host: 'devbox', process_status: 'stopped' }])).toEqual([{ id: 's1', host: 'devbox', process_status: 'stopped' }])
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
    expect(answer(200, { ok: true, value: true })).toMatchObject({ path: '/host-api/sessions/call', body: { sid: 's1', target: 'session', member: 'resolvePermissionRequest', args: ['r1', true, null, { answers: { 'When?': 'Friday' } }], unset: [2] } })
    expect(await p).toEqual({ status: 200, body: { status: 'resolved', requestId: 'r1', allow: true, viaHost: true } })
    const q = permissionViaHost(t, { requestId: 'r0', allow: false }, 1000)
    await settle()
    expect(answer(200, { ok: false, error: 'not_pending' }).body.args).toEqual(['r0', false])
    expect((await q).status).toBe(404)
    expect((await permissionViaHost(t, { requestId: 'r1' })).status).toBe(400)
  })

  it('a stop is the host\'s own terminateSession, answered with the stop it recorded; its refusal keeps the host\'s code', async () => {
    const { t, answer } = await operated()
    const p = stopViaHost(t, true, 1000)
    await settle()
    const stopRequest = { id: 'st1', requestedAt: 'x', state: 'confirmed' }
    expect(answer(200, { ok: true, value: { status: 'terminated', sessionId: 's1', stopRequest } })).toMatchObject({ path: '/host-api/sessions/call', body: { sid: 's1', target: 'lifecycle', member: 'terminateSession', args: [{ force: true }] } })
    expect(await p).toEqual({ ok: true, result: { status: 'terminated', sessionId: 's1', stopRequest, viaHost: true } })
    const q = stopViaHost(t, false, 1000)
    await settle()
    answer(409, { ok: false, error: 'Session has armed crons', code: 'crons_armed' })
    const refused = await q
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.answer).toMatchObject({ status: 409, body: { error: { code: 'crons_armed' } } })
  })

  it('a mode change is the host\'s own changeSessionModeOf, answered with the mode it kept', async () => {
    const { t, answer } = await operated()
    const p = modeViaHost(t, 'accept', 1000)
    await settle()
    expect(answer(200, { ok: true, value: { mode: 'accept' } })).toMatchObject({ path: '/host-api/sessions/call', body: { sid: 's1', target: 'lifecycle', member: 'changeSessionModeOf', args: ['accept'] } })
    expect(await p).toEqual({ ok: true, mode: 'accept' })
  })
})

describe('pictures for a host\'s session go as a legacy send\'s do (land 8 and its review round 1)', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const pics = (n: number) => Array.from({ length: n }, () => ({ data: PNG, mediaType: 'image/png' }))
  const header = (paths: string[]) => `[Images attached \u2014 use the Read tool to view them]\n${paths.map((p) => `- ${p}`).join('\n')}\n\n`
  async function operated(live?: Record<string, unknown>) {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    if (live) l.frame({ ch: 'sf', op: 'facts', recs: [{ seq: 2, sid: 's1', name: 'live', data: { state: live } }] })
    await settle()
    const calls = () => l.sent.filter((f) => f.op === 'call')
    let answered = 0
    /** Answer the next call frame once it went out (waits on the frame, not on a clock). */
    const answer = async (status: number, body: unknown) => {
      await vi.waitFor(() => expect(calls().length).toBeGreaterThan(answered), { timeout: 10_000 })
      const call = calls()[answered++]
      l.frame({ ch: 'door', op: 'reply', id: call.id, status, body })
      return call
    }
    /** Leave the next call frame unanswered (its sender times out). */
    const skip = async () => { await vi.waitFor(() => expect(calls().length).toBeGreaterThan(answered), { timeout: 10_000 }); answered++ }
    return { l, t: listenedRow('s1')!, answer, skip, calls }
  }

  it('a send with 3 pictures saves each on the host by its own bridge, then the words name them under the images header', async () => {
    const { t, answer } = await operated()
    const p = sendViaHost(t, { text: 'look at these', messageId: 'qm-mobile-p3', timeoutMs: 1000, images: pics(3) })
    const call = await answer(200, { ok: true })
    expect(k.bridge.map(([host, cmd, params]) => [host, cmd, params.mediaType, params.data])).toEqual(pics(3).map(() => ['devbox', 'image.save', 'image/png', PNG]))
    const paths = [1, 2, 3].map((n) => `/home/dev/.walnut/images/mobile/pic-${n}.png`)
    const words = `${header(paths)}look at these`
    expect(call.body).toMatchObject({ sessionId: 's1', message: words, queued: [{ id: 'qm-mobile-p3', message: words, sentBy: 'person' }], busSource: 'mobile' })
    expect(await p).toEqual({ status: 202, body: { messageId: 'qm-mobile-p3', viaHost: true } })
  })

  it('a picture the host cannot take sends nothing: the legacy codes, and bridge_offline when its bridge did not answer', async () => {
    const { t, calls } = await operated()
    k.bridgeAnswer = (n) => (n === 2 ? { ok: false, error: 'image.save: too large (EFBIG)' } : { ok: true, path: `/x/${n}.png` })
    const big = await sendViaHost(t, { text: 'a', messageId: 'qm-mobile-p4', timeoutMs: 1000, images: pics(3) })
    expect(big.status).toBe(400)
    expect(big.body.error).toMatchObject({ code: 'image_upload_failed' })
    expect(String((big.body.error as { message: string }).message)).toMatch(/too large/)
    k.bridgeAnswer = () => ({ ok: false, error: 'unknown command: image.save' })
    expect((await sendViaHost(t, { text: 'a', messageId: 'qm-mobile-p5', timeoutMs: 1000, images: pics(1) })).body.error).toMatchObject({ code: 'images_need_daemon_upgrade' })
    k.bridgeAnswer = () => new Error('bridge for devbox is not connected')
    const off = await sendViaHost(t, { text: 'a', messageId: 'qm-mobile-p6', timeoutMs: 1000, images: pics(1) })
    expect(off.status).toBe(503)
    expect(off.body.error).toMatchObject({ code: 'bridge_offline' })
    expect(off.maybeTaken).toBeUndefined()
    expect(calls()).toEqual([])
  })

  it('a text send touches no bridge', async () => {
    const { t, answer } = await operated()
    const p = sendViaHost(t, { text: 'hi', messageId: 'qm-mobile-p7', timeoutMs: 1000 })
    await answer(200, { ok: true })
    expect((await p).status).toBe(202)
    expect(k.bridge).toEqual([])
  })

  it('a prompt\'s answer with pictures names them at the head of the last answer, as the lead host path does', async () => {
    const { t, answer } = await operated()
    const p = permissionViaHost(t, { requestId: 'r1', allow: true, answers: { 'Which?': 'A', 'When?': 'Friday' }, images: pics(2) }, 1000)
    const paths = [1, 2].map((n) => `/home/dev/.walnut/images/mobile/pic-${n}.png`)
    expect((await answer(200, { ok: true, value: true })).body.args).toEqual(['r1', true, null, { answers: { 'Which?': 'A', 'When?': `${header(paths)}Friday` } }])
    expect(await p).toEqual({ status: 200, body: { status: 'resolved', requestId: 'r1', allow: true, viaHost: true, pictures: 2 } })
    // A refusal, or an answer with no answers, carries no pictures (the lead host path's rule).
    const q = permissionViaHost(t, { requestId: 'r2', allow: false, images: pics(1) }, 1000)
    expect((await answer(200, { ok: true, value: true })).body.args).toEqual(['r2', false])
    expect((await q).status).toBe(200)
    expect(k.bridge).toHaveLength(2)
  })

  it('S1: the host\'s call gets what is left of the window after the pictures, with a floor, not a whole window more', async () => {
    const { t } = await operated()
    k.bridgeAnswer = (n) => new Promise((r) => setTimeout(() => r({ ok: true, path: `/x/${n}.png` }), 4_000))
    const started = Date.now()
    // The host never answers: the send ends at the floor after the pictures (4 s + 3 s), not 4 s + 5 s.
    const a = await sendViaHost(t, { text: 'slow', messageId: 'qm-mobile-s1', timeoutMs: 5_000, images: pics(1) })
    const took = Date.now() - started
    expect(a).toMatchObject({ status: 503, maybeTaken: true })
    expect(took).toBeGreaterThanOrEqual(6_900)
    expect(took).toBeLessThan(8_200)
  }, 20_000)

  it('S2: a retry of an id whose answer was lost names the same files, moves no picture, and reaches the host with its bridge down', async () => {
    const { t, answer, skip } = await operated()
    const first = sendViaHost(t, { text: 'look', messageId: 'qm-mobile-s2', timeoutMs: 50, images: pics(2) })
    await skip()
    expect(await first).toMatchObject({ status: 503, maybeTaken: true })
    expect(k.bridge).toHaveLength(2)
    k.bridgeAnswer = () => new Error('bridge for devbox is not connected')
    const p = sendViaHost(t, { text: 'look', messageId: 'qm-mobile-s2', timeoutMs: 1000, images: pics(2) })
    const retry = await answer(200, { ok: true })
    expect(k.bridge).toHaveLength(2)
    expect(retry.body.message).toBe(`${header(['/home/dev/.walnut/images/mobile/pic-1.png', '/home/dev/.walnut/images/mobile/pic-2.png'])}look`)
    expect(await p).toEqual({ status: 202, body: { messageId: 'qm-mobile-s2', viaHost: true } })
    // Another message moves its own pictures.
    k.bridgeAnswer = (n) => ({ ok: true, path: `/y/${n}.png` })
    const q = sendViaHost(t, { text: 'more', messageId: 'qm-mobile-s2b', timeoutMs: 1000, images: pics(1) })
    await answer(200, { ok: true })
    expect((await q).status).toBe(202)
    expect(k.bridge).toHaveLength(3)
  }, 20_000)

  it('N1: an answer\'s pictures go beside the last asked question with an answer, whatever order the phone sent', async () => {
    const input = { questions: [{ question: 'Which?' }, { question: 'When?' }] }
    const { t, answer } = await operated({ pendingPermissionRequests: [{ requestId: 'r1', toolName: 'AskUserQuestion', input }] })
    const p = permissionViaHost(t, { requestId: 'r1', allow: true, answers: { 'When?': 'Friday', 'Which?': 'A' }, images: pics(1) }, 1000)
    expect((await answer(200, { ok: true, value: true })).body.args[3]).toEqual({ answers: { 'When?': `${header(['/home/dev/.walnut/images/mobile/pic-1.png'])}Friday`, 'Which?': 'A' } })
    expect((await p).body).toMatchObject({ pictures: 1 })
  })

  it('N2: an answer with pictures to a prompt the host no longer holds moves no picture', async () => {
    const { t, calls } = await operated({ pendingPermissionRequests: [{ requestId: 'r9', toolName: 'AskUserQuestion', input: {} }] })
    const a = await permissionViaHost(t, { requestId: 'r1', allow: true, answers: { 'When?': 'Friday' }, images: pics(2) }, 1000)
    expect(a.status).toBe(404)
    expect(k.bridge).toEqual([])
    expect(calls()).toEqual([])
  })
})

describe('which ids a link may stand for (review H1)', () => {
  it('refuses a row whose id the copy places on another host or on the Mac: list, detail, send and stream stay as they were', async () => {
    k.copy = [{ id: 'a1', host: 'otherbox', task_title: 'On another host' }, { id: 'm1', host: '', task_title: 'On the Mac' }, { id: 's1', host: 'devbox' }]
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('a1'), row('m1'), row('s1'), row('n1')], upTo: 1, rowsAt: 1, logId: 'L' })
    l.frame({ ch: 'sf', op: 'facts', recs: [{ seq: 2, sid: 'a2', name: 'row', data: { born: true, patch: row('a2') } }] })
    k.copy.push({ id: 'a2', host: 'otherbox' })
    await settle()
    expect((await standingRows()).map((t) => t.row.claudeSessionId).sort()).toEqual(['n1', 's1'])
    for (const sid of ['a1', 'm1', 'a2']) {
      expect(await standingRow(sid), sid).toBeNull()
      expect(await hostOperated(sid), sid).toBeNull()
      expect((await hostRoute(sid)).kind, sid).toBe('none')
      expect(await streamedByListener(sid), sid).toBeNull()
    }
    const list = [{ id: 'a1', host: 'otherbox', task_title: 'On another host' }, { id: 'm1', host: '', task_title: 'On the Mac' }]
    const joined = await joinListenedRows(list)
    expect(joined.slice(0, 2)).toEqual(list)
    expect(upserts.map((u) => u.id).sort()).toEqual(['n1', 's1'])
  })

  it('a second link cannot take an id another link claimed first', async () => {
    const first = link('otherbox')
    first.frame({ ch: 'sf', op: 'rows', rows: [row('x1', { host: 'otherbox' })], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    const second = link('devbox')
    second.frame({ ch: 'sf', op: 'rows', rows: [row('x1'), row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    expect((await standingRow('x1'))?.alias).toBe('otherbox')
    expect((await standingRows()).map((t) => `${t.alias}:${t.row.claudeSessionId}`).sort()).toEqual(['devbox:s1', 'otherbox:x1'])
  })
})

describe('the push feed and the setting (review M3, M4)', () => {
  it('pushes a host row only while the Mac is away, over the copy row\'s own fields', async () => {
    k.copy = [{ id: 's1', host: 'devbox', task_title: 'From the copy', pinned: true, host_label: 'Dev box', process_status: 'stopped' }]
    k.macHere = true
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    expect(upserts).toEqual([])
    k.macHere = false
    l.frame({ ch: 'sf', op: 'facts', recs: [{ seq: 2, sid: 's1', name: 'row', data: { patch: { process_status: 'running' } } }] })
    await settle()
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ id: 's1', task_title: 'From the copy', pinned: true, host_label: 'Dev box', process_status: 'running' })
  })

  it('with sessions turned off here, no host row joins a list or a push, and nothing is operated', async () => {
    k.off = true
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1', { process_status: 'running' })], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    expect(upserts).toEqual([])
    expect(await joinListenedRows([])).toEqual([])
    expect(await hostOperated('s1')).toBeNull()
    expect(await streamedByListener('s1')).toBeNull()
    expect(await hostRoute('s1')).toMatchObject({ kind: 'refuse', code: 'not_kept_here' })
  })
})

describe('when the Mac turns away (review L11)', () => {
  it('the push feed hears every linked host row once, without waiting for the row to change', async () => {
    k.macHere = true
    await checkMacAway()
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1'), row('b1')], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    await checkMacAway()
    expect(upserts).toEqual([])
    k.macHere = false
    await checkMacAway()
    expect(upserts.map((r) => r.id).sort()).toEqual(['b1', 's1'])
    // Still away: nothing again; a row told now is pushed as it comes, by itself.
    await checkMacAway()
    expect(upserts).toHaveLength(2)
  })
})

describe('the phone\'s retry while the host is not linked (review M6)', () => {
  it('a send, Stop or answer before the link is a retryable bridge_offline; the same id retried reaches the host\'s queue once', async () => {
    const { queueLinesOnHost } = await import('../../../src/core/sessions/handed-holds.js')
    const { getQueue } = await import('../../../src/core/session-message-queue.js')
    // A restarted companion: the copy says the host judges it, no link claimed it yet.
    k.copy = [{ id: 's1', host: 'devbox', judge: 'host', process_status: 'idle' }]
    expect(await hostRoute('s1')).toMatchObject({ kind: 'refuse', status: 503, code: 'bridge_offline' })
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    const route = await hostRoute('s1')
    expect(route.kind).toBe('operated')
    const t = (route as { t: Parameters<typeof sendViaHost>[0] }).t
    // The host as its send route does (host-routes.ts, handed-holds.ts): queue the lines under their id.
    const hostTakes = async (reply: boolean) => {
      const call = l.sent.filter((f) => f.op === 'call').pop()
      await queueLinesOnHost('s1', call.body.queued, 'mobile')
      if (reply) l.frame({ ch: 'door', op: 'reply', id: call.id, status: 200, body: { ok: true } })
    }
    // The first try is queued on the host, its answer lost: a 503 the phone retries.
    const first = sendViaHost(t, { text: 'hi', messageId: 'qm-mobile-m6', timeoutMs: 100 })
    await settle(); await hostTakes(false)
    expect(await first).toMatchObject({ status: 503, body: { error: { code: 'bridge_offline' } }, maybeTaken: true })
    // The retry, the same id: answered, and on the host one line.
    const again = sendViaHost(t, { text: 'hi', messageId: 'qm-mobile-m6', timeoutMs: 1000 })
    await settle(); await hostTakes(true)
    expect((await again).status).toBe(202)
    expect((await getQueue('s1')).filter((m) => m.id === 'qm-mobile-m6')).toHaveLength(1)
    // The link drops under a call: the same retryable code, for a send, a Stop and an answer.
    l.h.onClose()
    expect((await sendViaHost(t, { text: 'hi', messageId: 'qm-mobile-m6b', timeoutMs: 1000 })).body.error).toMatchObject({ code: 'bridge_offline' })
    expect((await interruptViaHost(t, 1000)).body.error).toMatchObject({ code: 'bridge_offline' })
    expect(await hostRoute('s1')).toMatchObject({ kind: 'refuse', status: 503, code: 'bridge_offline' })
  })
})

describe('a link that closes, or whose credential is revoked (review L2)', () => {
  it('leaves its rows unknown (never operated, a send refused, not the direct path), then drops them; its claim stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    l.frame({ ch: 'sf', op: 'facts', recs: [{ seq: 2, sid: 's1', name: 'live', data: { state: { turnRunning: false } } }] })
    await current?.idle()
    l.h.onClose()
    expect(await hostOperated('s1')).toBeNull()
    expect(await standingRows()).toEqual([])
    expect((await standingRow('s1'))?.live).toBeNull()
    expect(await hostRoute('s1')).toMatchObject({ kind: 'refuse', code: 'bridge_offline' })
    vi.advanceTimersByTime(LINK_GRACE_MS + 1)
    expect(listenedRow('s1')).toBeNull()
    expect(await hostRoute('s1')).toMatchObject({ kind: 'refuse', code: 'bridge_offline' })
  })

  it('a revoke forgets the host\'s rows and claims at once', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('s1')], upTo: 1, rowsAt: 1, logId: 'L' })
    await settle()
    forgetHostListener('devbox')
    expect(listenedRow('s1')).toBeNull()
    expect((await hostRoute('s1')).kind).toBe('none')
  })
})

describe('the phone\'s stream of a turn (review L6, L7)', () => {
  it('a phone that opens mid-turn gets the turn so far; one turn-start reset however the row and the words arrive', async () => {
    const l = link()
    l.frame({ ch: 'sf', op: 'rows', rows: [row('m2')], upTo: 1, rowsAt: 1, logId: 'L' })
    // The words before the row's running patch: the turn opens on the first word, the patch opens nothing more.
    l.frame({ ch: 'sf', op: 'flow', sid: 'm2', name: 'session:text-delta', data: { sessionId: 'm2', delta: 'so far' } })
    l.frame({ ch: 'sf', op: 'facts', recs: [{ seq: 2, sid: 'm2', name: 'row', data: { patch: { process_status: 'running' } } }] })
    l.frame({ ch: 'sf', op: 'flow', sid: 'm2', name: 'session:text-delta', data: { sessionId: 'm2', delta: ' and on' } })
    await settle()
    phoneOn(['m2'], { replay: true })
    const frames = sse.filter((e) => e.key === 'session:m2')
    expect(frames.map((e) => e.event)).toEqual(['turn-start', 'text-delta', 'text-delta'])
    expect(frames.filter((e) => e.event === 'text-delta').map((e) => e.data.delta).join('')).toBe('so far and on')
  })
})
