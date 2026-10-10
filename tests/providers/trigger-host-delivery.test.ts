/**
 * Who delivers a trigger fire (trigger-claim-v1): the pure rules the daemon
 * twins run, and the offline host's half (which session on this host takes it).
 *
 * The scenario they exist for (2026-10-05): the Mac slept, a remote host kept
 * checking every minute, and five fires waited up to 42 minutes for the server
 * while the target session ran idle on that same host. Real files for the
 * offline host's copy; the FIFO write is a recorder.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  applyCheckOutcome, claimFires, coerceHostState, emptyHostState, fireDueOnHost, isHostDelivery,
  markHostDelivered, trimPendingFires, triggersSetHash, validateTriggerDef,
  DELIVER_PROMPT_MAX, HOST_DELIVERY_GRACE_MS, HOST_DELIVERY_RETRY_MS, PENDING_FIRES_MAX,
  type PendingFire, type TriggerDef, type TriggerHostState,
} from '../../src/providers/trigger-check-core.js'
import * as sidecar from '../../src/providers/trigger-check-sidecar.js'
import { buildTriggerMessage as serverEnvelope } from '../../src/core/routines/trigger-envelope.js'
import { createOfflineHost, type HostSlice } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'

const NOW = Date.parse('2026-10-05T21:00:00Z')
const HOME = '/fixture/walnut-home'
const TASK = 'mslack00-0b27'
const LIVE = 'eeeeeeee-1111-4111-8111-111111111111'
const OLD = 'ffffffff-2222-4222-8222-222222222222'
const deliver = { home: HOME, taskId: TASK, prompt: 'New messages are in the input. Handle each one.' }
const def: TriggerDef = { id: 'job-slack', name: 'Chat monitor', everyMs: 60_000, check: { run: 'true' }, deliver }

/** A state holding one fire per seq, made at `atMs` (arbitrated unless said otherwise). */
function stateWith(fires: Array<Partial<PendingFire> & { seq: number }>): TriggerHostState {
  const state = emptyHostState(NOW)
  state.pendingFires = fires.map((f) => ({ atMs: NOW, items: [{ id: `m${f.seq}` }], durationMs: 9, arbitrated: true as const, ...f }))
  state.seq = Math.max(0, ...fires.map((f) => f.seq))
  return state
}

describe('the deliver spec on the wire', () => {
  it('keeps a valid spec, and drops a malformed one without failing the trigger', () => {
    expect(validateTriggerDef(def)).toEqual({ ok: true, def: { ...def, check: { run: 'true', timeoutSeconds: 30 } } })
    for (const bad of [
      { ...deliver, home: '' },
      { ...deliver, taskId: '  ' },
      { ...deliver, prompt: '' },
      { ...deliver, prompt: 'x'.repeat(DELIVER_PROMPT_MAX + 1) },
      'not an object',
    ]) {
      const r = validateTriggerDef({ ...def, deliver: bad })
      expect(r.ok).toBe(true)
      expect(r.ok && r.def.deliver).toBeUndefined()
    }
  })

  it('leaves the hash of a set without host delivery as it was, and moves it when the prompt changes', () => {
    const plain: TriggerDef = { id: 'a', name: 'n', everyMs: 60_000, check: { run: 'x', timeoutSeconds: 30 } }
    // The pre-change canonical form, spelled out: an upgrade must not rewrite every triggers.json.
    const legacy = createHash('sha256').update(JSON.stringify([['a', 'n', 60_000, 'x', '', 30, -1]])).digest('hex').slice(0, 12)
    expect(triggersSetHash([plain])).toBe(legacy)
    const withDeliver = { ...plain, deliver }
    expect(triggersSetHash([withDeliver])).not.toBe(legacy)
    expect(triggersSetHash([{ ...withDeliver, deliver: { ...deliver, prompt: 'changed' } }])).not.toBe(triggersSetHash([withDeliver]))
  })
})

describe('a fire is arbitrated only when its server claims', () => {
  it('marks the fire when the def carried deliver, and only then', () => {
    const output = { fire: true, items: [{ id: 'm1' }], hasState: false }
    const s1 = emptyHostState(NOW)
    const f1 = applyCheckOutcome(s1, output, { kind: 'fire', items: output.items }, NOW, 5, { arbitrated: true })
    expect(f1?.arbitrated).toBe(true)
    const s2 = emptyHostState(NOW)
    const f2 = applyCheckOutcome(s2, output, { kind: 'fire', items: output.items }, NOW, 5)
    expect(f2?.arbitrated).toBeUndefined()
    // A fire from before the protocol (or from an older server's push) is never the host's.
    expect(fireDueOnHost(f2!, NOW + 10 * 60_000, NOW)).toBe(false)
  })

  it('survives the state file round trip with its claim and its host delivery', () => {
    const state = stateWith([{ seq: 1, claimedAt: NOW + 1 }, { seq: 2, host: { atMs: NOW + 2, sessionId: LIVE, messageId: 'qm-trigger-a', seqs: [2] } }])
    const back = coerceHostState(JSON.parse(JSON.stringify(state)), NOW)
    expect(back.pendingFires).toEqual(state.pendingFires)
  })
})

