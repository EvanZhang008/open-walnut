/**
 * A leader restart in the middle of a service set move keeps the triggers' memory
 * (service-set-move.ts `owed`/`memory`). Before the fix it lived in the move's closure only: a
 * restart after the drop lost it, the shared daemon may no longer give it, and the triggers
 * started empty on the set, so a quiet mail or PR watch reported its old items again. The Mac's
 * leader restarts on every deploy, and a move waits for a turn to end, so this is not rare.
 *
 * What's real: ServiceSetLink, runMove, the kept records (files in a temp dir). What's faked:
 * the host (two daemons, each with its trigger states), the redial, the sessions. A restart is a
 * step that never answers: the old process is dropped there, and a new link reads the same files.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceSetLink, SetLinkConn, SetLinkDeps } from '../../src/providers/service-set-move-link.js'
import type { MoveRecord } from '../../src/providers/service-set-move.js'

/** One leader process: its own copy of every module (a restart forgets what a move held in memory). */
async function leaderProcess() {
  vi.resetModules()
  const [{ ServiceSetLink }, { serviceSetMoves }, { updateStoresSettled }, { recordServiceSetFrom, hostServiceSets }, { moveStoreFor }] = await Promise.all([
    import('../../src/providers/service-set-move-link.js'), import('../../src/providers/service-set-move.js'),
    import('../../src/providers/daemon-update-store.js'), import('../../src/providers/service-set-leader.js'),
    import('../../src/providers/service-set-move-store.js'),
  ])
  return { ServiceSetLink, serviceSetMoves, updateStoresSettled, recordServiceSetFrom, hostServiceSets, moveStoreFor }
}
let proc: Awaited<ReturnType<typeof leaderProcess>>

const WALNUT = '0123456789abcdef0123456789abcdef'
const SET = '0123456789abcdef'
const HOME = '/home/u/.open-walnut'
const RT = `/home/u/.open-walnut-host/walnuts/${SET}/rt`
const CAPS = ['host-server-v1', 'walnut-scope-v1', 'trigger-state-snapshot-v1', 'trigger-state-seed-v1']
const PLACE = 'ssh:h'
/** What the mail watch has already reported: its seen items and cursor. */
const MAIL = { epoch: 'e1', seq: 7, seen: { 'msg-1': 1, 'msg-2': 2 }, cursor: 'c-41' }
const NEVER = new Promise<never>(() => {})

/** One machine with the shared daemon and this Walnut's set, each keeping its own trigger states. */
function machine() {
  return {
    shared: { states: new Map<string, Record<string, unknown>>([['mail', MAIL]]), armed: true },
    set: { states: new Map<string, Record<string, unknown>>(), armed: false, seeds: [] as Array<{ triggerId: string; state: unknown }> },
    log: [] as string[],
    /** How the set's daemon answers a seed now: as it should, a link cut, a write that failed there. */
    seedFails: null as null | 'cut' | 'write_failed',
    /** The set's daemon takes no seed at all (no trigger-state-seed-v1). */
    noSeed: false,
    /** The link's last push and its trigger ids (null: no push yet on this connect). */
    pushed: null as null | string[],
    /** Called when a redial reaches the set (the connect's own first trigger push asks then). */
    onSetHello: null as null | (() => void),
    /** A redial that does not answer yet (a point-back's redial under way). */
    relinkHangs: false,
  }
}
type Machine = ReturnType<typeof machine>

