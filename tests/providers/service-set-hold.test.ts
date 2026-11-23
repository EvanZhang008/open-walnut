/**
 * The hold a service set move puts on a host link (src/providers/service-set-hold.ts), held in the
 * one place every command to the host's daemon goes through (DaemonConnection.send). Review round
 * 1, B3: the hold covered only native `start`/`send`, so an ACP start or send, a one-shot, a
 * host_exec run and this Walnut's own follower and trigger pushes still reached the shared daemon
 * during a move.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-set-hold-test'))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { pastSetHold, SetHold, setHoldKind } from '../../src/providers/service-set-hold.js'
import { setServiceConfigPaths } from '../../src/providers/service-set-leader.js'
import { linkFailureKind } from '../../src/providers/link-failure.js'

afterEach(() => { vi.restoreAllMocks() })

describe('setHoldKind: every command that starts work there is held', () => {
  it('send is refused (the runner keeps it pending); a start, every other work command and the pushes that start work wait', () => {
    expect(setHoldKind('send', {})).toBe('refuse')
    for (const cmd of ['start', 'acpStart', 'acpNewSession', 'acpSend', 'acpSteer', 'acpRespond', 'oneshot.run', 'oneshot.prewarm', 'exec.run', 'exec.script', 'sendRaw', 'bridgeResume',
      'server.configure', 'triggers.configure', 'jobs.configure']) {
      expect(setHoldKind(cmd, {}), cmd).toBe('wait')
    }
    // An agent.<op> frame by the command it runs.
    expect(setHoldKind('agent.start', { engine: 'codex' })).toBe('wait')
    expect(setHoldKind('agent.send', { engine: 'claude-code' })).toBe('refuse')
    // Reads, stops and the move's own looks go on.
    for (const cmd of ['getState', 'status', 'list', 'stop', 'acpStop', 'acpCancel', 'cli.holder', 'exec.list', 'exec.read', 'server.status', 'triggers.claim', 'ping']) {
      expect(setHoldKind(cmd, {}), cmd).toBe(null)
    }
  })
})

describe('SetHold', () => {
  it('refuses, waits for the release, lets the move\'s own commands pass, and counts work under way', async () => {
    const h = new SetHold()
    h.set(true)
    await expect(h.admit('send', {}, () => new Error('held'))).rejects.toThrow('held')
    let went = false
    const waiting = h.admit('acpStart', {}, () => new Error('held')).then((done) => { went = true; return done })
    const own = await h.admit('server.configure', pastSetHold({}), () => new Error('held'))
    own()
    // Still held: the move's own command went, the ACP start did not (raced against a promise already settled).
    expect(await Promise.race([waiting.then(() => 'went'), Promise.resolve('held')])).toBe('held')
    expect(went).toBe(false)
    h.set(false)
    const done = await waiting
    expect(went).toBe(true)
    expect(h.inFlight).toBe(1)
    let drained = false
    const d = h.drained(1_000).then((v) => { drained = v })
    expect(await Promise.race([d.then(() => 'drained'), Promise.resolve('under way')])).toBe('under way')
    expect(drained).toBe(false)
    done()
    await d
    expect(drained).toBe(true)
    expect(await h.drained(1)).toBe(true)
  })

  it('a held command that waits past the bound fails in the words of a link that is down', async () => {
    const h = new SetHold()
    h.set(true)
    await expect(h.admit('oneshot.run', {}, () => new Error('not connected'), 10)).rejects.toThrow('not connected')
    expect(await h.drained(10)).toBe(true)
  })
})

describe('DaemonConnection.send holds by kind (the one place)', () => {
  it('while held: send throws the link-down words (tagged no-link), a start, an ACP start and a trigger push wait and then go, reads go at once', async () => {
    const conn = new DaemonConnection('devbox', null)
    const went: string[] = []
    vi.spyOn(conn as unknown as { sendAdmitted: (cmd: string) => Promise<unknown> }, 'sendAdmitted').mockImplementation(async (cmd: string) => { went.push(cmd); return { ok: true } })
    const hold = (conn as unknown as { _setHold: SetHold })._setHold
    hold.set(true)
    expect(conn.serviceSetHeld).toBe(true)
    const refused = await conn.send('send', { sid: 's' }).catch((e: unknown) => e)
    expect(String(refused)).toMatch(/DaemonConnection not connected to devbox/)
    expect(linkFailureKind(refused)).toBe('no-link')
    // Drill round 3, R3-1: a session started during the hold waits for the release, then starts
    // where the link reaches (the set's daemon after the flip), never refused into an error.
    const start = conn.send('start', { sid: 'fresh' })
    const acp = conn.send('acpStart', { sid: 'a' })
    const push = conn.send('triggers.configure', { home: '/h' })
    const exec = conn.send('agent.start', { engine: 'codex' })
    await conn.send('getState', { sid: 's' })
    await conn.send('server.configure', pastSetHold({ home: '/h', spec: null }))
    expect(went).toEqual(['getState', 'server.configure'])
    hold.set(false)
    await Promise.all([start, acp, push, exec])
    expect(went.slice(2).sort()).toEqual(['acpStart', 'agent.start', 'start', 'triggers.configure'])
  })
})

describe('the revive goes by the dir the link dials (review round 1, should-fix 9)', () => {
  const SET = '0123456789abcdef'
  type Revive = { reviveRemoteService: (s: { present: string[]; unknown: string[] }) => Promise<string | null>; _remoteSet: string; sshExec: (c: string) => Promise<string> }
  const make = (remoteSet: string) => {
    const conn = new DaemonConnection('devbox', { hostname: 'devbox.example.com', user: 'tester' })
    const c = conn as unknown as Revive
    c._remoteSet = remoteSet
    // A link that is down reads 'shared' (no hello names the set).
    vi.spyOn(DaemonConnection.prototype as unknown as { serviceSetLink: unknown }, 'serviceSetLink', 'get')
      .mockReturnValue({ standingFor: async () => ({ standing: 'shared', record: { set: SET } }) })
    const ran: string[] = []
    vi.spyOn(c, 'sshExec').mockImplementation(async (cmd: string) => { ran.push(cmd); return 'outcome=up\n' })
    return { c, ran }
  }

  it('this Walnut\'s own set\'s dir is revived as its set while the link is down; the default\'s dir (another Walnut\'s) never is', async () => {
    const own = make(SET)
    await own.c.reviveRemoteService({ present: [setServiceConfigPaths(SET).linux[0]!], unknown: [] })
    expect(own.ran.length).toBe(1)
    expect(own.ran[0]).toContain(`open-walnut-daemon-${SET}.service`)
    vi.restoreAllMocks()
    const shared = make('')
    expect(await shared.c.reviveRemoteService({ present: [setServiceConfigPaths('').linux[0]!], unknown: [] })).toBe(null)
    expect(shared.ran).toEqual([])
  })
})