describe('claimFires: the server takes what it received', () => {
  it('answers claimed / host / busy / unknown per seq, and persists a new claim once', () => {
    const delivery = { atMs: NOW, sessionId: LIVE, messageId: 'qm-trigger-b', seqs: [2] }
    const state = stateWith([{ seq: 1 }, { seq: 2, host: delivery }, { seq: 3 }])
    const first = claimFires(state, [1, 2, 3, 9], NOW + 1_000, new Set([3]))
    expect(first.reply).toEqual({ claimed: [1], unknown: [9], host: [{ seq: 2, host: delivery }], busy: [3] })
    expect(first.changed).toBe(true)
    expect(state.pendingFires[0].claimedAt).toBe(NOW + 1_000)
    // A replay claims again: same verdict, nothing new to write, the first stamp kept.
    const again = claimFires(state, [1], NOW + 60_000)
    expect(again).toEqual({ reply: { claimed: [1], unknown: [], host: [], busy: [] }, changed: false })
    expect(state.pendingFires[0].claimedAt).toBe(NOW + 1_000)
  })

  it('a claimed fire is never the host\'s, however long the server takes to ack it', () => {
    const state = stateWith([{ seq: 1 }])
    claimFires(state, [1], NOW + 500)
    expect(fireDueOnHost(state.pendingFires[0], NOW + 24 * 3_600_000, NOW)).toBe(false)
  })
})

describe('fireDueOnHost: when the host delivers an unclaimed fire', () => {
  it('waits the grace from the fire, and from the moment this daemon armed the trigger', () => {
    const [fire] = stateWith([{ seq: 1 }]).pendingFires
    expect(fireDueOnHost(fire, NOW + HOST_DELIVERY_GRACE_MS - 1, NOW)).toBe(false)
    expect(fireDueOnHost(fire, NOW + HOST_DELIVERY_GRACE_MS, NOW)).toBe(true)
    // A daemon restarted an hour later: the returning server gets its own grace first.
    const restartedAt = NOW + 3_600_000
    expect(fireDueOnHost(fire, restartedAt + 1_000, restartedAt)).toBe(false)
    expect(fireDueOnHost(fire, restartedAt + HOST_DELIVERY_GRACE_MS, restartedAt)).toBe(true)
  })

  it('backs off after an attempt that did not land, and never repeats a delivered one', () => {
    const [fire] = stateWith([{ seq: 1, hostTriedAt: NOW + HOST_DELIVERY_GRACE_MS }]).pendingFires
    expect(fireDueOnHost(fire, NOW + HOST_DELIVERY_GRACE_MS + HOST_DELIVERY_RETRY_MS - 1, NOW)).toBe(false)
    expect(fireDueOnHost(fire, NOW + HOST_DELIVERY_GRACE_MS + HOST_DELIVERY_RETRY_MS, NOW)).toBe(true)
    const state = stateWith([{ seq: 1, hostTriedAt: NOW }, { seq: 2 }, { seq: 3 }])
    markHostDelivered(state, { atMs: NOW, sessionId: LIVE, messageId: 'qm-trigger-c', seqs: [1, 2] })
    expect(state.pendingFires.map((f) => [f.seq, !!f.host, f.hostTriedAt])).toEqual([[1, true, undefined], [2, true, undefined], [3, false, undefined]])
    expect(fireDueOnHost(state.pendingFires[0], NOW + 10 * 60_000, NOW)).toBe(false)
  })

  it('isHostDelivery accepts only the full shape (it arrives over the wire)', () => {
    expect(isHostDelivery({ atMs: NOW, sessionId: LIVE, messageId: 'qm-1', seqs: [1] })).toBe(true)
    for (const bad of [null, {}, { atMs: NOW, sessionId: '', messageId: 'qm-1', seqs: [] }, { atMs: 'x', sessionId: LIVE, messageId: 'qm-1', seqs: [] }, { atMs: NOW, sessionId: LIVE, messageId: 'qm-1' }]) {
      expect(isHostDelivery(bad)).toBe(false)
    }
  })
})

