/**
 * The old leader's host steps of a switch (src/core/leader/switch/host-follow.ts), each on its own:
 *
 *   prepareOldMachineAsHost   the credential record in auth.json (leader data: the final batch carries
 *                             it) and the host side on this machine's disk, behind the outward door
 *                             'host-credential'; nothing minted for bad doors, another machine, or a
 *                             machine that may not act; a refused host side takes the record back
 *   pushNewLeaderDoors        refuses doors no host may dial; with no leader side on, tells nobody
 *   announceSwitchStop        the restart notice says the commit window, capped at 5 minutes (the live
 *                             proof that it reaches the companion is the companion-follow e2e)
 *   configureOldMachineHostService / removeSwitchHostService / dropOwnDaemonDuties
 *                             against a REAL daemon twin over the link a server has (leader.configure
 *                             first): the daemon runs the ordinary host replica spec and its program
 *                             sees the replica's environment; the lead boot takes it back (a rollback,
 *                             and a home a switch promoted), and a home that took no part in a switch
 *                             is left alone; the trigger set and the bridge are dropped on the daemon,
 *                             and this process stops pushing its own bridge
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-host-follow'))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../../src/core/device-auth.js'
import { setMachineIdHomeForTest } from '../../../../src/core/machine-id.js'
import { classifyHomePath } from '../../../../src/core/home-manifest/index.js'
import { hostCredentialOf } from '../../../../src/core/session-channel/host-credentials.js'
import { readHostCredential } from '../../../../src/core/session-channel/host-credential-file.js'
import { setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { ownBridgeHeld, holdOwnBridge } from '../../../../src/core/leader/own-bridge-hold.js'
import { setRestartNotice, startLeaderHeartbeat } from '../../../../src/core/leader/primary-leader.js'
import {
  announceSwitchStop, configureOldMachineHostService, dropOwnDaemonDuties, hostServiceRecordFile, oldMachineHostServiceSpec,
  prepareOldMachineAsHost, pushNewLeaderDoors, removeSwitchHostService, restoreOwnDaemonDuties, undoHandoverHostSteps, withdrawSwitchStop, type OwnDaemon,
} from '../../../../src/core/leader/switch/host-follow.js'
import { promotedFile } from '../../../../src/core/leader/switch/records.js'
import { bootStandbyTwin, type StandbyTwin } from '../../standby/twin-link.js'
import { testBun } from '../../../helpers/bun-runtime.js'

const MACHINE = 'old-mac-0001'
const WALNUT = 'feedbeef'.repeat(4)
const DOORS = ['wss://new-leader.example.invalid/host-door', 'ws://127.0.0.1:47123/host-door']
let account = ''

beforeEach(() => {
  _resetDeviceAuthForTesting()
  fs.rmSync(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  fs.rmSync(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  account = fs.mkdtempSync(path.join(os.tmpdir(), 'host-follow-acct-'))
  setMachineIdHomeForTest(account)
})
afterEach(() => {
  setOutwardDoorChecker(null)
  setMachineIdHomeForTest(null)
  holdOwnBridge(false)
  setRestartNotice(null)
  fs.rmSync(account, { recursive: true, force: true })
})

const input = (over: Partial<Parameters<typeof prepareOldMachineAsHost>[0]> = {}) => ({
  walnutId: WALNUT, machineId: MACHINE, hostKey: 'mac', doors: DOORS, standing: { permitNumber: 4, epoch: 0 }, thisMachine: async () => MACHINE, ...over,
})

describe('prepareOldMachineAsHost', () => {
  it('mints the record into auth.json (leader data) and keeps the host side on this machine', async () => {
    const r = await prepareOldMachineAsHost(input())
    expect(r.ok).toBe(true)
    const rec = await hostCredentialOf(MACHINE)
    expect(rec).toMatchObject({ hostKey: 'mac', walnutId: WALNUT })
    // auth.json travels with the home: the final batch carries the record to the new leader.
    expect(classifyHomePath('auth.json')?.class).toBe('leader-data')
    const held = await readHostCredential(WALNUT)
    expect(held).toMatchObject({ walnutId: WALNUT, machineId: MACHINE, doors: DOORS, permit: { permitNumber: 4, epoch: 0 } })
    expect(held!.verifyKey).toBe(rec!.verifyKey)
    // The host side is machine data, beside the machine id, never in the home.
    expect(fs.existsSync(path.join(account, '.local', 'state', 'open-walnut', 'host-credentials', `${WALNUT}.json`))).toBe(true)
    // Asked again (a resumed switch): a new key, the old one kept as the record's previous.
    expect((await prepareOldMachineAsHost(input())).ok).toBe(true)
    const again = await hostCredentialOf(MACHINE)
    expect(again!.verifyKey).not.toBe(rec!.verifyKey)
    expect((await readHostCredential(WALNUT))!.verifyKey).toBe(again!.verifyKey)
  })

  it('passes the outward door: a machine that may not act mints nothing', async () => {
    const asked: string[] = []
    setOutwardDoorChecker((kind, opId) => { asked.push(`${kind} ${opId}`); throw Object.assign(new Error('this machine does not hold the write permission'), { name: 'PermitNotHeld' }) }, () => false)
    const r = await prepareOldMachineAsHost(input())
    expect(r).toEqual({ ok: false, why: 'this machine does not hold the write permission' })
    expect(asked).toEqual([`host-credential host-credential:${MACHINE}`])
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(await readHostCredential(WALNUT)).toBeNull()
  })

  it('refuses doors no host may dial and another machine\'s credential, before anything is minted', async () => {
    expect((await prepareOldMachineAsHost(input({ doors: ['http://plain.example.invalid/host-door'] }))).ok).toBe(false)
    expect((await prepareOldMachineAsHost(input({ doors: [] }))).ok).toBe(false)
    expect((await prepareOldMachineAsHost(input({ machineId: 'another-machine' }))).ok).toBe(false)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(await hostCredentialOf('another-machine')).toBeNull()
  })

  it('a host side refused (it holds a newer standing) takes the record back: nothing half made travels', async () => {
    expect((await prepareOldMachineAsHost(input({ standing: { permitNumber: 9, epoch: 0 } }))).ok).toBe(true)
    const r = await prepareOldMachineAsHost(input({ standing: { permitNumber: 2, epoch: 0 } }))
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.why).toMatch(/stale_permit/)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
  })
})

describe('pushNewLeaderDoors and announceSwitchStop', () => {
  it('refuses doors no host may dial; with no leader side on it tells nobody', async () => {
    expect(await pushNewLeaderDoors(['http://x.example.invalid/host-door'])).toEqual({ ok: false, why: 'no door a host may dial' })
    expect(await pushNewLeaderDoors(DOORS)).toEqual({ ok: true, dialed: [], routed: [], failed: [] })
  })

  it('a rollback with no restart ends the bridge hold and pushes the trigger set and the bridge again', async () => {
    holdOwnBridge(true)
    const calls: string[] = []
    const r = await restoreOwnDaemonDuties({ daemon: { recheckTriggers: () => { calls.push('triggers') }, pushBridgeConfig: () => { calls.push(`bridge held=${ownBridgeHeld()}`) } } })
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual(['triggers', 'bridge held=false'])
  })

  it('the restart notice says the commit window, capped at 5 minutes, and is sent at once; a withdrawn one says the grace again', async () => {
    // No bridge in this process: the send answers false at once, the value is what the notice would say.
    expect(await announceSwitchStop(90_000, { maxWaitMs: 50 })).toBe(90_000)
    expect(await announceSwitchStop(300_000, { maxWaitMs: 50 })).toBe(300_000)
    expect(await announceSwitchStop(900_000, { maxWaitMs: 50 })).toBe(300_000)
    expect(await announceSwitchStop(0, { maxWaitMs: 50 })).toBeNull()
    expect(setRestartNotice(60_000)).toBe(60_000)
    ;(await withdrawSwitchStop()).stop()
    expect(setRestartNotice(null)).toBeNull()
  })
})

const BUN = testBun()

describe.skipIf(!BUN)('this machine\'s own daemon (a real daemon twin)', () => {
  let dir = ''
  let twin: StandbyTwin
  let home = ''
  let daemon: OwnDaemon

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-follow-twin-'))
    twin = await bootStandbyTwin(dir, BUN!)
  }, 90_000)
  afterAll(async () => {
    await twin?.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(dir, 'leader-home-'))
    // A new socket per home: a server's socket speaks for one home.
    twin.drop()
    await new Promise((r) => setTimeout(r, 50))
    const link = await twin.connect()
    daemon = { send: (cmd, payload, timeoutMs) => link.send(cmd, payload, timeoutMs) as Promise<Record<string, unknown>> }
    // As the server's link does: this socket speaks for its home first.
    const c = await daemon.send('leader.configure', { home, walnutId: WALNUT, backup: false }, 10_000)
    expect(c.ok, String(c.error ?? '')).toBe(true)
  })

  /** A program that writes its environment and arguments, then waits (it stands for `walnut web --replica`). */
  function program(out: string) {
    return { command: '/bin/sh', prefix: ['-c', `env > ${out}; echo "$@" > ${out}.args; exec sleep 600`, 'walnut'] }
  }

  it('runs the ordinary host replica spec, and this home\'s lead boot takes it back (a rollback)', async () => {
    const out = path.join(dir, `env-${path.basename(home)}`)
    const dirs = { dataDir: path.join(dir, 'svc', 'data'), logFile: path.join(dir, 'svc', 'logs', 'server.log'), runDir: path.join(dir, 'svc', 'run') }
    const spec = await oldMachineHostServiceSpec({ home, walnutId: WALNUT, hostKey: 'mac', port: 41_234, dirs, program: program(out) })
    // The shape the host-server manager sends any host (replica-run.ts).
    expect(spec).toMatchObject({ v: 1, home, walnutId: WALNUT, command: '/bin/sh', cwd: dirs.dataDir, log: dirs.logFile, port: 41_234 })
    expect((spec.args as string[]).slice(-2)).toEqual(['web', '--replica'])
    expect((spec.fallback as { args: string[] }).args.slice(-1)).toEqual(['host-server'])
    const r = await configureOldMachineHostService({ daemon, home, walnutId: WALNUT, hostKey: 'mac', port: 41_234, dirs, program: program(out), switchId: 'sw-1' })
    expect(r.ok, r.ok ? '' : r.why).toBe(true)
    expect(JSON.parse(fs.readFileSync(hostServiceRecordFile(home), 'utf8'))).toMatchObject({ v: 1, home, walnutId: WALNUT, hostKey: 'mac', switchId: 'sw-1' })
    expect(classifyHomePath('local/leader-switch/host-service.json')?.class).toBe('machine')
    // The shell opens the file before env has written it: wait for its words and for the args file.
    await vi.waitFor(() => { expect(fs.existsSync(out) && fs.readFileSync(out, 'utf8')).toMatch(/WALNUT_ROLE=/); expect(fs.existsSync(`${out}.args`) && fs.readFileSync(`${out}.args`, 'utf8')).toMatch(/replica/) }, { timeout: 20_000 })
    const env = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    expect(env).toMatchObject({
      WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: 'mac', WALNUT_WALNUT_ID: WALNUT, WALNUT_LEADER_HOME: home,
      OPEN_WALNUT_HOME: dirs.dataDir, WALNUT_HOST_SERVER_PORT: '41234', WALNUT_HOST_SERVER: '1',
    })
    expect(fs.readFileSync(`${out}.args`, 'utf8').trim()).toBe('web --replica')
    const st = await daemon.send('server.status', { home }, 10_000)
    expect((st.status as { state: string }).state).not.toBe('off')
    // The rollback: this home boots as the leader again.
    const back = await removeSwitchHostService({ daemon, home })
    expect(back).toEqual({ ok: true, removed: true })
    expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).toBe('off')
    expect(fs.existsSync(hostServiceRecordFile(home))).toBe(false)
    // Again: nothing to take back.
    expect(await removeSwitchHostService({ daemon, home })).toEqual({ ok: true, removed: false })
  }, 60_000)

  it('a home a switch promoted takes back a host service an earlier leader left; a home that took no part in a switch is left alone', async () => {
    const out = path.join(dir, `env-${path.basename(home)}`)
    const dirs = { dataDir: path.join(dir, 'svc2', 'data'), logFile: path.join(dir, 'svc2', 'logs', 'server.log'), runDir: path.join(dir, 'svc2', 'run') }
    const spec = await oldMachineHostServiceSpec({ home, walnutId: WALNUT, hostKey: 'mac', port: 41_235, dirs, program: program(out) })
    // Another leader's manager configured it (no record beside this home).
    expect((await daemon.send('server.configure', { home, spec }, 15_000)).ok).toBe(true)
    expect(await removeSwitchHostService({ daemon, home })).toEqual({ ok: true, removed: false })
    expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).not.toBe('off')
    // This home was promoted by a switch (a switch back): the earlier leader's host service goes.
    fs.mkdirSync(path.dirname(promotedFile(home)), { recursive: true })
    fs.writeFileSync(promotedFile(home), JSON.stringify({ state: 'led' }))
    expect(await removeSwitchHostService({ daemon, home })).toEqual({ ok: true, removed: true })
    expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).toBe('off')
  }, 60_000)

  it('a handover that did not happen, while the server runs on: the host service, the credential, the hold and the notice are all taken back', async () => {
    const out = path.join(dir, `env-${path.basename(home)}`)
    const dirs = { dataDir: path.join(dir, 'svc3', 'data'), logFile: path.join(dir, 'svc3', 'logs', 'server.log'), runDir: path.join(dir, 'svc3', 'run') }
    expect((await prepareOldMachineAsHost(input())).ok).toBe(true)
    expect((await configureOldMachineHostService({ daemon, home, walnutId: WALNUT, hostKey: 'mac', port: 41_236, dirs, program: program(out) })).ok).toBe(true)
    holdOwnBridge(true)
    setRestartNotice(60_000)
    const pushed: string[] = []
    const r = await undoHandoverHostSteps({
      home, walnutId: WALNUT, machineId: MACHINE,
      daemon: { send: daemon.send, recheckTriggers: () => { pushed.push('triggers') }, pushBridgeConfig: () => { pushed.push('bridge') } },
    })
    startLeaderHeartbeat().stop()
    expect(r).toEqual({ ok: true, hostService: true, credential: true })
    expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).toBe('off')
    expect(fs.existsSync(hostServiceRecordFile(home))).toBe(false)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(await readHostCredential(WALNUT)).toBeNull()
    expect(ownBridgeHeld()).toBe(false)
    expect(pushed).toEqual(['triggers', 'bridge'])
    expect(setRestartNotice(null)).toBeNull()
  }, 60_000)

  it('drops the trigger set and the bridge on the daemon, and this process stops pushing its own bridge', async () => {
    const set = { version: 1, triggers: [{ id: 'mfollow1-0001', name: 'Watch', everyMs: 3_600_000, check: { run: 'true', timeoutSeconds: 10 } }] }
    const armed = await daemon.send('triggers.configure', { home, config: set }, 20_000)
    expect(armed).toMatchObject({ ok: true, count: 1 })
    expect((await daemon.send('bridge.configure', { home, enabled: true, url: 'ws://127.0.0.1:9/bridge', token: 't'.repeat(32), hostAlias: 'mac' }, 20_000)).ok).toBe(true)
    expect(ownBridgeHeld()).toBe(false)
    const r = await dropOwnDaemonDuties({ daemon, home })
    expect(r).toEqual({ ok: true, triggers: true, bridge: true })
    expect(ownBridgeHeld()).toBe(true)
    // The set is empty now: arming the same empty set again changes nothing.
    expect(await daemon.send('triggers.configure', { home, config: { version: 1, triggers: [] } }, 20_000)).toMatchObject({ ok: true, count: 0, changed: false })
    // The bridge the daemon keeps for this home is off (bridge.json, as a daemon restart reads it).
    const files = walk(path.join(dir, 'daemon')).filter((f) => f.endsWith('bridge.json')).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as { enabled: boolean; home?: string })
    const mine = files.find((f) => f.home === home)
    expect(mine).toMatchObject({ enabled: false })
  }, 60_000)
})

function walk(d: string): string[] {
  const out: string[] = []
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