/** A new leader process's link to the machine: SSH, dialling where sshDir points. `cut`: the step this process dies at. */
async function leader(m: Machine, cut?: 'stop' | 'reconnect-set' | 'seed') {
  proc = await leaderProcess()
  const { ServiceSetLink } = proc
  let hello = ''
  let link!: ServiceSetLink
  const notices: string[] = []
  /** Every notice call, null (cleared) included. */
  const said: Array<string | null> = []
  const at = () => (hello === SET ? m.set : m.shared)
  const c: SetLinkConn = {
    hostKey: 'h', kind: () => 'ssh', connected: true,
    helloSet: () => hello,
    send: async (cmd, params) => {
      m.log.push(`${cmd}@${hello === SET ? 'set' : 'shared'}`)
      if (cmd === 'triggers.configure') { at().armed = ((params.config as { triggers?: unknown[] } | undefined)?.triggers?.length ?? 0) > 0; return { ok: true } }
      if (cmd === 'triggers.state.snapshot') {
        const state = at().states.get(String(params.triggerId))
        return state ? { ok: true, supported: true, state, digest: `d-${String(params.triggerId)}` } : { ok: true, supported: false, reason: 'state_missing' }
      }
      if (cmd === 'triggers.state.seed') {
        if (cut === 'seed') return NEVER
        if (m.seedFails === 'cut') throw new Error('the link dropped')
        if (m.seedFails === 'write_failed') return { ok: true, seeded: false, reason: 'write_failed' }
        if (at().armed) return { ok: true, seeded: false, reason: 'still_configured' }
        m.set.seeds.push({ triggerId: String(params.triggerId), state: params.state })
        m.set.states.set(String(params.triggerId), params.state as Record<string, unknown>)
        return { ok: true, seeded: true }
      }
      return { ok: true, status: { state: 'off' } }
    },
    hasCapability: (cap) => CAPS.includes(cap) && !(m.noSeed && cap === 'trigger-state-seed-v1'),
    sharedEndpoint: () => null,
    workUnderWay: () => 0,
    drained: async () => true,
    run: async () => '{"ok":true}',
    provision: async () => ({ set: SET, installed: true, ok: true, runtimeDir: RT }),
    relink: async () => {
      const d = await link.sshDir()
      if (d?.set === SET && cut === 'reconnect-set') return NEVER
      if (m.relinkHangs) return NEVER
      hello = d?.set ?? ''
      m.log.push(`relink:${hello === SET ? 'set' : 'shared'}`)
      if (hello === SET) m.onSetHello?.()
      return hello
    },
    setHold: () => {},
    redeliver: () => {},
    dialled: () => (hello === SET ? RT : '/tmp/open-walnut'),
    triggerIds: () => m.pushed ?? ['mail'],
    triggersPushed: () => m.pushed !== null,
    drainJournal: async () => {},
    home: HOME,
    walnutId: async () => WALNUT,
    notice: (_k, t) => { said.push(t); if (t) notices.push(t) },
  }
  const deps: SetLinkDeps = {
    sessions: async () => [{ id: 's1' }],
    stop: async () => (cut === 'stop' ? NEVER : { ok: true }),
    sleep: async () => {},
    settleMs: 0,
  }
  link = new ServiceSetLink(c, deps, () => 'walnut-daemon-abc')
  /** The connect of a new process: it dials where its records point now. */
  const connect = async () => { hello = (await link.sshDir())?.set ?? '' }
  return { link, notices, said, connect, hello: () => hello }
}

/** Let the old process run until it hangs at its cut step, then drop it (the restart). */
async function runUntilCut(m: Machine, cut: 'stop' | 'reconnect-set' | 'seed'): Promise<void> {
  const old = await leader(m, cut)
  void old.link.check()
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5))
    await proc.updateStoresSettled()
    const r = await proc.serviceSetMoves.read(PLACE)
    if (cut === 'stop' && r?.phase === 'holding' && r.owed) break
    if (cut === 'reconnect-set' && r?.phase === 'flipped') break
    if (cut === 'seed' && r?.phase === 'done' && m.log.includes('relink:set')) break
  }
  old.link.stop()
}

const kept = async (): Promise<MoveRecord | null> => { await proc.updateStoresSettled(); return proc.moveStoreFor(PLACE).read() }
/** The kept copy of the memory, made unreadable (a file cut short, a disk error). */
const spoilMemory = async (): Promise<void> => { await proc.updateStoresSettled(); fs.writeFileSync(memoryFile(), '{ "not": "a record", ') }
const memoryFile = (): string => process.env.WALNUT_SERVICE_SET_MOVE_FILE!.replace(/\.json$/, '-memory.json')