describe('the pending cap drops what the host already delivered first', () => {
  it('keeps every undelivered fire while a delivered one can go', () => {
    const delivered = { atMs: NOW, sessionId: LIVE, messageId: 'qm-trigger-d', seqs: [] as number[] }
    const fires = Array.from({ length: PENDING_FIRES_MAX + 2 }, (_, i) => ({ seq: i + 1, ...(i % 2 === 1 ? { host: delivered } : {}) }))
    const state = stateWith(fires)
    trimPendingFires(state)
    expect(state.pendingFires).toHaveLength(PENDING_FIRES_MAX)
    // Seqs 2 and 4 (the oldest delivered ones) went; seq 1, undelivered and oldest, stayed.
    expect(state.pendingFires.map((f) => f.seq).slice(0, 4)).toEqual([1, 3, 5, 6])
  })
})

describe('the envelope a host builds is the one the server builds', () => {
  it('is byte-identical through the sidecar entry and the server module, backlog and lateness included', () => {
    const fires = [
      { atMs: NOW, items: [{ id: 'm1', text: 'hello é中' }], input: 'From Ana: can you review?' },
      { atMs: NOW + 120_000, items: [{ id: 'm2' }] },
    ]
    const at = { deliveredAtMs: NOW + 42 * 60_000 }
    const fromSidecar = sidecar.buildTriggerMessage({ name: def.name }, fires, deliver.prompt, at)
    expect(fromSidecar).toBe(serverEnvelope({ name: def.name }, fires, deliver.prompt, at))
    expect(fromSidecar).toContain('kind="trigger"')
    expect(fromSidecar).toContain('42m late')
    // The sidecar still carries the whole check contract the source twin calls.
    expect(typeof sidecar.claimFires).toBe('function')
    expect(typeof sidecar.validateTriggerDef).toBe('function')
  })
})

describe('offline host: which session on this host takes the fire', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  function setup(overrides: Partial<HostSlice> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-host-'))
    dirs.push(dir)
    const delivered: Array<{ sid: string; text: string; messageId: string }> = []
    const live = new Set([LIVE])
    const fail = { reason: null as string | null }
    const host = createOfflineHost({
      fs, path, dir, now: () => NOW, randomHex: (n) => randomBytes(n).toString('hex'),
      keyOf: (h) => createHash('sha1').update(h).digest('hex').slice(0, 12),
      kit: createEnvelopeKit(), log: () => {},
      isLive: (sid) => live.has(sid), turnActive: () => false, streamOffset: () => undefined,
      deliver: async (sid, text, messageId) => {
        if (fail.reason) return { ok: false, reason: fail.reason }
        delivered.push({ sid, text, messageId })
        return { ok: true }
      },
    })
    host.configure({
      v: 1, home: HOME, hash: 'h1', asOf: NOW, host: 'devbox',
      // Newest first, as the server lists them: the live one is not the first row.
      sessions: [{ sid: OLD, taskId: TASK, title: 'Old run' }, { sid: LIVE, taskId: TASK, title: 'Chat loop' }],
      tasks: [{ id: TASK, title: 'Monitor chat', phase: 'IN_PROGRESS', project: 'Ops' }],
      requests: [],
      ...overrides,
    })
    return { host, delivered, live, fail }
  }

  it('writes into the live session of the task, skipping a stopped one', async () => {
    const h = setup()
    expect(await h.host.deliverTrigger(HOME, TASK, 'ENVELOPE', 'qm-trigger-1')).toEqual({ ok: true, sid: LIVE })
    expect(h.delivered).toEqual([{ sid: LIVE, text: 'ENVELOPE', messageId: 'qm-trigger-1' }])
  })

  it('leaves the fire to the server when nothing here can take it', async () => {
    const h = setup()
    expect(await h.host.deliverTrigger('/other/home', TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('no host copy') })
    expect(await h.host.deliverTrigger(HOME, 'mother00-0001', 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('no live session') })
    h.live.clear()
    expect(await h.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('no live session') })
    h.live.add(LIVE)
    h.fail.reason = 'FIFO write failed'
    expect(await h.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toEqual({ ok: false, reason: 'FIFO write failed' })
    expect(h.delivered).toEqual([])
  })

  it('never delivers into a completed task, including one completed offline and not yet replayed', async () => {
    const done = setup({ tasks: [{ id: TASK, title: 'Monitor chat', phase: 'COMPLETE', project: 'Ops' }] })
    expect(await done.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: 'target task is complete' })
    const queued = setup()
    const r = await queued.host.handle(HOME, LIVE, 'tools.call', { name: 'task_complete', args: { id: TASK } })
    expect(r.ok).toBe(true)
    expect(await queued.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: 'target task is complete' })
    expect(done.delivered.length + queued.delivered.length).toBe(0)
  })
})

