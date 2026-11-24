/**
 * A revoke holds against a host that is no longer trusted (the C7 security review, round 1):
 *   S1  the ban rests on the person's facts: the keys named when it was made, and a key once judged
 *       its alias, stay banned whatever the host's hello says afterwards;
 *   N1  this leader's own machine id and `__local__` are never banned;
 *   N4  a machine id that comes or goes under the same key is a change the links hear;
 *   S3  no new process starts there (one check at the command gate), and no work moves there;
 *   S2  it is handed no machine token for the cloud bridge, and the tunnel leaves it;
 *   S4  only a person's own lines reach a session running there; automated rows are parked with why,
 *       and a refusal is a permanent delivery failure (no retry loop).
 * The door, mint and allow are in host-credentials.test.ts and the host-doors route test; the relays
 * and pushes in tests/providers/daemon-revoked-relay.test.ts; where each check sits in
 * revoked-reach-ratchet.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-revoked-ban-hardening'))
const hostOf = vi.hoisted(() => new Map<string, string>())
const hostReads = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../../src/core/session-db.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/session-db.js')>()),
  sessionJudgeInStore: (sid: string) => { hostReads.n++; return hostOf.has(sid) ? { host: hostOf.get(sid)!, judgedByHost: false } : null },
}))

const companion = vi.hoisted(() => ({ on: false }))
vi.mock('../../../src/integrations/git-sync.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/git-sync.js')>()),
  getCloudRemoteCredentialsAsync: async () => (companion.on ? { domain: 'companion.example.test', token: 'pair-token', secure: true } : null),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  HostRevokedError, hostRevokedNow, machineRevokedNow, revokedAs, revokedAsIn, setRevokedHostResolver, setRevokedHosts, stickyAliasesOf,
} from '../../../src/core/session-channel/revoked-hosts.js'
import { gateSessionCommand, REVOKED_PERSON_ONLY_COMMANDS, REVOKED_REFUSES_COMMANDS } from '../../../src/providers/ephemeral-session-gate.js'
import { asPersonCall } from '../../../src/core/session-channel/person-call.js'
import { classifyDeliveryFailure } from '../../../src/providers/delivery-failure.js'
import { planTransfer, TransferError } from '../../../src/core/transfer/planner.js'
import { enqueueMessage, getQueue, markNextProcessing, markProcessing, resetCache } from '../../../src/core/session-message-queue.js'
import { getBridgeConfigForHost, revokeBridgeTokens } from '../../../src/integrations/cloud-bridge-config.js'
import { exposePlacement } from '../../../src/core/expose/placement.js'
import type { SessionRecord, Task } from '../../../src/core/types.js'

const OWN = 'aa'.repeat(16)
const BOX = 'bb'.repeat(16)

afterEach(() => {
  setRevokedHosts([])
  setRevokedHostResolver(null)
  hostOf.clear()
})

describe('S1: the ban rests on the person\'s facts, not on what the host says later', () => {
  it('a key the ban named when it was made stays banned with no hello and no twin at all', () => {
    setRevokedHosts([{ hostKey: 'devbox-w', machineId: BOX, keys: ['devbox-x'] }])
    // Its daemon now says a new machine id on the alias's link, and no twin ties them.
    setRevokedHostResolver({ machineOf: (k) => (k === 'devbox-x' ? 'cc'.repeat(16) : null), aliasesOf: () => [] })
    expect(revokedAs('devbox-x')).toBe('devbox-w')
    expect(revokedAsIn([{ hostKey: 'devbox-w', keys: ['devbox-x'] }], 'devbox-x')).toBe('devbox-w')
    expect(() => { throw new HostRevokedError('devbox-x', 'x', 'devbox-w') }).toThrow(/POST \/api\/host-doors\/devbox-w\/allow/)
    expect(revokedAs('devbox-z')).toBeNull()
  })

  it('a key once judged an alias (a link to the same daemon) keeps the ban when its twin or machine id changes, until the ban goes', () => {
    setRevokedHosts([{ hostKey: 'devbox-w', machineId: BOX }])
    let twin = true
    setRevokedHostResolver({ machineOf: () => null, aliasesOf: (k) => (k === 'devbox-x' && twin ? ['devbox-w'] : []) })
    expect(revokedAs('devbox-x')).toBe('devbox-w')
    expect(stickyAliasesOf('devbox-w')).toEqual(['devbox-x'])
    twin = false
    expect(hostRevokedNow('devbox-x')).toBe(true)
    // The allow drops it with the ban, and says so.
    expect(setRevokedHosts([])).toEqual(expect.arrayContaining(['devbox-w', 'devbox-x']))
    expect(hostRevokedNow('devbox-x')).toBe(false)
    expect(stickyAliasesOf('devbox-w')).toEqual([])
  })

  it('a key matched only by the machine id its hello claims is banned while it says so, and never made part of the ban (R2-S1)', () => {
    setRevokedHosts([{ hostKey: 'devbox-w', machineId: BOX }])
    let says: string | null = BOX
    setRevokedHostResolver({ machineOf: (k) => (k === 'devbox-copy' ? says : null), aliasesOf: () => [] })
    expect(revokedAs('devbox-copy')).toBe('devbox-w')
    expect(stickyAliasesOf('devbox-w')).toEqual([])
    says = 'dd'.repeat(16)
    expect(hostRevokedNow('devbox-copy')).toBe(false)
  })
})

describe('N1: this leader\'s own machine and __local__ are never banned', () => {
  it('a ban record carrying the leader\'s own machine id bans no other key by it', () => {
    setRevokedHostResolver({ machineOf: () => OWN, aliasesOf: () => [], ownMachine: () => OWN })
    setRevokedHosts([{ hostKey: 'copied-home', machineId: OWN, keys: ['__local__'] }])
    expect(machineRevokedNow(OWN)).toBe(false)
    expect(revokedAs('devbox')).toBeNull()
    expect(revokedAs('__local__')).toBeNull()
    expect(revokedAs('copied-home')).toBe('copied-home')
  })
})

describe('N4: a ban reports a machine id that came or went under the same key', () => {
  it('names the record\'s key', () => {
    expect(setRevokedHosts([{ hostKey: 'devbox' }])).toEqual(['devbox'])
    expect(setRevokedHosts([{ hostKey: 'devbox', machineId: BOX }])).toEqual(['devbox'])
    expect(setRevokedHosts([{ hostKey: 'devbox', machineId: BOX }])).toEqual([])
    expect(setRevokedHosts([{ hostKey: 'devbox' }])).toEqual(['devbox'])
  })
})

describe('S2: a revoked host is handed no credential and carries none of this Walnut\'s traffic', () => {
  it('its bridge config is the turned-off one: no machine token is minted or read for it', async () => {
    setRevokedHosts(['devbox'])
    expect(await getBridgeConfigForHost('devbox')).toEqual({ enabled: false })
  })

  it('its machine tokens are deleted at the companion under every name the ban covers; one not answered is said as failed (R2-S2)', async () => {
    companion.on = true
    const asked: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      asked.push(`${init?.method} ${String(url)}`)
      if (String(url).endsWith('bridge-devbox-down')) throw new Error('unreachable')
      return new Response(null, { status: String(url).endsWith('bridge-devbox-x') ? 404 : 200 })
    })
    try {
      const out = await revokeBridgeTokens(['devbox-w', 'devbox-x', 'devbox-down', '__local__', 'devbox-w'])
      expect(out.revoked.sort()).toEqual(['devbox-w', 'devbox-x'])
      expect(out.failed).toEqual(['devbox-down'])
      expect(asked.sort()).toEqual([
        'DELETE https://companion.example.test/api/devices/bridge-devbox-down',
        'DELETE https://companion.example.test/api/devices/bridge-devbox-w',
        'DELETE https://companion.example.test/api/devices/bridge-devbox-x',
      ])
      // No companion: nothing to delete, nothing failed.
      companion.on = false
      expect(await revokeBridgeTokens(['devbox-w'])).toEqual({ revoked: [], failed: [] })
    } finally { fetchMock.mockRestore(); companion.on = false }
  })

  it('the tunnel chosen there, or placed there by itself, runs here again', () => {
    const hosts = { devbox: { hostname: 'devbox-a.example.test' }, other: { hostname: 'other.example.test' } }
    const def = { id: 'tunnel-x', alwaysOnHostPattern: '^devbox' } as never
    expect(exposePlacement('devbox', def, hosts as never)).toMatchObject({ where: 'host', hostKey: 'devbox' })
    expect(exposePlacement('', def, hosts as never)).toMatchObject({ where: 'host', hostKey: 'devbox', auto: true })
    setRevokedHosts(['devbox'])
    expect(exposePlacement('devbox', def, hosts as never)).toEqual({ where: 'here', auto: false })
    expect(exposePlacement('', def, hosts as never)).toEqual({ where: 'here', auto: true })
  })
})

describe('S3: no new process starts on a revoked host, and no work moves there', () => {
  it('the command gate refuses every spawn command for every caller, before it is sent; reads and input pass', () => {
    setRevokedHosts(['devbox'])
    for (const cmd of REVOKED_REFUSES_COMMANDS) {
      expect(() => gateSessionCommand({ host: 'devbox' }, cmd, { sid: 'eeeeeeee-7777-4777-8777-777777777778' }, false), cmd).toThrow(HostRevokedError)
    }
    expect(() => gateSessionCommand({ host: 'devbox' }, 'start', {}, false)).toThrow(/start refused, nothing ran: the host devbox is revoked/)
    for (const cmd of ['send', 'stop', 'fs.read']) expect(() => gateSessionCommand({ host: 'devbox' }, cmd, {}, false), cmd).not.toThrow()
    // Another host, and the leader's own machine, start as before.
    expect(() => gateSessionCommand({ host: 'other' }, 'start', {}, false)).not.toThrow()
    expect(() => gateSessionCommand({ host: '__local__' }, 'start', {}, false)).not.toThrow()
  })

  it('a process or a write there, and a tool allowed there, go only for a person\'s own call (R2-S3)', () => {
    setRevokedHosts(['devbox'])
    for (const cmd of REVOKED_PERSON_ONLY_COMMANDS) {
      expect(() => gateSessionCommand({ host: 'devbox' }, cmd, {}, false), cmd).toThrow(/there only a person's own call runs it, nothing ran/)
      expect(() => asPersonCall(() => gateSessionCommand({ host: 'devbox' }, cmd, {}, false)), cmd).not.toThrow()
    }
    const answer = (behavior: string) => ({ sid: 's-1', raw: JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior } } }) })
    expect(() => gateSessionCommand({ host: 'devbox' }, 'sendRaw', answer('allow'), false)).toThrow(HostRevokedError)
    expect(() => gateSessionCommand({ host: 'devbox' }, 'sendRaw', answer('deny'), false)).not.toThrow()
    expect(() => asPersonCall(() => gateSessionCommand({ host: 'devbox' }, 'sendRaw', answer('allow'), false))).not.toThrow()
    // Reads, and the same commands to a host not revoked, go as before.
    expect(() => gateSessionCommand({ host: 'devbox' }, 'fs.read', {}, false)).not.toThrow()
    expect(() => gateSessionCommand({ host: 'other' }, 'exec.run', {}, false)).not.toThrow()
  })

  it('a transfer to it is refused in its plan, before anything is packed', () => {
    setRevokedHosts(['devbox'])
    const task = { id: 't-1', cwd: '/w' } as Task
    const session = { claudeSessionId: 's-1', host: null, cwd: '/w', engine: 'claude' } as unknown as SessionRecord
    let err: unknown
    try { planTransfer(task, session, { taskId: 't-1', host: 'devbox' }, new Set(['devbox'])) } catch (e) { err = e }
    expect(err).toBeInstanceOf(TransferError)
    expect(err).toMatchObject({ status: 403, code: 'host_revoked' })
    expect(() => planTransfer(task, session, { taskId: 't-1', host: 'other' }, new Set(['other']))).not.toThrow()
  })
})

describe('S4: only a person\'s own lines reach a session running on a revoked host', () => {
  beforeEach(async () => {
    hostReads.n = 0
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
    await fsp.mkdir(WALNUT_HOME, { recursive: true })
    resetCache()
  })

  it('parks every automated row with why, on both funnels, and hands out the person\'s', async () => {
    hostOf.set('s-revoked', 'devbox')
    hostOf.set('s-fine', 'other')
    await enqueueMessage('s-revoked', 'from a peer', { sentBy: 'agent' })
    await enqueueMessage('s-revoked', 'a legacy row with no sender')
    await enqueueMessage('s-fine', 'from a peer elsewhere', { sentBy: 'agent' })
    setRevokedHosts(['devbox'])
    expect(await markNextProcessing('s-revoked')).toEqual([])
    const parked = await getQueue('s-revoked')
    expect(parked.map((m) => m.status)).toEqual(['parked', 'parked'])
    expect(parked[0]!.parkedReason).toMatch(/Not sent: the host devbox is revoked; only your own messages reach a session already running there/)
    await enqueueMessage('s-revoked', 'the person typed this', { sentBy: 'person' })
    await enqueueMessage('s-revoked', 'a routine', { sentBy: 'agent' })
    expect((await markProcessing('s-revoked')).map((m) => m.message)).toEqual(['the person typed this'])
    expect((await getQueue('s-revoked')).find((m) => m.message === 'a routine')!.status).toBe('parked')
    // Another host's session, and the same rows with no ban, go as before.
    expect((await markProcessing('s-fine')).map((m) => m.message)).toEqual(['from a peer elsewhere'])
    // Each session's host was read from its row once, not at every hand-out (R2-N4).
    expect(hostReads.n).toBe(2)
  })

  it('a refused spawn (a cold --resume there) is a permanent delivery failure, parked with why', () => {
    const v = classifyDeliveryFailure(new HostRevokedError('devbox', 'start refused, nothing ran'))
    expect(v).toMatchObject({ kind: 'permanent', code: 'host_revoked' })
    expect(v.reason).toMatch(/^Not sent: start refused, nothing ran: the host devbox is revoked/)
  })
})
