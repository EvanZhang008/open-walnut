/**
 * A trigger fire no server claimed, delivered by the host's own Walnut server while its
 * leader is away (follower-trigger-delivery-v1, follower-trigger-delivery-core.ts): the
 * daemon offers it, takes only the live attempt's answer, falls back to its own delivery
 * after three failures in a row (logged and counted as a daemon offline answer), and both
 * twins wire it the same way. The inlined text runs alone.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createFollowerTriggerDelivery, type TriggerFire, type TriggerDeliveryResult } from '../../src/providers/follower-trigger-delivery-core.js'
import { pickHostTriggerTarget } from '../../src/core/routines/host-trigger-target.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const FIRE: TriggerFire = { home: '/h', triggerId: 'job-1', taskId: 'task-1', text: 'ENVELOPE', messageId: 'qm-trigger-abc' }

function harness(o: { follower?: boolean; mayWrite?: boolean; send?: boolean; own?: TriggerDeliveryResult; mechanics?: TriggerDeliveryResult; make?: typeof createFollowerTriggerDelivery; clock?: { t: number } } = {}) {
  const sock = { id: 1 }
  const other = { id: 2 }
  const sent: Array<{ ev: string; data: Record<string, unknown> }> = []
  const own: TriggerFire[] = []
  const mechanics: Array<{ fire: TriggerFire; target: { sid: string; resume: boolean } }> = []
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const logs: Array<{ msg: string; data?: Record<string, unknown> }> = []
  const ownAnswers: Array<{ fire: TriggerFire; failures: number }> = []
  let n = 0
  const make = o.make ?? createFollowerTriggerDelivery
  const d = make<typeof sock>({
    follower: () => (o.follower === false ? null : sock),
    mayWrite: () => o.mayWrite !== false,
    send: (_ws, ev, data) => { if (o.send === false) return false; sent.push({ ev, data }); return true },
    liveSids: () => ['s-live'],
    own: async (fire) => { own.push(fire); return o.own ?? { ok: true, sid: 's-own' } },
    deliverTo: async (fire, target) => { mechanics.push({ fire, target }); return o.mechanics ?? { ok: true, sid: target.sid, ...(target.resume ? { resumed: true as const } : {}) } },
    nextId: () => `td-${++n}`,
    answerMs: 15_000,
    ownAnswerUsed: (fire, failures) => { ownAnswers.push({ fire, failures }) },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
    log: (_level, msg, data) => { logs.push({ msg, data }) },
    ...(o.clock ? { now: () => o.clock!.t } : {}),
  })
  const fireTimer = () => { const t = timers.find((x) => !x.cleared); t!.cleared = true; t!.fn() }
  return { d, sock, other, sent, own, mechanics, timers, logs, ownAnswers, fireTimer }
}
const tick = () => new Promise((r) => setImmediate(r))

describe('the daemon offers a due fire to its host server', () => {
  it('no host server that delivers triggers, or the leader answers: the daemon delivers it itself, as before', async () => {
    for (const h of [harness({ follower: false }), harness({ mayWrite: false })]) {
      expect(await h.d.deliver(FIRE)).toEqual({ ok: true, sid: 's-own' })
      expect(h.own).toEqual([FIRE])
      expect(h.sent).toEqual([])
      expect(h.ownAnswers).toEqual([])
    }
  })

  it('offers it with the message id the tick built and the live sessions; the pick is written by the mechanics, once', async () => {
    const h = harness()
    const result = h.d.deliver(FIRE)
    expect(h.sent).toEqual([{ ev: 'trigger-delivery', data: { deliveryId: 'td-1', home: '/h', triggerId: 'job-1', taskId: 'task-1', messageId: 'qm-trigger-abc', live: ['s-live'] } }])
    expect(await h.d.answer(h.sock, { deliveryId: 'td-1', sid: 's-live', resume: false })).toEqual({ ok: true, result: { delivered: true, sid: 's-live' } })
    expect(await result).toEqual({ ok: true, sid: 's-live' })
    expect(h.mechanics).toEqual([{ fire: FIRE, target: { sid: 's-live', resume: false } }])
    expect(h.own).toEqual([])
    // The same answer again (a retry after a lost reply): stale, nothing written twice.
    expect(await h.d.answer(h.sock, { deliveryId: 'td-1', sid: 's-live' })).toMatchObject({ ok: false, code: 'stale' })
    expect(h.mechanics).toHaveLength(1)
    expect(h.timers[0]!.cleared).toBe(true)
  })

  it('a resume pick comes back resumed', async () => {
    const h = harness()
    const result = h.d.deliver(FIRE)
    await h.d.answer(h.sock, { deliveryId: 'td-1', sid: 's-stopped', resume: true })
    expect(await result).toEqual({ ok: true, sid: 's-stopped', resumed: true })
  })

  it('a declined fire stays for the leader and is no failure', async () => {
    const h = harness()
    const result = h.d.deliver(FIRE)
    expect(await h.d.answer(h.sock, { deliveryId: 'td-1', declined: 'target task is complete' })).toEqual({ ok: true, result: { delivered: false, declined: true } })
    expect(await result).toEqual({ ok: false, reason: 'target task is complete' })
    for (let i = 0; i < 4; i++) {
      const again = h.d.deliver(FIRE)
      await h.d.answer(h.sock, { deliveryId: `td-${i + 2}`, declined: 'target task is complete' })
      await again
    }
    expect(h.own).toEqual([])
    expect(h.mechanics).toEqual([])
  })

  it('no answer in time: not delivered, and the late answer does nothing', async () => {
    const h = harness()
    const result = h.d.deliver(FIRE)
    h.fireTimer()
    expect(await result).toMatchObject({ ok: false, reason: expect.stringContaining('did not answer') })
    expect(await h.d.answer(h.sock, { deliveryId: 'td-1', sid: 's-live' })).toMatchObject({ ok: false, code: 'stale' })
    expect(h.mechanics).toEqual([])
    // The next minute's attempt is a new delivery id; only it is taken.
    const next = h.d.deliver(FIRE)
    expect(h.sent[1]!.data.deliveryId).toBe('td-2')
    expect(h.sent[1]!.data.messageId).toBe('qm-trigger-abc')
    expect(await h.d.answer(h.sock, { deliveryId: 'td-1', sid: 's-live' })).toMatchObject({ ok: false, code: 'stale' })
    await h.d.answer(h.sock, { deliveryId: 'td-2', sid: 's-live' })
    expect(await next).toEqual({ ok: true, sid: 's-live' })
    expect(h.mechanics).toHaveLength(1)
  })

  it('an answer from another socket is not taken; a closed socket ends what it was offered', async () => {
    const h = harness()
    const result = h.d.deliver(FIRE)
    expect(await h.d.answer(h.other, { deliveryId: 'td-1', sid: 's-live' })).toMatchObject({ ok: false, code: 'wrong_socket' })
    h.d.dropSocket(h.sock)
    expect(await result).toMatchObject({ ok: false, reason: expect.stringContaining('closed') })
    expect(h.mechanics).toEqual([])
    expect(h.d.counts().pending).toBe(0)
  })

  it('three failures in a row (timeout, error, unsendable, failed write): the next attempt is the daemon\'s own, logged and counted', async () => {
    const h = harness({ mechanics: { ok: false, reason: 'FIFO write failed' } })
    const timeout = h.d.deliver(FIRE)
    h.fireTimer()
    await timeout
    const error = h.d.deliver(FIRE)
    expect(await h.d.answer(h.sock, { deliveryId: 'td-2', error: 'copy unreadable' })).toEqual({ ok: true, result: { delivered: false } })
    expect(await error).toEqual({ ok: false, reason: 'copy unreadable' })
    const failedWrite = h.d.deliver(FIRE)
    await h.d.answer(h.sock, { deliveryId: 'td-3', sid: 's-live' })
    expect(await failedWrite).toEqual({ ok: false, reason: 'FIFO write failed' })
    expect(h.own).toEqual([])
    expect(await h.d.deliver(FIRE)).toEqual({ ok: true, sid: 's-own' })
    expect(h.own).toEqual([FIRE])
    expect(h.ownAnswers).toEqual([{ fire: FIRE, failures: 3 }])
    expect(h.logs.find((l) => l.msg.includes('kept failing'))?.data).toMatchObject({ failures: 3, triggerId: 'job-1', messageId: 'qm-trigger-abc' })
    // A fire that cannot even be sent counts as a failure too.
    const dead = harness({ send: false })
    for (let i = 0; i < 3; i++) expect(await dead.d.deliver(FIRE)).toMatchObject({ ok: false, reason: expect.stringContaining('could not be told') })
    expect(await dead.d.deliver(FIRE)).toEqual({ ok: true, sid: 's-own' })
  })

  it('a success clears the count: failures must be in a row', async () => {
    const h = harness()
    for (let round = 0; round < 3; round++) {
      const a = h.d.deliver(FIRE); h.fireTimer(); await a
      const b = h.d.deliver(FIRE); h.fireTimer(); await b
      const ok = h.d.deliver(FIRE)
      await h.d.answer(h.sock, { deliveryId: h.sent.at(-1)!.data.deliveryId, sid: 's-live' })
      expect(await ok).toEqual({ ok: true, sid: 's-live' })
    }
    expect(h.own).toEqual([])
    expect(h.ownAnswers).toEqual([])
  })
})

describe('a host server that kept failing sits out (no three timeouts before every fire)', () => {
  const MIN = 60_000
  async function failThree(h: ReturnType<typeof harness>, fire = FIRE) {
    for (let i = 0; i < 3; i++) { const a = h.d.deliver(fire); h.fireTimer(); await a }
  }

  it('after the fallback every fire of that host, any trigger, is the daemon\'s own until the backoff ends; no offer, no timeout', async () => {
    const clock = { t: 0 }
    const h = harness({ clock })
    await failThree(h)
    const offered = h.sent.length
    expect(await h.d.deliver(FIRE)).toEqual({ ok: true, sid: 's-own' })
    clock.t += 5 * MIN
    expect(await h.d.deliver(FIRE)).toEqual({ ok: true, sid: 's-own' })
    expect(await h.d.deliver({ ...FIRE, triggerId: 'job-2' })).toEqual({ ok: true, sid: 's-own' })
    expect(h.sent.length).toBe(offered)
    expect(h.own.length).toBe(3)
    expect(h.ownAnswers.length).toBe(3)
  })

  it('after the backoff one fire is offered: one more failure sits it out again, twice as long; an answer ends it', async () => {
    const clock = { t: 0 }
    const h = harness({ clock })
    await failThree(h)
    expect(await h.d.deliver(FIRE)).toMatchObject({ ok: true, sid: 's-own' })
    clock.t += 10 * MIN
    // The one try: a timeout, and it sits out again for 20 minutes.
    const probe = h.d.deliver(FIRE); h.fireTimer(); await probe
    expect(h.logs.some((l) => l.msg.includes('sits out again'))).toBe(true)
    const offered = h.sent.length
    clock.t += 15 * MIN
    expect(await h.d.deliver(FIRE)).toMatchObject({ ok: true, sid: 's-own' })
    expect(h.sent.length).toBe(offered)
    clock.t += 6 * MIN
    // The next try answers: the server takes the fires again, at once.
    const ok = h.d.deliver(FIRE)
    await h.d.answer(h.sock, { deliveryId: h.sent.at(-1)!.data.deliveryId, sid: 's-live' })
    expect(await ok).toEqual({ ok: true, sid: 's-live' })
    const next = h.d.deliver({ ...FIRE, triggerId: 'job-2' })
    expect(h.sent.at(-1)!.data.triggerId).toBe('job-2')
    await h.d.answer(h.sock, { deliveryId: h.sent.at(-1)!.data.deliveryId, declined: 'no session here' })
    expect(await next).toMatchObject({ ok: false })
  })

  it('a new follower socket (a restart, a new hello) starts with no backoff', async () => {
    const clock = { t: 0 }
    let current: { id: number } | null = null
    const restarted = { id: 3 }
    const sent: Array<Record<string, unknown>> = []
    const d = createFollowerTriggerDelivery<{ id: number }>({
      follower: () => current, mayWrite: () => true,
      send: (_ws, _ev, data) => { sent.push(data); return true },
      liveSids: () => [], own: async () => ({ ok: true, sid: 's-own' }), deliverTo: async (_f, t) => ({ ok: true, sid: t.sid }),
      nextId: (() => { let n = 0; return () => `td-${++n}` })(), answerMs: 15_000,
      setTimer: (fn) => ({ fn }), clearTimer: () => {}, log: () => {}, now: () => clock.t,
    })
    const old = { id: 1 }
    current = old
    for (let i = 0; i < 3; i++) { const a = d.deliver(FIRE); d.dropSocket(old); await a }
    expect(await d.deliver(FIRE)).toEqual({ ok: true, sid: 's-own' })
    current = restarted
    void d.deliver(FIRE)
    expect(sent.length).toBe(4)
  })
})

describe('follower trigger delivery twin wiring', () => {
  const standalone = read('src/providers/daemon-standalone.ts')
  const source = read('src/providers/daemon-source.ts')
  const CORE = 'src/providers/follower-trigger-delivery-core.ts'
  const RULE = 'src/core/routines/host-trigger-target.ts'

  it('both twins: the hello flag, the command on the follower allowlist, the tick offers through it, the socket close ends it', () => {
    for (const src of [standalone, source]) {
      expect(src).toMatch(/deliversTriggers = cmd\.deliversTriggers === true/)
      const allow = src.slice(src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set(['), src.indexOf('])', src.indexOf('FOLLOWER_ALLOWED_COMMANDS = new Set([')))
      expect(allow).toContain("'follower.trigger.deliver'")
      expect(src).toContain("case 'follower.trigger.deliver': return daemonCommands.run(")
      expect(src).toMatch(/followerTriggers\.deliver\(\{ home: spec\.home, triggerId: id, taskId: spec\.taskId, text(: text)?, messageId(: messageId)? \}\)/)
      expect(src).not.toMatch(/offlineHost\.deliverTrigger\(spec\.home/)
      expect(src).toContain('followerTriggers.dropSocket(ws)')
      // The follower's answer goes to the core from the socket it came on (through the follower entry).
      expect(src).toMatch(/triggerAnswer: (\(ws, cmd\) => |function \(ws, cmd\) \{ return )followerTriggers\.answer\(ws, cmd\)/)
      expect(src).toMatch(/followerEntry\.triggerDeliver\(ws, cmd\)/)
      expect(src).toMatch(/deliversTriggers === true \? (ws|f) : null/)
      expect(src).toMatch(/mayWrite: (\(home\) => |function \(home\) \{ return )followerEntry\.mayWrite\(home\)/)
      expect(src).toContain('offlineHost.deliverTriggerTo(fire.home, fire.taskId, target, fire.text, fire.messageId)')
      expect(src).toContain('offlineHost.liveSessionsOf(home)')
      // The fallback is counted with the gateway's own answers.
      expect(src).toContain("followerGateway.noteOwnAnswer('trigger_delivery', 'handed_back')")
    }
    expect(standalone).toContain('triggerTarget: pickHostTriggerTarget,')
    expect(source).toContain('triggerTarget: (__PICK_HOST_TRIGGER_TARGET__),')
  })

  it('the capability is advertised, and both cores are in the version hash list and the binary build list', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain('follower-trigger-delivery-v1')
    for (const f of [CORE, RULE]) {
      expect(read('src/providers/daemon-version-check.ts')).toContain(`'${f}'`)
      expect(read('scripts/build-daemon.sh')).toContain(f)
    }
    expect(standalone).toContain("from './follower-trigger-delivery-core.js'")
  })

  it('the source twin carries both inlined, and the inlined text runs alone', async () => {
    const generated = getDaemonSource()
    expect(generated).not.toContain('__CREATE_FOLLOWER_TRIGGER_DELIVERY__')
    expect(generated).not.toContain('__PICK_HOST_TRIGGER_TARGET__')
    expect(generated).toContain('var followerTriggers = (')
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function(`"use strict"; return (${createFollowerTriggerDelivery.toString()})`)() as typeof createFollowerTriggerDelivery
    const h = harness({ make })
    const result = h.d.deliver(FIRE)
    await h.d.answer(h.sock, { deliveryId: 'td-1', sid: 's-live' })
    expect(await result).toEqual({ ok: true, sid: 's-live' })
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const pick = new Function(`"use strict"; return (${pickHostTriggerTarget.toString()})`)() as typeof pickHostTriggerTarget
    expect(pick({ phase: 'WAITING', session_id: 'b' }, [{ sid: 'a', live: false }, { sid: 'b', live: false }], { resume: true })).toEqual({ ok: true, sid: 'b', resume: true })
    await tick()
  })
})