describe('offline host: a stopped session is resumed for the fire (trigger-host-resume-v1)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const OTHER = 'abababab-3333-4333-8333-333333333333'
  const ASIDE = 'cdcdcdcd-4444-4444-8444-444444444444'

  function setup(overrides: Partial<HostSlice> = {}, resumeAnswer: { ok: true } | { ok: false; reason: string } = { ok: true }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-host-resume-'))
    dirs.push(dir)
    const resumed: Array<{ home: string; sid: string; text: string; messageId: string; taskId: string }> = []
    const delivered: string[] = []
    const answer = { value: resumeAnswer as { ok: true } | { ok: false; reason: string } }
    const host = createOfflineHost({
      fs, path, dir, now: () => NOW, randomHex: (n) => randomBytes(n).toString('hex'),
      keyOf: (h) => createHash('sha1').update(h).digest('hex').slice(0, 12),
      kit: createEnvelopeKit(), log: () => {},
      isLive: () => false, turnActive: () => false, streamOffset: () => undefined,
      deliver: async (sid) => { delivered.push(sid); return { ok: true } },
      resume: async (home, sid, text, messageId, taskId) => {
        resumed.push({ home, sid, text, messageId, taskId })
        return answer.value
      },
    })
    host.configure({
      v: 1, home: HOME, hash: 'h1', asOf: NOW, host: 'devbox',
      // Newest first, as the server lists them.
      sessions: [
        { sid: ASIDE, taskId: TASK, title: 'env', aside: true },
        { sid: OTHER, taskId: TASK, title: 'Newer run' },
        { sid: OLD, taskId: TASK, title: 'Old run' },
      ],
      tasks: [{ id: TASK, title: 'Monitor chat', phase: 'WAITING', project: 'Ops' }],
      requests: [],
      ...overrides,
    })
    return { host, resumed, delivered, answer }
  }

  it('resumes the newest session of the task here when the task names none, and journals it', async () => {
    const h = setup()
    expect(await h.host.deliverTrigger(HOME, TASK, 'ENVELOPE', 'qm-trigger-9')).toEqual({ ok: true, sid: OTHER, resumed: true })
    expect(h.resumed).toEqual([{ home: HOME, sid: OTHER, text: 'ENVELOPE', messageId: 'qm-trigger-9', taskId: TASK }])
    expect(h.delivered).toEqual([])
    const { records } = h.host.drain(HOME)
    expect(records).toEqual([expect.objectContaining({ kind: 'resume', sid: OTHER, taskId: TASK, messageId: 'qm-trigger-9' })])
    expect(records[0].online).toBeUndefined()
    expect(h.host.pendingHandover(HOME)).toBe(true)
  })

  it('resumes the task\'s own session when it is here, even an older one', async () => {
    const h = setup({ tasks: [{ id: TASK, title: 'Monitor chat', phase: 'WAITING', project: 'Ops', session_id: OLD }] })
    expect(await h.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toEqual({ ok: true, sid: OLD, resumed: true })
  })

  it('leaves it to the server when the task\'s session runs on another host, or the server would not wake it', async () => {
    const elsewhere = setup({ tasks: [{ id: TASK, title: 'Monitor chat', phase: 'WAITING', project: 'Ops', session_id: 'eeee0000-9999-4999-8999-999999999999' }] })
    expect(await elsewhere.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('not on this host') })
    const broken = setup({
      sessions: [{ sid: OTHER, taskId: TASK, noResume: true }, { sid: ASIDE, taskId: TASK, aside: true }],
    })
    expect(await broken.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: expect.stringContaining('no session of the target task on this host') })
    const slotBroken = setup({
      sessions: [{ sid: OTHER, taskId: TASK, noResume: true }, { sid: OLD, taskId: TASK }],
      tasks: [{ id: TASK, title: 'Monitor chat', phase: 'WAITING', project: 'Ops', session_id: OTHER }],
    })
    expect(await slotBroken.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false })
    const done = setup({ tasks: [{ id: TASK, title: 'Monitor chat', phase: 'COMPLETE', project: 'Ops' }] })
    expect(await done.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toMatchObject({ ok: false, reason: 'target task is complete' })
    for (const h of [elsewhere, broken, slotBroken, done]) {
      expect(h.resumed).toEqual([])
      expect(h.host.drain(HOME).records).toEqual([])
    }
  })

  it('a refused or failed resume journals nothing and says why', async () => {
    const h = setup({}, { ok: false, reason: 'this host resumed that session moments ago' })
    expect(await h.host.deliverTrigger(HOME, TASK, 'E', 'qm-1')).toEqual({ ok: false, reason: 'this host resumed that session moments ago' })
    expect(h.host.drain(HOME).records).toEqual([])
  })
})
