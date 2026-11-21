/**
 * A trigger fire no server claimed, picked by the host's own Walnut server while the Mac is
 * away (follower-trigger-delivery-v1, replica/away-trigger-delivery.ts): its pick over its
 * copies is the one the daemon's own away code makes over the daemon's copy (one rule,
 * host-trigger-target.ts), and the mechanics after it write exactly what deliverTrigger writes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createAwayTriggerDelivery, type AwayTriggerSession } from '../../src/replica/away-trigger-delivery.js'
import { pickHostTriggerTarget } from '../../src/core/routines/host-trigger-target.js'
import { createOfflineHost, type HostSlice } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'

const HOST = 'devbox'
const TASK = 'mslack00-0b27'
const SLOT = 'aaaaaaaa-1111-4111-8111-111111111111'
const NEWER = 'bbbbbbbb-2222-4222-8222-222222222222'
const OLDER = 'cccccccc-3333-4333-8333-333333333333'
const ASIDE = 'dddddddd-4444-4444-8444-444444444444'
const ELSEWHERE = 'eeeeeeee-5555-4555-8555-555555555555'

function follower(o: { task?: Record<string, unknown> | null; sessions?: AwayTriggerSession[]; hostKey?: string | null; answer?: Record<string, unknown> } = {}) {
  const asked: Array<{ cmd: string; params: Record<string, unknown> }> = []
  const logs: string[] = []
  const d = createAwayTriggerDelivery({
    hostKey: o.hostKey === undefined ? HOST : o.hostKey,
    task: async () => (o.task === undefined ? { id: TASK, phase: 'IN_PROGRESS' } : o.task),
    sessionsOfTask: async () => o.sessions ?? [
      { sid: OLDER, host: HOST, lastActiveAt: '2026-11-20T08:00:00Z' },
      { sid: NEWER, host: HOST, lastActiveAt: '2026-11-20T10:00:00Z' },
      { sid: SLOT, host: HOST, lastActiveAt: '2026-11-20T09:00:00Z' },
      { sid: ELSEWHERE, host: 'other-box', lastActiveAt: '2026-11-20T11:00:00Z' },
    ],
    request: async (cmd, params) => { asked.push({ cmd, params }); return o.answer ?? { ok: true, delivered: true } },
    log: (_level, msg) => { logs.push(msg) },
  })
  return { d, asked, logs }
}

describe('the host server picks the session for a fire with its copies', () => {
  it('the task\'s own session when it is live here', async () => {
    const { d } = follower({ task: { phase: 'IN_PROGRESS', session_id: SLOT } })
    expect(await d.pick(TASK, [NEWER, SLOT])).toEqual({ ok: true, sid: SLOT, resume: false })
  })

  it('else the newest live session of the task here, never one on another host', async () => {
    const { d } = follower({ task: { phase: 'IN_PROGRESS', session_id: SLOT } })
    expect(await d.pick(TASK, [OLDER, NEWER, ELSEWHERE])).toEqual({ ok: true, sid: NEWER, resume: false })
    expect(await d.pick(TASK, [OLDER, ELSEWHERE])).toEqual({ ok: true, sid: OLDER, resume: false })
  })

  it('none live: the stopped one to resume (the slot, else the newest that is no aside and resumable)', async () => {
    const withSlot = follower({ task: { phase: 'WAITING', session_id: OLDER } })
    expect(await withSlot.d.pick(TASK, [])).toEqual({ ok: true, sid: OLDER, resume: true })
    const noSlot = follower({
      task: { phase: 'WAITING' },
      sessions: [
        { sid: ASIDE, host: HOST, lastActiveAt: '2026-11-20T12:00:00Z', aside: true },
        { sid: NEWER, host: HOST, lastActiveAt: '2026-11-20T11:00:00Z', noResume: true },
        { sid: OLDER, host: HOST, lastActiveAt: '2026-11-20T10:00:00Z' },
      ],
    })
    expect(await noSlot.d.pick(TASK, [])).toEqual({ ok: true, sid: OLDER, resume: true })
  })

  it('leaves the fire to the Mac for a COMPLETE task, a task on ACP, a slot on another host, or nothing to wake', async () => {
    expect(await follower({ task: { phase: 'COMPLETE' } }).d.pick(TASK, [NEWER])).toEqual({ ok: false, reason: 'target task is complete' })
    const acp = follower({ task: { phase: 'IN_PROGRESS', session_id: SLOT }, sessions: [{ sid: SLOT, host: HOST, acp: true, noResume: true }, { sid: OLDER, host: HOST }] })
    expect(await acp.d.pick(TASK, [OLDER])).toMatchObject({ ok: false, reason: expect.stringContaining('ACP engine') })
    expect(await follower({ task: { phase: 'WAITING', session_id: ELSEWHERE } }).d.pick(TASK, [])).toMatchObject({ ok: false, reason: expect.stringContaining('not on this host') })
    const none = follower({ sessions: [{ sid: ASIDE, host: HOST, aside: true }, { sid: NEWER, host: HOST, noResume: true }] })
    expect(await none.d.pick(TASK, [])).toMatchObject({ ok: false, reason: expect.stringContaining('no session of the target task on this host') })
  })

  it('an unknown task is judged by its sessions alone, as the daemon judges it', async () => {
    const { d } = follower({ task: null })
    expect(await d.pick(TASK, [OLDER])).toEqual({ ok: true, sid: OLDER, resume: false })
    expect(await follower({ task: null, sessions: [] }).d.pick(TASK, [])).toMatchObject({ ok: false })
  })
})

describe('the host server answers each offer once', () => {
  it('names the session it picked, with the delivery id it was offered', async () => {
    const { d, asked } = follower({ task: { phase: 'IN_PROGRESS', session_id: SLOT } })
    await d.handle({ ev: 'trigger-delivery', deliveryId: 'td-1', home: '/h', triggerId: 't1', taskId: TASK, messageId: 'qm-trigger-1', live: [SLOT] })
    expect(asked).toEqual([{ cmd: 'follower.trigger.deliver', params: { deliveryId: 'td-1', sid: SLOT, resume: false } }])
  })

  it('declines with the reason when no session here takes it, and says error when it cannot tell', async () => {
    const done = follower({ task: { phase: 'COMPLETE' } })
    await done.d.handle({ deliveryId: 'td-2', taskId: TASK, live: [] })
    expect(done.asked[0]!.params).toEqual({ deliveryId: 'td-2', declined: 'target task is complete' })
    const nameless = follower({ hostKey: null })
    await nameless.d.handle({ deliveryId: 'td-3', taskId: TASK, live: [] })
    expect(nameless.asked[0]!.params).toMatchObject({ deliveryId: 'td-3', error: expect.stringContaining('host') })
    const asked: Array<Record<string, unknown>> = []
    const broken = createAwayTriggerDelivery({
      hostKey: HOST, task: async () => { throw new Error('copy unreadable') }, sessionsOfTask: async () => [],
      request: async (_cmd, params) => { asked.push(params); return { ok: true } }, log: () => {},
    })
    await broken.handle({ deliveryId: 'td-4', taskId: TASK })
    expect(asked).toEqual([{ deliveryId: 'td-4', error: 'copy unreadable' }])
  })

  it('ignores an event with no delivery id, and logs a stale answer without asking again', async () => {
    const quiet = follower()
    await quiet.d.handle({ taskId: TASK })
    expect(quiet.asked).toEqual([])
    const stale = follower({ answer: { ok: false, error: 'no delivery waits on that id', errorKind: 'stale' } })
    await stale.d.handle({ deliveryId: 'td-5', taskId: TASK, live: [NEWER] })
    expect(stale.asked).toHaveLength(1)
    expect(stale.logs).toContain('replica: the daemon did not take a trigger delivery pick')
  })
})

describe('the pick and the daemon\'s own path write the same thing', () => {
  const dirs: string[] = []
  const journals: Array<{ close: () => void }> = []
  afterEach(() => {
    for (const journal of journals.splice(0)) journal.close()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const HOME = '/fixture/walnut-home'
  const NOW = Date.parse('2026-11-20T12:00:00Z')

  function daemon(slice: Partial<HostSlice>, live: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'away-trigger-'))
    dirs.push(dir)
    const writes: Array<{ kind: string; sid: string; text: string; messageId: string }> = []
    const host = createOfflineHost({
      fs, path, dir, now: () => NOW, randomHex: (n) => randomBytes(n).toString('hex'),
      keyOf: (h) => createHash('sha1').update(h).digest('hex').slice(0, 12),
      kit: createEnvelopeKit(), log: () => {},
      isLive: (sid) => live.includes(sid), turnActive: () => false, streamOffset: () => undefined,
      deliver: async (sid, text, messageId) => { writes.push({ kind: 'fifo', sid, text, messageId }); return { ok: true } },
      resume: async (_home, sid, text, messageId) => { writes.push({ kind: 'resume', sid, text, messageId }); return { ok: true } },
    })
    journals.push(host.journal)
    host.configure({ v: 1, home: HOME, hash: 'h', asOf: NOW, host: HOST, sessions: [], tasks: [], requests: [], ...slice })
    return { host, writes }
  }
  const strip = (records: Array<Record<string, unknown>>) => records.map(({ kind, sid, taskId, messageId }) => ({ kind, sid, taskId, messageId }))

  for (const c of [
    { name: 'a live slot', live: [NEWER, SLOT], sessionId: SLOT, phase: 'IN_PROGRESS' },
    { name: 'the newest live', live: [OLDER, NEWER], sessionId: undefined, phase: 'IN_PROGRESS' },
    { name: 'a stopped slot to resume', live: [], sessionId: OLDER, phase: 'WAITING' },
    { name: 'the newest stopped to resume', live: [], sessionId: undefined, phase: 'WAITING' },
  ]) {
    it(`${c.name}: the same session, the same write, the same records`, async () => {
      const sessions = [
        { sid: NEWER, taskId: TASK, title: 'Newer' }, { sid: SLOT, taskId: TASK, title: 'Slot' }, { sid: OLDER, taskId: TASK, title: 'Older' },
      ]
      const tasks = [{ id: TASK, title: 'Monitor chat', phase: c.phase, project: 'Ops', ...(c.sessionId ? { session_id: c.sessionId } : {}) }]
      const own = daemon({ sessions, tasks }, c.live)
      const viaFollower = daemon({ sessions, tasks }, c.live)
      const ownResult = await own.host.deliverTrigger(HOME, TASK, 'ENVELOPE', 'qm-trigger-7')
      // The follower's copies list the same sessions, newest first, with the daemon's live list.
      const pick = createAwayTriggerDelivery({
        hostKey: HOST, task: async () => tasks[0]!, request: async () => ({}), log: () => {},
        sessionsOfTask: async () => sessions.map((s, i) => ({ sid: s.sid, host: HOST, lastActiveAt: `2026-11-20T1${9 - i}:00:00Z` })),
      })
      const target = await pick.pick(TASK, viaFollower.host.liveSessionsOf(HOME))
      expect(target.ok).toBe(true)
      if (!target.ok) return
      const followerResult = await viaFollower.host.deliverTriggerTo(HOME, TASK, { sid: target.sid, resume: target.resume }, 'ENVELOPE', 'qm-trigger-7')
      expect(followerResult).toEqual(ownResult)
      expect(viaFollower.writes).toEqual(own.writes)
      expect(strip(viaFollower.host.drain(HOME).records as never)).toEqual(strip(own.host.drain(HOME).records as never))
    })
  }

  it('the mechanics refuse a pick that is not this Walnut\'s session here, another task\'s, an ACP one, or not running', async () => {
    const { host, writes } = daemon({
      sessions: [{ sid: SLOT, taskId: TASK }, { sid: OLDER, taskId: 'other-task' }, { sid: NEWER, taskId: TASK, acp: true }],
      tasks: [{ id: TASK, title: 'T', phase: 'IN_PROGRESS', project: 'Ops' }],
    }, [NEWER])
    expect(await host.deliverTriggerTo(HOME, TASK, { sid: ELSEWHERE, resume: false }, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('not a session of this Walnut') })
    expect(await host.deliverTriggerTo(HOME, TASK, { sid: OLDER, resume: true }, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('another task') })
    expect(await host.deliverTriggerTo(HOME, TASK, { sid: NEWER, resume: false }, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('ACP') })
    expect(await host.deliverTriggerTo(HOME, TASK, { sid: SLOT, resume: false }, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('not running') })
    expect(writes).toEqual([])
    expect(host.drain(HOME).records).toEqual([])
    // The ACP session is never a live candidate either.
    expect(host.liveSessionsOf(HOME)).toEqual([])
  })

  it('one rule: the daemon without a resume says what it said before', () => {
    expect(pickHostTriggerTarget({ phase: 'WAITING' }, [{ sid: OLDER, live: false }], { resume: false })).toEqual({ ok: false, reason: 'no live session of the target task on this host' })
  })
})
