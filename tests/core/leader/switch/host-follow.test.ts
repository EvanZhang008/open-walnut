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
 *   takeBackSwitchLeftovers   a crash after prepare and configure, then a restart that boots waiting
 *                             for the witnesses and leads later: at that first lead the host service,
 *                             this machine's credential record and its host side are all gone
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-host-follow'))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../../src/core/device-auth.js'
import { readMachineId, setMachineIdHomeForTest } from '../../../../src/core/machine-id.js'
import { classifyHomePath } from '../../../../src/core/home-manifest/index.js'
import { hostCredentialOf } from '../../../../src/core/session-channel/host-credentials.js'
import { readHostCredential } from '../../../../src/core/session-channel/host-credential-file.js'
import { setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { ownBridgeHeld, holdOwnBridge } from '../../../../src/core/leader/own-bridge-hold.js'
import { leaderHeartbeatRunning, setRestartNotice, startLeaderHeartbeat } from '../../../../src/core/leader/primary-leader.js'
import {
  announceSwitchStop, configureOldMachineHostService, dropOwnDaemonDuties, hostServiceRecordFile, oldMachineHostDirs, oldMachineHostServiceSpec,
  prepareOldMachineAsHost, pushNewLeaderDoors, removeSwitchHostService, restoreOwnDaemonDuties, takeBackSwitchLeftovers, undoHandoverHostSteps, withdrawSwitchStop, type OwnDaemon,
} from '../../../../src/core/leader/switch/host-follow.js'
import { promotedFile } from '../../../../src/core/leader/switch/records.js'
import { leaderPermitAtBoot } from '../../../../src/core/leader/switch/boot.js'
import { forgetLocalWitnesses, setUpLocalWitnesses } from '../../../../src/core/leader/switch/local-witnesses.js'
import type { PermitRuntime } from '../../../../src/core/leader/switch/runtime.js'
import { getInstanceId } from '../../../../src/core/device-store.js'
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
    // No heartbeat ran when the notice went: the withdrawal starts none.
    expect(await withdrawSwitchStop()).toMatchObject({ restarted: false })
    expect(leaderHeartbeatRunning()).toBe(false)
    expect(setRestartNotice(null)).toBeNull()
  })

  it('a withdrawn notice starts again the heartbeats the notice stopped, and only those', async () => {
    const beating = startLeaderHeartbeat()
    try {
      expect(leaderHeartbeatRunning()).toBe(true)
      expect(await announceSwitchStop(60_000, { maxWaitMs: 50 })).toBe(60_000)
      expect(leaderHeartbeatRunning()).toBe(false)
      expect(await withdrawSwitchStop()).toMatchObject({ restarted: true })
      expect(leaderHeartbeatRunning()).toBe(true)
      // Withdrawn again: nothing more to start.
      expect(await withdrawSwitchStop()).toMatchObject({ restarted: false })
    } finally { beating.stop() }
    expect(leaderHeartbeatRunning()).toBe(false)
  })
})