describe('a leader restart mid-move keeps the triggers\' memory', () => {
  let dir = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-memory-'))
    for (const k of ['WALNUT_HOST_SERVICE_SETS', 'WALNUT_SERVICE_SET_FILE', 'WALNUT_SERVICE_SET_MOVE_FILE']) saved[k] = process.env[k]
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
    process.env.WALNUT_SERVICE_SET_MOVE_FILE = path.join(dir, 'moves.json')
    proc = await leaderProcess()
    await proc.recordServiceSetFrom(PLACE, `service set: ${SET}`, RT)
  })
  afterEach(async () => {
    await proc.updateStoresSettled()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('kept from the drop on, in the move\'s own record (0600), and gone once the set\'s daemon has it', async () => {
    const m = machine()
    await runUntilCut(m, 'stop')
    const r = await kept()
    expect(r).toMatchObject({ phase: 'holding', owed: true, memory: [{ triggerId: 'mail', state: MAIL, digest: 'd-mail' }] })
    expect(fs.statSync(process.env.WALNUT_SERVICE_SET_MOVE_FILE!).mode & 0o777).toBe(0o600)
    // The memory lives in its own file (0600), so the record rewritten at every stopped session stays small.
    expect(fs.statSync(memoryFile()).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(process.env.WALNUT_SERVICE_SET_MOVE_FILE!, 'utf8')).not.toContain('msg-1')
    expect(fs.readFileSync(memoryFile(), 'utf8')).toContain('msg-1')
    const next = await leader(m)
    await next.connect()
    await next.link.check()
    const done = await kept()
    expect(done?.phase).toBe('done')
    expect(done?.owed).toBeUndefined()
    expect(done?.memory).toBeUndefined()
  })

  it('restart after the drop (holding): the shared daemon no longer gives it, and the set is seeded with the kept copy', async () => {
    const m = machine()
    await runUntilCut(m, 'stop')
    m.shared.states.clear()
    const next = await leader(m)
    await next.connect()
    await next.link.check()
    expect((await kept())?.phase).toBe('done')
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
  })

  it('restart after the drop: a shared daemon that still holds it gives the newer state, which wins', async () => {
    const m = machine()
    await runUntilCut(m, 'stop')
    const newer = { ...MAIL, seq: 8, seen: { ...MAIL.seen, 'msg-3': 3 } }
    m.shared.states.set('mail', newer)
    const next = await leader(m)
    await next.connect()
    await next.link.check()
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: newer }])
  })

  it('restart after the flip (flipped): the flip is pointed back, the move runs again, and seeds the same memory', async () => {
    const m = machine()
    await runUntilCut(m, 'reconnect-set')
    expect(await kept()).toMatchObject({ phase: 'flipped', owed: true })
    m.shared.states.clear()
    const next = await leader(m)
    await next.connect()
    expect(next.hello()).toBe('')
    await next.link.check()
    expect((await kept())?.phase).toBe('done')
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
  })

  it('restart after the done record, before the release: the first trigger push on the set waits for the seed', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    expect(await kept()).toMatchObject({ phase: 'done', owed: true })
    m.shared.states.clear()
    const next = await leader(m)
    await next.connect()
    expect(next.hello()).toBe(SET)
    // What DaemonConnection.pushTriggersOnce asks before a connect's first push.
    expect(await next.link.beforeTriggerPush()).toBe(true)
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
    expect((await kept())?.owed).toBeUndefined()
    // Asked again (a later connect): nothing is owed, nothing is seeded twice.
    expect(await next.link.beforeTriggerPush()).toBe(true)
    expect(m.set.seeds.length).toBe(1)
  })

  it('a kept copy that cannot be read on the set: no trigger goes there, Walnut Health says so, and the link goes back to the shared daemon', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    await spoilMemory()
    const next = await leader(m)
    await next.connect()
    expect(await next.link.beforeTriggerPush()).toBe(false)
    expect(m.set.seeds).toEqual([])
    expect(next.notices.join('\n')).toMatch(/lost in a restart/)
    expect(await kept()).toBeNull()
    for (let i = 0; i < 100 && m.log.at(-1) !== 'relink:shared'; i++) await new Promise((r) => setTimeout(r, 5))
    expect(m.log.at(-1)).toBe('relink:shared')
  })

  it('a kept copy that cannot be read on the shared daemon: taken again there', async () => {
    const m = machine()
    await runUntilCut(m, 'stop')
    await spoilMemory()
    const next = await leader(m)
    await next.connect()
    await next.link.check()
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
  })

  it('a kept copy that cannot be read, and a shared daemon that cannot give it now: the move gives up and nothing reaches the set', async () => {
    const m2 = machine()
    await runUntilCut(m2, 'stop')
    await spoilMemory()
    const third = await leader(m2)
    // The shared daemon cannot give it now (a refusal other than "none there").
    const send = (third.link as unknown as { c: SetLinkConn }).c.send
    ;(third.link as unknown as { c: SetLinkConn }).c.send = async (cmd, params) => cmd === 'triggers.state.snapshot' ? { ok: true, supported: false, reason: 'state_corrupt' } : send(cmd, params)
    await third.connect()
    await third.link.check()
    const gave = await kept()
    expect(gave?.phase).toBe('gave_up')
    expect(gave?.owed).toBeUndefined()
    expect(m2.set.seeds).toEqual([])
    expect(m2.set.armed).toBe(false)
  })

  it('a seed a link cut ends keeps the memory owed: no trigger is pushed there, Health says they wait, and the next try seeds it', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    m.shared.states.clear()
    const next = await leader(m)
    await next.connect()
    m.seedFails = 'cut'
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(false)
    expect((await kept())?.owed).toBe(true)
    expect((await kept())?.memory).toEqual([{ triggerId: 'mail', state: MAIL, digest: 'd-mail' }])
    expect(next.notices.join('\n')).toMatch(/wait to start on its own service there/)
    // A write that failed on the set's daemon: still owed.
    m.seedFails = 'write_failed'
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(false)
    expect((await kept())?.owed).toBe(true)
    // The next connect (or the retry) seeds it, and the notice goes.
    m.seedFails = null
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(true)
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
    expect((await kept())?.owed).toBeUndefined()
    expect(next.said.at(-1)).toBeNull()
    next.link.stop()
  })

  it('a set\'s daemon that can never take a seed owes it no more: the triggers start afresh there', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    const next = await leader(m)
    await next.connect()
    m.noSeed = true
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(true)
    expect(m.set.seeds).toEqual([])
    expect((await kept())?.owed).toBeUndefined()
  })

  it('the move\'s own carry cut by the link: the done move still owes it, and the first push there seeds it', async () => {
    const m = machine()
    m.seedFails = 'cut'
    const first = await leader(m)
    await first.link.check()
    expect(await kept()).toMatchObject({ phase: 'done', owed: true })
    m.seedFails = null
    expect(await first.link.beforeTriggerPush(['mail'])).toBe(true)
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
    expect((await kept())?.owed).toBeUndefined()
    first.link.stop()
  })

  it('memory of a trigger deleted during the restart is not seeded at the push', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    const next = await leader(m)
    await next.connect()
    // The push carries only the triggers that exist now.
    expect(await next.link.beforeTriggerPush(['other'])).toBe(true)
    expect(m.set.seeds).toEqual([])
    expect((await kept())?.owed).toBeUndefined()
  })

  it('memory of a trigger deleted during the restart is not carried by the move that runs again', async () => {
    const m2 = machine()
    m2.shared.states.set('gone', { epoch: 'e', seq: 1, seen: { x: 1 } })
    m2.pushed = ['mail', 'gone']
    await runUntilCut(m2, 'stop')
    // The restart's connect pushed the triggers there again, and 'gone' was deleted meanwhile.
    m2.pushed = ['mail']
    m2.shared.states.clear()
    const again = await leader(m2)
    await again.connect()
    await again.link.check()
    expect(m2.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
  })

  it('a lost copy pointing the link back and a look that finds the set at once: the host is not kept as moved, and the notice stays', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    await spoilMemory()
    const next = await leader(m)
    await next.connect()
    // The look's own branch and the push's point-back, at the same moment.
    await Promise.all([next.link.beforeTriggerPush(['mail']), next.link.check()])
    await proc.updateStoresSettled()
    expect((await proc.hostServiceSets.read(PLACE))?.movedAt).toBeUndefined()
    expect(next.said.filter((t) => t !== null).at(-1)).toMatch(/lost in a restart/)
    expect(next.said.at(-1)).not.toBeNull()
  })

  it('a record that cannot be written stops no session (the move gives up before it)', async () => {
    const m = machine()
    // The move's files cannot be written (a directory where the file goes).
    fs.mkdirSync(process.env.WALNUT_SERVICE_SET_MOVE_FILE!, { recursive: true })
    const stops: string[] = []
    const first = await leader(m)
    ;(first.link as unknown as { d: SetLinkDeps }).d.stop = async (id) => { stops.push(id); return { ok: true } }
    await first.link.check()
    expect(stops).toEqual([])
  })

  it('the flip\'s own reconnect push waits for the move: a carry the link cut keeps it off the set, owed, and the next connect seeds it', async () => {
    const m = machine()
    m.seedFails = 'cut'
    const first = await leader(m)
    let push: Promise<boolean> | null = null
    // What DaemonConnection.pushTriggersOnce asks at the connect the flip makes (setConnected), while the move holds the host.
    m.onSetHello = () => { push ??= first.link.beforeTriggerPush(['mail']) }
    await first.link.check()
    expect(push).not.toBeNull()
    expect(await push).toBe(false)
    expect(await kept()).toMatchObject({ phase: 'done', owed: true })
    expect(m.set.seeds).toEqual([])
    m.seedFails = null
    expect(await first.link.beforeTriggerPush(['mail'])).toBe(true)
    expect(m.set.seeds).toEqual([{ triggerId: 'mail', state: MAIL }])
    first.link.stop()
  })

  it('a point-back whose redial is still under way: a look right after it keeps nothing as moved', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    await spoilMemory()
    const next = await leader(m)
    await next.connect()
    m.relinkHangs = true
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(false)
    await next.link.check()
    await proc.updateStoresSettled()
    expect((await proc.hostServiceSets.read(PLACE))?.movedAt).toBeUndefined()
    expect(next.said.at(-1)).toMatch(/lost in a restart/)
  })

  it('memory owed past its bound is given up with a Health line: one trigger never keeps every trigger off the set', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    const next = await leader(m)
    await next.connect()
    m.seedFails = 'cut'
    process.env.WALNUT_SERVICE_SET_SEED_OWED_MAX_MS = '1'
    try {
      expect(await next.link.beforeTriggerPush(['mail'])).toBe(true)
    } finally { delete process.env.WALNUT_SERVICE_SET_SEED_OWED_MAX_MS }
    expect((await kept())?.owed).toBeUndefined()
    expect(next.said.at(-1)).toMatch(/start afresh there/)
  })

  it('a "they wait" notice goes once nothing is owed any more, however it was handed over', async () => {
    const m = machine()
    await runUntilCut(m, 'seed')
    const next = await leader(m)
    await next.connect()
    m.seedFails = 'cut'
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(false)
    expect(next.said.at(-1)).toMatch(/wait to start/)
    const r = (await kept())!
    await proc.moveStoreFor(PLACE).write({ ...r, owed: undefined, memory: undefined })
    expect(await next.link.beforeTriggerPush(['mail'])).toBe(true)
    expect(next.said.at(-1)).toBeNull()
    next.link.stop()
  })
})