describe('the host service\'s dirs and its take-back, without a daemon', () => {
  afterEach(() => { delete process.env.WALNUT_HOST_SERVER_ROOT })

  it('picks the dirs as the host-server manager does: its own under the root, the shared ones only while this Walnut marked them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-follow-root-'))
    try {
      process.env.WALNUT_HOST_SERVER_ROOT = root
      const own = { dataDir: `${root}/walnuts/${WALNUT.slice(0, 16)}/data`, logFile: `${root}/walnuts/${WALNUT.slice(0, 16)}/logs/server.log`, runDir: `${root}/walnuts/${WALNUT.slice(0, 16)}/run` }
      expect(await oldMachineHostDirs(WALNUT)).toEqual(own)
      // The shared data dir from before the split, marked by another Walnut: not this one's.
      fs.mkdirSync(path.join(root, 'data'), { recursive: true })
      fs.writeFileSync(path.join(root, 'data', '.walnut-id'), 'another-walnut')
      expect(await oldMachineHostDirs(WALNUT)).toEqual(own)
      // Marked by this Walnut (with the newline a shell's printf or echo may leave): it runs there, as the manager would keep it there.
      fs.writeFileSync(path.join(root, 'data', '.walnut-id'), `${WALNUT}\n`)
      expect(await oldMachineHostDirs(WALNUT)).toEqual({ dataDir: `${root}/data`, logFile: `${root}/logs/server.log`, runDir: `${root}/run` })
      // Read only: nothing is marked where there was no mark.
      fs.rmSync(path.join(root, 'data', '.walnut-id'))
      await oldMachineHostDirs(WALNUT)
      expect(fs.existsSync(path.join(root, 'data', '.walnut-id'))).toBe(false)
      // With no root set: under the home's .open-walnut-host, as HOST_ROOT says.
      delete process.env.WALNUT_HOST_SERVER_ROOT
      expect((await oldMachineHostDirs(WALNUT)).dataDir).toBe(path.join(os.homedir(), '.open-walnut-host', 'walnuts', WALNUT.slice(0, 16), 'data'))
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('the first lead takes back this machine\'s credential wherever it is, with no switch folder beside the home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-follow-cred-'))
    try {
      expect((await prepareOldMachineAsHost(input())).ok).toBe(true)
      expect(fs.existsSync(path.join(home, 'local', 'leader-switch'))).toBe(false)
      const sent: string[] = []
      const daemon: OwnDaemon = { send: async (cmd) => { sent.push(cmd); return { ok: true } } }
      const r = await takeBackSwitchLeftovers({ home, machine: 'machine-a', daemon, machineId: async () => MACHINE, walnutId: async () => WALNUT })
      expect(r).toEqual({ ok: true, console: false, hostService: false, credential: true, credentialFile: true })
      expect(await hostCredentialOf(MACHINE)).toBeNull()
      expect(await readHostCredential(WALNUT)).toBeNull()
      // Nothing of a host service here (no record, no promotion): its daemon is not asked.
      expect(sent).toEqual([])
      // Again: nothing left to take back.
      expect(await takeBackSwitchLeftovers({ home, machine: 'machine-a', daemon, machineId: async () => MACHINE, walnutId: async () => WALNUT })).toEqual({ ok: true, console: false, hostService: false, credential: false, credentialFile: false })
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  it('a spec adopted and not started yet (its status reads off) is still removed: nothing is left behind the record', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'host-follow-off-'))
    try {
      fs.mkdirSync(path.dirname(hostServiceRecordFile(home)), { recursive: true })
      fs.writeFileSync(hostServiceRecordFile(home), '{}')
      const sent: Array<[string, Record<string, unknown>]> = []
      const daemon: OwnDaemon = { send: async (cmd, payload) => { sent.push([cmd, payload]); return cmd === 'server.status' ? { ok: true, status: { state: 'off', since: 0, restarts: 0 } } : { ok: true } } }
      expect(await removeSwitchHostService({ daemon, home })).toEqual({ ok: true, removed: false })
      expect(sent).toEqual([['server.status', { home }], ['server.configure', { home, spec: null }]])
      expect(fs.existsSync(hostServiceRecordFile(home))).toBe(false)
      // A daemon that does not answer the status: the record stays for the next try.
      fs.writeFileSync(hostServiceRecordFile(home), '{}')
      const mute: OwnDaemon = { send: async () => ({ ok: false, error: 'busy' }) }
      expect((await removeSwitchHostService({ daemon: mute, home })).ok).toBe(false)
      expect(fs.existsSync(hostServiceRecordFile(home))).toBe(true)
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
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
    // No notice went out (announceSwitchStop never ran): the undo starts no heartbeat.
    expect(leaderHeartbeatRunning()).toBe(false)
    expect(r).toEqual({ ok: true, hostService: true, credential: true })
    expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).toBe('off')
    expect(fs.existsSync(hostServiceRecordFile(home))).toBe(false)
    expect(await hostCredentialOf(MACHINE)).toBeNull()
    expect(await readHostCredential(WALNUT)).toBeNull()
    expect(ownBridgeHeld()).toBe(false)
    expect(pushed).toEqual(['triggers', 'bridge'])
    expect(setRestartNotice(null)).toBeNull()
  }, 60_000)

  it('a crash after prepare and configure, then a boot that waits for the witnesses and leads later: its first lead takes all three back', async () => {
    // This Walnut's own id (the take-back reads it as the server does): the socket speaks for it.
    const walnutId = await getInstanceId()
    twin.drop()
    const link = await twin.connect()
    daemon = { send: (cmd, payload, timeoutMs) => link.send(cmd, payload, timeoutMs) as Promise<Record<string, unknown>> }
    expect((await daemon.send('leader.configure', { home, walnutId, backup: false }, 10_000)).ok).toBe(true)
    const out = path.join(dir, `env-${path.basename(home)}`)
    const dirs = { dataDir: path.join(dir, 'svc4', 'data'), logFile: path.join(dir, 'svc4', 'logs', 'server.log'), runDir: path.join(dir, 'svc4', 'run') }
    // The old leader's steps before the handover record, then a crash (nothing undone).
    // And this machine's own id, as the take-back reads it (machine-id.ts, under this test's account).
    const machineId = await readMachineId()
    const prepared = await prepareOldMachineAsHost(input({ walnutId, machineId, thisMachine: async () => machineId }))
    expect(prepared.ok, prepared.ok ? '' : prepared.why).toBe(true)
    const configured = await configureOldMachineHostService({ daemon, home, walnutId, hostKey: 'mac', port: 41_237, dirs, program: program(out) })
    expect(configured.ok, configured.ok ? '' : configured.why).toBe(true)
    expect(await hostCredentialOf(machineId)).not.toBeNull()
    expect(await readHostCredential(walnutId)).not.toBeNull()
    // The restart: this home's config names three witness dirs, two of them gone for now.
    const sw = path.join(dir, `switch-${path.basename(home)}`)
    const witnesses = ['w1', 'w2', 'w3'].map((id) => ({ id, dir: path.join(sw, 'witnesses', id) }))
    setUpLocalWitnesses(witnesses)
    const idFile = path.join(sw, 'machine-a.id')
    fs.writeFileSync(idFile, 'machine-a\n')
    fs.writeFileSync(path.join(home, 'config.yaml'), [
      'experimental:', '  switchable_leader: true', 'leader_switch:', '  witnesses:',
      ...witnesses.map((w) => `    - { id: ${w.id}, dir: ${w.dir} }`),
      '  machines:',
      `    - { id: machine-a, home: ${home}, standby_dir: ${path.join(sw, 'a-standby')}, port: 4911 }`,
      `    - { id: machine-b, home: ${path.join(sw, 'b-home')}, standby_dir: ${path.join(sw, 'b-standby')}, port: 4912 }`,
      '',
    ].join('\n'))
    for (const w of witnesses.slice(0, 2)) fs.renameSync(w.dir, `${w.dir}.off`)
    let rt: PermitRuntime | null = null
    try {
      rt = await leaderPermitAtBoot({ home, flagOn: true, isLeaderRole: true, ephemeral: false, env: { WALNUT_MACHINE_ID_FILE: idFile }, ownDaemon: daemon })
      expect(rt?.decision.kind).toBe('waiting')
      // Waiting, it takes nothing back: it does not lead.
      expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).not.toBe('off')
      expect(fs.existsSync(hostServiceRecordFile(home))).toBe(true)
      expect(await hostCredentialOf(machineId)).not.toBeNull()
      // The witnesses answer again: it leads, and its first lead takes the three back.
      for (const w of witnesses.slice(0, 2)) fs.renameSync(`${w.dir}.off`, w.dir)
      await vi.waitFor(() => expect(rt!.status().state).toBe('leading'), { timeout: 30_000, interval: 100 })
      await vi.waitFor(async () => {
        expect(((await daemon.send('server.status', { home }, 10_000)).status as { state: string }).state).toBe('off')
        expect(fs.existsSync(hostServiceRecordFile(home))).toBe(false)
        expect(await hostCredentialOf(machineId)).toBeNull()
        expect(await readHostCredential(walnutId)).toBeNull()
      }, { timeout: 20_000, interval: 100 })
    } finally {
      await rt?.stop()
      forgetLocalWitnesses()
    }
  }, 90_000)

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
